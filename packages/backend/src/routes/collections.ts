import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { ApiError } from '../utils/api-errors.js';
import {
  listCollections,
  getCollectionById,
  isGeneralCollection,
  countGeneralCollections,
  createCollection,
  updateCollection,
  deleteCollection,
} from '../services/collections.js';
import { getWorkspaceById } from '../services/workspaces.js';
import { listCards } from '../services/cards.js';
import { runCollectionAgentBatch } from '../services/collection-batch.js';

const agentBatchCardFiltersSchema = z.object({
  search: z.string().optional(),
  assigneeId: z.string().optional(),
  completed: z.boolean().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  tagId: z.string().optional(),
});

const agentBatchConfigSchema = z.object({
  agentId: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  maxParallel: z.number().int().min(1).max(20).optional(),
  cardFilters: agentBatchCardFiltersSchema.optional(),
});

const createCollectionBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
});

const updateCollectionBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  agentBatchConfig: agentBatchConfigSchema.nullable().optional(),
});

export async function collectionRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List collections
  typedApp.get(
    '/api/collections',
    {
      onRequest: [app.authenticate, requirePermission('collections:read')],
      schema: {
        tags: ['Collections'],
        summary: 'List collections',
        querystring: z.object({
          search: z.string().optional(),
          workspaceId: z.uuid().optional(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
          withCardCounts: z.coerce.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      let ids: string[] | undefined;
      if (request.query.workspaceId) {
        const workspace = await getWorkspaceById(request.query.workspaceId) as any;
        if (workspace) {
          ids = workspace.collectionIds;
        }
      }

      const { entries, total } = await listCollections({
        ids,
        search: request.query.search,
        limit: request.query.limit,
        offset: request.query.offset,
        withCardCounts: request.query.withCardCounts,
      });

      return reply.send({
        total,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  // Get single collection
  typedApp.get(
    '/api/collections/:id',
    {
      onRequest: [app.authenticate, requirePermission('collections:read')],
      schema: {
        tags: ['Collections'],
        summary: 'Get a single collection by ID',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) {
        return reply.notFound('Collection not found');
      }
      return reply.send(collection);
    },
  );

  // Get cards in collection
  typedApp.get(
    '/api/collections/:id/cards',
    {
      onRequest: [app.authenticate, requirePermission('cards:read')],
      schema: {
        tags: ['Collections'],
        summary: 'List cards in a collection',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          search: z.string().optional(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) {
        return reply.notFound('Collection not found');
      }

      const { entries, total } = await listCards({
        collectionId: request.params.id,
        search: request.query.search,
        limit: request.query.limit,
        offset: request.query.offset,
      });

      return reply.send({
        total,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  // Create collection
  typedApp.post(
    '/api/collections',
    {
      onRequest: [app.authenticate, requirePermission('collections:create')],
      schema: {
        tags: ['Collections'],
        summary: 'Create a new collection',
        body: createCollectionBody,
      },
    },
    async (request, reply) => {
      const collection = await createCollection(request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(201).send(collection);
    },
  );

  // Update collection
  typedApp.patch(
    '/api/collections/:id',
    {
      onRequest: [app.authenticate, requirePermission('collections:update')],
      schema: {
        tags: ['Collections'],
        summary: 'Update an existing collection',
        params: z.object({ id: z.uuid() }),
        body: updateCollectionBody,
      },
    },
    async (request, reply) => {
      const updated = await updateCollection(request.params.id, request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!updated) {
        return reply.notFound('Collection not found');
      }

      return reply.send(updated);
    },
  );

  // Trigger agent batch run on collection cards
  typedApp.post(
    '/api/collections/:id/agent-batch',
    {
      onRequest: [app.authenticate, requirePermission('cards:read')],
      schema: {
        tags: ['Collections'],
        summary: 'Run an agent on filtered cards in a collection',
        params: z.object({ id: z.uuid() }),
        body: z.object({
          agentId: z.string(),
          prompt: z.string().min(1).max(10000),
          maxParallel: z.number().int().min(1).max(20).optional(),
          cardFilters: agentBatchCardFiltersSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) {
        return reply.notFound('Collection not found');
      }

      const { agentId, prompt, maxParallel = 3, cardFilters = {} } = request.body;

      const result = await runCollectionAgentBatch({
        collectionId: request.params.id,
        agentId,
        prompt,
        maxParallel,
        cardFilters,
      });

      return reply.status(202).send(result);
    },
  );

  // Delete collection
  typedApp.delete(
    '/api/collections/:id',
    {
      onRequest: [app.authenticate, requirePermission('collections:delete')],
      schema: {
        tags: ['Collections'],
        summary: 'Delete a collection',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) {
        return reply.notFound('Collection not found');
      }

      if (isGeneralCollection(collection)) {
        const generalCount = await countGeneralCollections();
        if (generalCount <= 1) {
          throw ApiError.conflict(
            'general_collection_protected',
            'The last remaining general collection cannot be deleted',
            'Create and use another collection if you need to remove this one',
          );
        }
      }

      const deleted = await deleteCollection(request.params.id, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!deleted) {
        return reply.notFound('Collection not found');
      }

      return reply.status(204).send();
    },
  );
}
