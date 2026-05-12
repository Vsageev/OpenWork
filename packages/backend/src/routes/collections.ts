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
import {
  cancelAgentBatchRun,
  getAgentBatchRun,
  listAgentBatchRunItems,
  listAgentBatchRuns,
  type AgentBatchItemStatus,
  type AgentBatchRunFilterStatus,
} from '../services/agent-batch-queue.js';
import { runCollectionAgentBatch } from '../services/collection-batch.js';

const agentBatchCardFiltersSchema = z.object({
  search: z.string().optional(),
  assigneeId: z.string().optional(),

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

const batchRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'active']);
const batchItemStatusSchema = z.enum([
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
const batchBlockingModeSchema = z.enum(['all_success', 'all_settled']);
const batchStageSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  cardIds: z.array(z.uuid()).min(1),
  dependsOnStageIds: z.array(z.string().min(1).max(100)).optional(),
  dependsOnStageIndexes: z.array(z.number().int().min(0)).optional(),
  blockingMode: batchBlockingModeSchema.optional(),
});
const batchCardDependencySchema = z.object({
  cardId: z.uuid(),
  dependsOnCardIds: z.array(z.uuid()).min(1),
  blockingMode: batchBlockingModeSchema.optional(),
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
        const workspace = await getWorkspaceById(request.query.workspaceId);
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
          prompt: z.string().max(10000).optional(),
          maxParallel: z.number().int().min(1).max(20).optional(),
          cardIds: z.array(z.uuid()).min(1).optional(),
          cardFilters: agentBatchCardFiltersSchema.optional(),
          stages: z.array(batchStageSchema).min(1).optional(),
          cardDependencies: z.array(batchCardDependencySchema).min(1).optional(),
        }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) {
        return reply.notFound('Collection not found');
      }

      const {
        agentId,
        prompt,
        maxParallel = 3,
        cardIds,
        cardFilters = {},
        stages,
        cardDependencies,
      } = request.body;

      const result = await runCollectionAgentBatch({
        collectionId: request.params.id,
        agentId,
        prompt,
        maxParallel,
        cardIds,
        cardFilters,
        stages,
        cardDependencies,
      });

      return reply.status(202).send(result);
    },
  );

  typedApp.get(
    '/api/collections/agent-batch/runs',
    {
      onRequest: [app.authenticate, requirePermission('collections:read')],
      schema: {
        tags: ['Collections'],
        summary: 'List agent batch runs across all collections',
        querystring: z.object({
          status: batchRunStatusSchema.optional(),
          agentId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { entries, total } = listAgentBatchRuns({
        sourceType: 'collection',
        status: request.query.status as AgentBatchRunFilterStatus | undefined,
        agentId: request.query.agentId,
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

  typedApp.post(
    '/api/collections/agent-batch/runs/:runId/cancel',
    {
      onRequest: [app.authenticate, requirePermission('collections:update')],
      schema: {
        tags: ['Collections'],
        summary: 'Cancel a collection batch run by ID',
        params: z.object({ runId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const run = getAgentBatchRun(request.params.runId);
      if (!run || run.sourceType !== 'collection') {
        return reply.notFound('Batch run not found');
      }

      const cancelled = await cancelAgentBatchRun(request.params.runId);
      return reply.send(cancelled ?? run);
    },
  );

  typedApp.get(
    '/api/collections/:id/agent-batch/runs',
    {
      onRequest: [app.authenticate, requirePermission('collections:read')],
      schema: {
        tags: ['Collections'],
        summary: 'List collection agent batch runs',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          status: batchRunStatusSchema.optional(),
          agentId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) return reply.notFound('Collection not found');

      const { entries, total } = listAgentBatchRuns({
        sourceType: 'collection',
        sourceId: request.params.id,
        status: request.query.status as AgentBatchRunFilterStatus | undefined,
        agentId: request.query.agentId,
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

  typedApp.get(
    '/api/collections/:id/agent-batch/runs/:runId',
    {
      onRequest: [app.authenticate, requirePermission('collections:read')],
      schema: {
        tags: ['Collections'],
        summary: 'Get collection agent batch run',
        params: z.object({ id: z.uuid(), runId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) return reply.notFound('Collection not found');

      const run = getAgentBatchRun(request.params.runId);
      if (!run) return reply.notFound('Batch run not found');
      if (run.sourceType !== 'collection' || run.sourceId !== request.params.id) {
        return reply.notFound('Batch run not found');
      }

      return reply.send(run);
    },
  );

  typedApp.get(
    '/api/collections/:id/agent-batch/runs/:runId/items',
    {
      onRequest: [app.authenticate, requirePermission('collections:read')],
      schema: {
        tags: ['Collections'],
        summary: 'List collection agent batch run items',
        params: z.object({ id: z.uuid(), runId: z.uuid() }),
        querystring: z.object({
          status: batchItemStatusSchema.optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) return reply.notFound('Collection not found');

      const run = getAgentBatchRun(request.params.runId);
      if (!run) return reply.notFound('Batch run not found');
      if (run.sourceType !== 'collection' || run.sourceId !== request.params.id) {
        return reply.notFound('Batch run not found');
      }

      const { entries, total } = listAgentBatchRunItems(request.params.runId, {
        status: request.query.status as AgentBatchItemStatus | undefined,
        limit: request.query.limit,
        offset: request.query.offset,
      });

      return reply.send({
        total,
        limit: request.query.limit ?? 100,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  typedApp.post(
    '/api/collections/:id/agent-batch/runs/:runId/cancel',
    {
      onRequest: [app.authenticate, requirePermission('collections:update')],
      schema: {
        tags: ['Collections'],
        summary: 'Cancel collection agent batch run',
        params: z.object({ id: z.uuid(), runId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const collection = await getCollectionById(request.params.id);
      if (!collection) return reply.notFound('Collection not found');

      const run = getAgentBatchRun(request.params.runId);
      if (!run) return reply.notFound('Batch run not found');
      if (run.sourceType !== 'collection' || run.sourceId !== request.params.id) {
        return reply.notFound('Batch run not found');
      }

      const cancelled = await cancelAgentBatchRun(request.params.runId);
      return reply.send(cancelled ?? run);
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
