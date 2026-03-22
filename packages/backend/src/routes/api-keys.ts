import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import {
  createApiKey,
  listApiKeys,
  getApiKeyById,
  updateApiKey,
  deleteApiKey,
} from '../services/api-keys.js';
import { syncAgentsForApiKey } from '../services/agents.js';

const API_RESOURCES = [
  'contacts', 'cards', 'tasks', 'boards', 'folders',
  'messages', 'activities', 'templates', 'webhooks',
  'settings', 'collections', 'users', 'backups', 'audit-logs',
  'storage', 'tags', 'conversations',
] as const;

const permissionSchema = z.string().refine(
  (val) => {
    const [resource, action] = val.split(':');
    return API_RESOURCES.includes(resource as any) && (action === 'read' || action === 'write');
  },
  { message: 'Permission must be in format resource:(read|write)' },
);

const createApiKeyBody = z.object({
  name: z.string().min(1).max(255),
  permissions: z.array(permissionSchema).min(1),
  description: z.string().max(1000).optional(),
  expiresAt: z.iso.datetime().optional(),
});

const updateApiKeyBody = z.object({
  name: z.string().min(1).max(255).optional(),
  permissions: z.array(permissionSchema).min(1).optional(),
  description: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

function auditMeta(request: { user: { sub: string }; ip: string; headers: Record<string, string | string[] | undefined> }) {
  return {
    userId: request.user.sub,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] as string | undefined,
  };
}

export async function apiKeyRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List API keys for the authenticated user
  typedApp.get(
    '/api/api-keys',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['API Keys'],
        summary: 'List API keys',
        querystring: z.object({
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const limit = request.query.limit !== undefined ? Math.min(Math.max(request.query.limit || 50, 1), 100) : 50;
      const offset = request.query.offset !== undefined ? Math.max(request.query.offset || 0, 0) : 0;

      const user = request.user as { sub: string };
      const { entries, total } = await listApiKeys({ createdById: user.sub, limit, offset });
      return reply.send({ total, limit, offset, entries });
    },
  );

  // Get single API key
  typedApp.get(
    '/api/api-keys/:id',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['API Keys'],
        summary: 'Get API key by ID',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const key = await getApiKeyById(request.params.id) as any;
      if (!key) return reply.notFound('API key not found');

      const user = request.user as { sub: string };
      if (key.createdById !== user.sub) {
        return reply.forbidden('Access denied');
      }

      return reply.send(key);
    },
  );

  // Create API key — returns the raw key only once
  typedApp.post(
    '/api/api-keys',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['API Keys'],
        summary: 'Create an API key',
        body: createApiKeyBody,
      },
    },
    async (request, reply) => {
      const result = await createApiKey(
        {
          name: request.body.name,
          permissions: request.body.permissions,
          createdById: request.user.sub,
          description: request.body.description,
          expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : undefined,
        },
        auditMeta(request),
      ) as any;

      return reply.status(201).send({
        id: result.id,
        name: result.name,
        keyPrefix: result.keyPrefix,
        permissions: result.permissions,
        description: result.description,
        isActive: result.isActive,
        expiresAt: result.expiresAt,
        createdAt: result.createdAt,
        // The raw key — shown only once
        key: result.rawKey,
      });
    },
  );

  // Update API key
  typedApp.patch(
    '/api/api-keys/:id',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['API Keys'],
        summary: 'Update an API key',
        params: z.object({ id: z.uuid() }),
        body: updateApiKeyBody,
      },
    },
    async (request, reply) => {
      const existing = await getApiKeyById(request.params.id) as any;
      if (!existing) return reply.notFound('API key not found');

      const user = request.user as { sub: string };
      if (existing.createdById !== user.sub) {
        return reply.forbidden('Access denied');
      }

      const data: Record<string, unknown> = { ...request.body };
      if (request.body.expiresAt !== undefined) {
        data.expiresAt = request.body.expiresAt ? new Date(request.body.expiresAt) : null;
      }

      const updated = await updateApiKey(request.params.id, data, auditMeta(request));
      if (!updated) return reply.notFound('API key not found');
      await syncAgentsForApiKey(request.params.id);

      return reply.send(updated);
    },
  );

  // Delete (revoke) API key
  typedApp.delete(
    '/api/api-keys/:id',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['API Keys'],
        summary: 'Delete (revoke) an API key',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const existing = await getApiKeyById(request.params.id) as any;
      if (!existing) return reply.notFound('API key not found');

      const user = request.user as { sub: string };
      if (existing.createdById !== user.sub) {
        return reply.forbidden('Access denied');
      }

      await deleteApiKey(request.params.id, auditMeta(request));
      await syncAgentsForApiKey(request.params.id);
      return reply.status(204).send();
    },
  );
}
