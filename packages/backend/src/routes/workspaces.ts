import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import {
  listWorkspaces,
  getWorkspaceById,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from '../services/workspaces.js';

const createWorkspaceBody = z.object({
  name: z.string().min(1).max(255),
  boardIds: z.array(z.uuid()).optional(),
  collectionIds: z.array(z.uuid()).optional(),
  agentGroupIds: z.array(z.string()).optional(),
});

const updateWorkspaceBody = z.object({
  name: z.string().min(1).max(255).optional(),
  boardIds: z.array(z.uuid()).optional(),
  collectionIds: z.array(z.uuid()).optional(),
  agentGroupIds: z.array(z.string()).optional(),
});

export async function workspaceRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List workspaces for current user
  typedApp.get(
    '/api/workspaces',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Workspaces'],
        summary: 'List workspaces for current user',
        querystring: z.object({
          search: z.string().optional(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { entries, total } = await listWorkspaces({
        userId: request.user.sub,
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

  // Create workspace
  typedApp.post(
    '/api/workspaces',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Workspaces'],
        summary: 'Create a new workspace',
        body: createWorkspaceBody,
      },
    },
    async (request, reply) => {
      const workspace = await createWorkspace(
        {
          ...request.body,
          userId: request.user.sub,
        },
        {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
      );

      return reply.status(201).send(workspace);
    },
  );

  // Update workspace
  typedApp.patch(
    '/api/workspaces/:id',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Workspaces'],
        summary: 'Update a workspace',
        params: z.object({ id: z.uuid() }),
        body: updateWorkspaceBody,
      },
    },
    async (request, reply) => {
      const workspace = await getWorkspaceById(request.params.id);
      if (!workspace) {
        return reply.notFound('Workspace not found');
      }

      if ((workspace as any).userId !== request.user.sub) {
        return reply.forbidden('Not authorized to update this workspace');
      }

      const updated = await updateWorkspace(request.params.id, request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!updated) {
        return reply.notFound('Workspace not found');
      }

      return reply.send(updated);
    },
  );

  // Delete workspace
  typedApp.delete(
    '/api/workspaces/:id',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Workspaces'],
        summary: 'Delete a workspace',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const workspace = await getWorkspaceById(request.params.id);
      if (!workspace) {
        return reply.notFound('Workspace not found');
      }

      if ((workspace as any).userId !== request.user.sub) {
        return reply.forbidden('Not authorized to delete this workspace');
      }

      const deleted = await deleteWorkspace(request.params.id, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!deleted) {
        return reply.notFound('Workspace not found');
      }

      return reply.status(204).send();
    },
  );
}
