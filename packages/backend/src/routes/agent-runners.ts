import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  disconnectRemoteAgentRunner,
  getLiveRunnerStatusMap,
  listConnectedAgentRunners,
} from '../services/agent-runners.js';
import {
  createRunnerPairingCode,
  listRunnerDevices,
  pairRunnerWithCode,
  renameRunnerDevice,
  revokeRunnerDevice,
} from '../services/runner-devices.js';

const workspaceQuery = z.object({
  workspaceId: z.uuid().optional(),
});

const createPairingBody = z.object({
  workspaceId: z.uuid(),
  displayName: z.string().min(1).max(120).optional(),
});

const pairBody = z.object({
  code: z.string().min(6).max(32),
  displayName: z.string().min(1).max(120).optional(),
  version: z.string().max(80).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

const renameBody = z.object({
  displayName: z.string().min(1).max(120),
});

export async function agentRunnerRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/api/agent-runners',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Runners'],
        summary: 'List remote agent runner devices',
        querystring: workspaceQuery,
      },
    },
    async (request, reply) => {
      return reply.send({
        entries: listRunnerDevices(
          request.user.sub,
          request.query.workspaceId,
          getLiveRunnerStatusMap(),
        ),
      });
    },
  );

  typedApp.get(
    '/api/agent-runners/live',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Runners'],
        summary: 'List connected remote agent runner sockets',
      },
    },
    async (_request, reply) => {
      return reply.send({ entries: listConnectedAgentRunners() });
    },
  );

  typedApp.post(
    '/api/agent-runners/pairing-codes',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Runners'],
        summary: 'Create a runner pairing code',
        body: createPairingBody,
      },
    },
    async (request, reply) => {
      try {
        const result = await createRunnerPairingCode(
          {
            userId: request.user.sub,
            workspaceId: request.body.workspaceId,
            displayName: request.body.displayName ?? 'Runner',
          },
          {
            userId: request.user.sub,
            ipAddress: request.ip,
            userAgent: request.headers['user-agent'],
          },
        );
        return reply.status(201).send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create pairing code';
        return reply.badRequest(message);
      }
    },
  );

  typedApp.post(
    '/api/agent-runners/pair',
    {
      schema: {
        tags: ['Agent Runners'],
        summary: 'Pair a runner with a one-time code',
        body: pairBody,
      },
    },
    async (request, reply) => {
      try {
        return reply.status(201).send(await pairRunnerWithCode(request.body));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to pair runner';
        return reply.unauthorized(message);
      }
    },
  );

  typedApp.patch(
    '/api/agent-runners/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Runners'],
        summary: 'Rename a runner device',
        params: z.object({ id: z.uuid() }),
        body: renameBody,
      },
    },
    async (request, reply) => {
      const updated = await renameRunnerDevice(
        request.user.sub,
        request.params.id,
        request.body.displayName,
        {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
      );
      if (!updated) return reply.notFound('Runner not found');
      return reply.send(updated);
    },
  );

  typedApp.post(
    '/api/agent-runners/:id/revoke',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Runners'],
        summary: 'Revoke a runner device',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const revoked = await revokeRunnerDevice(request.user.sub, request.params.id, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
      if (!revoked) return reply.notFound('Runner not found');
      disconnectRemoteAgentRunner(request.params.id);
      return reply.send(revoked);
    },
  );
}
