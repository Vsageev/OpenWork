import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { store } from '../db/index.js';
import cron from 'node-cron';
import {
  checkCliStatus,
  listPresets,
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  deleteAgent,
  listAgentFiles,
  getAgentFilePath,
  readAgentFileContent,
  uploadAgentFile,
  createAgentFolder,
  createAgentReference,
  deleteAgentFile,
  listAgentGroups,
  createAgentGroup,
  updateAgentGroup,
  deleteAgentGroup,
  reorderAgentGroups,
} from '../services/agents.js';
import { getWorkspaceById } from '../services/workspaces.js';
import { syncAgentCronJobs } from '../services/agent-cron.js';

export async function agentRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // Check CLI availability
  typedApp.get(
    '/api/agents/cli-status',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'Check which agent CLIs are installed on the server',
      },
    },
    async (_request, reply) => {
      return reply.send({ clis: checkCliStatus() });
    },
  );

  // List presets
  typedApp.get(
    '/api/agents/presets',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'List available agent presets',
      },
    },
    async (_request, reply) => {
      return reply.send({ presets: listPresets() });
    },
  );

  // List agents
  typedApp.get(
    '/api/agents',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'List agents',
        querystring: z.object({
          workspaceId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      let all = listAgents();

      if (request.query.workspaceId) {
        const workspace = await getWorkspaceById(request.query.workspaceId) as any;
        if (workspace && Array.isArray(workspace.agentGroupIds)) {
          const idSet = new Set(workspace.agentGroupIds);
          all = all.filter((a: any) => a.groupId && idSet.has(a.groupId));
        }
      }

      const { limit, offset } = request.query;
      const entries = all.slice(offset, offset + limit);
      return reply.send({ total: all.length, limit, offset, entries });
    },
  );

  // Create agent
  typedApp.post(
    '/api/agents',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Create a new agent',
        body: z.object({
          name: z.string().min(1).max(255),
          description: z.string().max(1000).default(''),
          model: z.string().min(1).max(100),
          modelId: z.string().max(200).nullable().optional(),
          thinkingLevel: z.enum(['low', 'medium', 'high']).nullable().optional(),
          preset: z.string().min(1).max(100),
          apiKeyId: z.string().min(1),
          skipPermissions: z.boolean().optional(),
          groupId: z.string().nullable().optional(),
          avatarIcon: z.string().max(50).optional(),
          avatarBgColor: z.string().max(20).optional(),
          avatarLogoColor: z.string().max(20).optional(),
        }),
      },
    },
    async (request, reply) => {
      const {
        name,
        description,
        model,
        modelId,
        thinkingLevel,
        preset,
        apiKeyId,
        skipPermissions,
        groupId,
        avatarIcon,
        avatarBgColor,
        avatarLogoColor,
      } = request.body;

      // Look up the API key to populate derived fields
      const apiKey = store.getById('apiKeys', apiKeyId);
      if (!apiKey) {
        return reply.badRequest('API key not found');
      }

      try {
        const agent = await createAgent({
          name,
          description,
          model,
          modelId,
          thinkingLevel,
          preset,
          apiKeyId,
          apiKeyName: apiKey.name as string,
          apiKeyPrefix: apiKey.keyPrefix as string,
          capabilities: (apiKey.permissions as string[]) || [],
          skipPermissions,
          groupId,
          avatarIcon,
          avatarBgColor,
          avatarLogoColor,
        });
        return reply.status(201).send(agent);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Get single agent
  typedApp.get(
    '/api/agents/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'Get a single agent',
        params: z.object({
          id: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      return reply.send(agent);
    },
  );

  // Update agent
  typedApp.patch(
    '/api/agents/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Update an agent',
        params: z.object({
          id: z.string(),
        }),
        body: z.object({
          name: z.string().min(1).max(255).optional(),
          description: z.string().max(1000).optional(),
          model: z.string().min(1).max(100).optional(),
          modelId: z.string().max(200).nullable().optional(),
          thinkingLevel: z.enum(['low', 'medium', 'high']).nullable().optional(),
          status: z.enum(['active', 'inactive', 'error']).optional(),
          skipPermissions: z.boolean().optional(),
          groupId: z.string().nullable().optional(),
          avatarIcon: z.string().max(50).optional(),
          avatarBgColor: z.string().max(20).optional(),
          avatarLogoColor: z.string().max(20).optional(),
          cronJobs: z.array(z.object({
            id: z.string().min(1),
            cron: z.string().min(1).refine((val) => cron.validate(val), { message: 'Invalid cron expression' }),
            prompt: z.string().min(1).max(5000),
            enabled: z.boolean(),
          })).optional(),
        }),
      },
    },
    async (request, reply) => {
      const updated = updateAgent(request.params.id, request.body);
      if (!updated) return reply.notFound('Agent not found');

      // Sync cron jobs if they were updated
      if (request.body.cronJobs !== undefined) {
        syncAgentCronJobs(request.params.id);
      }

      return reply.send(updated);
    },
  );

  // Delete agent
  typedApp.delete(
    '/api/agents/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Delete an agent and its workspace',
        params: z.object({
          id: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const deleted = await deleteAgent(request.params.id);
      if (!deleted) return reply.notFound('Agent not found');
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // Agent Group endpoints
  // ---------------------------------------------------------------------------

  typedApp.get(
    '/api/agent-groups',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Groups'],
        summary: 'List all agent groups',
        querystring: z.object({
          workspaceId: z.uuid().optional(),
        }),
      },
    },
    async (request, reply) => {
      let groups = listAgentGroups();

      if (request.query.workspaceId) {
        const workspace = await getWorkspaceById(request.query.workspaceId) as any;
        if (workspace && Array.isArray(workspace.agentGroupIds)) {
          const idSet = new Set(workspace.agentGroupIds);
          groups = groups.filter((g: any) => idSet.has(g.id));
        }
      }

      return reply.send({ entries: groups });
    },
  );

  typedApp.post(
    '/api/agent-groups',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Groups'],
        summary: 'Create an agent group',
        body: z.object({
          name: z.string().min(1).max(100),
        }),
      },
    },
    async (request, reply) => {
      const group = createAgentGroup(request.body.name);
      return reply.status(201).send(group);
    },
  );

  typedApp.patch(
    '/api/agent-groups/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Groups'],
        summary: 'Update an agent group',
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().min(1).max(100).optional(),
          order: z.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const updated = updateAgentGroup(request.params.id, request.body);
      if (!updated) return reply.notFound('Agent group not found');
      return reply.send(updated);
    },
  );

  typedApp.delete(
    '/api/agent-groups/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Groups'],
        summary: 'Delete an agent group (agents become ungrouped)',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const deleted = deleteAgentGroup(request.params.id);
      if (!deleted) return reply.notFound('Agent group not found');
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // Workspace file endpoints
  // ---------------------------------------------------------------------------

  // List files
  typedApp.get(
    '/api/agents/:id/files',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'List files in agent workspace',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string().default('/'),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        const entries = listAgentFiles(request.params.id, request.query.path);
        return reply.send({ entries });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Read text file content
  typedApp.get(
    '/api/agents/:id/files/content',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'Read text file content from agent workspace',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        const content = readAgentFileContent(request.params.id, request.query.path);
        if (content === null) return reply.notFound('File not found');
        return reply.send({ path: request.query.path, content });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Download file
  typedApp.get(
    '/api/agents/:id/files/download',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agents'],
        summary: 'Download a file from agent workspace',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        const diskPath = getAgentFilePath(request.params.id, request.query.path);
        if (!diskPath) return reply.notFound('File not found');

        const fileName = path.basename(diskPath);
        return reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .send(fs.createReadStream(diskPath));
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Upload file
  typedApp.post(
    '/api/agents/:id/files/upload',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Upload a file to agent workspace',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const data = await request.file();
      if (!data) return reply.badRequest('No file uploaded');

      const dirPath = (data.fields.path as { value: string } | undefined)?.value || '/';
      const fileName = data.filename || 'unnamed';
      const mimeType = data.mimetype || 'application/octet-stream';

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      try {
        const entry = await uploadAgentFile(request.params.id, dirPath, fileName, mimeType, buffer);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Create subfolder
  typedApp.post(
    '/api/agents/:id/files/folders',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Create a subfolder in agent workspace',
        params: z.object({ id: z.string() }),
        body: z.object({
          path: z.string().default('/'),
          name: z.string().min(1).max(255),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        const entry = createAgentFolder(request.params.id, request.body.path, request.body.name);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Create reference (symlink)
  typedApp.post(
    '/api/agents/:id/files/references',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Create a reference (symlink) in agent workspace',
        params: z.object({ id: z.string() }),
        body: z.object({
          path: z.string().default('/'),
          name: z.string().min(1).max(255),
          target: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        const entry = createAgentReference(request.params.id, request.body.path, request.body.name, request.body.target);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Delete file/folder
  typedApp.delete(
    '/api/agents/:id/files',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agents'],
        summary: 'Delete a file or folder from agent workspace',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        const deleted = deleteAgentFile(request.params.id, request.query.path);
        if (!deleted) return reply.notFound('Item not found');
        return reply.status(204).send();
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
