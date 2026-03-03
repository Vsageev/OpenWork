import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { listAgentRuns, getActiveRuns, getAgentRun, killAgentRun, cleanupOldRunRecords } from '../services/agent-runs.js';

export async function agentRunRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/api/agent-runs',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Runs'],
        summary: 'List agent runs with optional filters',
        querystring: z.object({
          status: z.enum(['running', 'completed', 'error']).optional(),
          agentId: z.string().optional(),
          triggerType: z.enum(['chat', 'cron', 'card']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      const { status, agentId, triggerType, limit, offset } = request.query;
      const result = listAgentRuns({ status, agentId, triggerType, limit, offset });
      return reply.send({ ...result, limit, offset });
    },
  );

  typedApp.get(
    '/api/agent-runs/active',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Runs'],
        summary: 'Get currently active (running) agent runs',
      },
    },
    async (_request, reply) => {
      const entries = getActiveRuns();
      return reply.send({ entries });
    },
  );

  typedApp.get(
    '/api/agent-runs/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Runs'],
        summary: 'Get a single agent run by ID (includes logs)',
        params: z.object({
          id: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const run = getAgentRun(request.params.id);
      if (!run) {
        return reply.status(404).send({ error: 'Agent run not found' });
      }
      return reply.send(run);
    },
  );

  // Bulk cleanup — delete completed/error runs older than N days
  typedApp.delete(
    '/api/agent-runs',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Runs'],
        summary: 'Delete old completed/error agent run records',
        querystring: z.object({
          olderThanDays: z.coerce.number().int().min(1).max(365).default(30),
        }),
      },
    },
    async (request, reply) => {
      const { olderThanDays } = request.query;
      const deleted = cleanupOldRunRecords(olderThanDays);
      return reply.send({ deleted, olderThanDays });
    },
  );

  typedApp.delete(
    '/api/agent-runs/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Runs'],
        summary: 'Kill a running agent run',
        params: z.object({
          id: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const result = killAgentRun(request.params.id);
      if (!result.ok) {
        const status = result.error === 'Run not found' ? 404 : 409;
        return reply.status(status).send({ error: result.error });
      }
      return reply.status(204).send();
    },
  );
}
