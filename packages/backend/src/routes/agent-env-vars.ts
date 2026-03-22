import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { getAgent } from '../services/agents.js';
import {
  createAgentEnvVar,
  deleteAgentEnvVar,
  getAgentEnvVar,
  listAgentEnvVars,
  updateAgentEnvVar,
} from '../services/agent-env-vars.js';

const paramsSchema = z.object({
  agentId: z.uuid(),
  envVarId: z.uuid(),
});

const createBodySchema = z
  .object({
    key: z.string().trim().min(1).max(128),
    value: z.string().min(1).max(10000),
    description: z.string().max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    key: z.string().trim().min(1).max(128).optional(),
    value: z.string().max(10000).optional(),
    description: z.string().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

function auditMeta(request: {
  user: { sub: string };
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}) {
  return {
    userId: request.user.sub,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] as string | undefined,
  };
}

export async function agentEnvVarRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/api/agents/:agentId/env-vars',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'List env vars configured for an agent',
        params: z.object({ agentId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.agentId);
      if (!agent) return reply.notFound('Agent not found');

      return reply.send({
        entries: listAgentEnvVars(request.params.agentId),
      });
    },
  );

  typedApp.get(
    '/api/agents/:agentId/env-vars/:envVarId',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'Get one env var configured for an agent',
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.agentId);
      if (!agent) return reply.notFound('Agent not found');

      const record = getAgentEnvVar(request.params.agentId, request.params.envVarId);
      if (!record) return reply.notFound('Env var not found');

      return reply.send(record);
    },
  );

  typedApp.post(
    '/api/agents/:agentId/env-vars',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Create an env var for an agent',
        params: z.object({ agentId: z.uuid() }),
        body: createBodySchema,
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.agentId);
      if (!agent) return reply.notFound('Agent not found');

      try {
        const record = await createAgentEnvVar(
          {
            agentId: request.params.agentId,
            key: request.body.key,
            value: request.body.value,
            description: request.body.description,
            isActive: request.body.isActive,
            createdById: request.user.sub,
          },
          auditMeta(request),
        );

        return reply.status(201).send(record);
      } catch (error) {
        return reply.badRequest((error as Error).message);
      }
    },
  );

  typedApp.patch(
    '/api/agents/:agentId/env-vars/:envVarId',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Update an env var for an agent',
        params: paramsSchema,
        body: updateBodySchema,
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.agentId);
      if (!agent) return reply.notFound('Agent not found');

      try {
        const updated = await updateAgentEnvVar(
          request.params.agentId,
          request.params.envVarId,
          request.body,
          auditMeta(request),
        );
        if (!updated) return reply.notFound('Env var not found');
        return reply.send(updated);
      } catch (error) {
        return reply.badRequest((error as Error).message);
      }
    },
  );

  typedApp.delete(
    '/api/agents/:agentId/env-vars/:envVarId',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Delete an env var from an agent',
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.agentId);
      if (!agent) return reply.notFound('Agent not found');

      const deleted = await deleteAgentEnvVar(
        request.params.agentId,
        request.params.envVarId,
        auditMeta(request),
      );
      if (!deleted) return reply.notFound('Env var not found');

      return reply.status(204).send();
    },
  );
}
