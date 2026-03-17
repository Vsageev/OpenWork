import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  listAgentRuns,
  getActiveRuns,
  getAgentRun,
  killAgentRun,
  cleanupOldRunRecords,
  migrateLegacyAgentRunTriggerTypes,
} from '../services/agent-runs.js';
import { cancelProcessingQueueItemForRun } from '../services/agent-chat.js';
import { listAgentBatchRuns, cancelAgentBatchRun, cleanupFinishedBatchRuns, type AgentBatchRunFilterStatus } from '../services/agent-batch-queue.js';

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
          conversationId: z.string().optional(),
          triggerType: z.enum(['chat', 'cron_job', 'card_assignment']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      const { status, agentId, conversationId, triggerType, limit, offset } = request.query;
      const result = listAgentRuns({ status, agentId, conversationId, triggerType, limit, offset });
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

  typedApp.post(
    '/api/agent-runs/migrate-trigger-types',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Runs'],
        summary: 'Migrate legacy agent run trigger types to canonical enum values',
      },
    },
    async (_request, reply) => {
      const result = migrateLegacyAgentRunTriggerTypes();
      return reply.send(result);
    },
  );

  // ── Batch Runs (global) ──────────────────────────────────────────────

  typedApp.get(
    '/api/agent-batch-runs',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Batch Runs'],
        summary: 'List all agent batch runs across boards and collections',
        querystring: z.object({
          status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'active']).optional(),
          agentId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      const { status, agentId, limit, offset } = request.query;
      const { entries, total } = listAgentBatchRuns({
        status: status as AgentBatchRunFilterStatus | undefined,
        agentId,
        limit,
        offset,
      });
      return reply.send({ entries, total, limit, offset });
    },
  );

  typedApp.delete(
    '/api/agent-batch-runs',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Batch Runs'],
        summary: 'Delete all finished (completed/failed/cancelled) batch runs',
      },
    },
    async (_request, reply) => {
      const deleted = cleanupFinishedBatchRuns();
      return reply.send({ deleted });
    },
  );

  typedApp.post(
    '/api/agent-batch-runs/:runId/cancel',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Batch Runs'],
        summary: 'Cancel a batch run by ID',
        params: z.object({ runId: z.string() }),
      },
    },
    async (request, reply) => {
      const cancelled = cancelAgentBatchRun(request.params.runId);
      if (!cancelled) {
        return reply.status(404).send({ error: 'Batch run not found' });
      }
      return reply.send(cancelled);
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
      cancelProcessingQueueItemForRun(request.params.id);
      return reply.status(204).send();
    },
  );
}
