import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  attachSkillToAgent,
  detachSkillFromAgent,
  getAgentSkills,
  listSkillFiles,
  readSkillFileContent,
  uploadSkillFile,
  createSkillFolder,
  deleteSkillFile,
  getSkillFilePath,
  getSkillEntryPath,
  writeSkillFile,
} from '../services/skills.js';
import { getAgent } from '../services/agents.js';

export async function skillRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // ── Skill CRUD ──

  typedApp.get(
    '/api/skills',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Skills'],
        summary: 'List all skills',
      },
    },
    async (_request, reply) => {
      return reply.send({ entries: listSkills() });
    },
  );

  typedApp.post(
    '/api/skills',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Create a skill',
        body: z.object({
          name: z.string().min(1).max(100),
          description: z.string().max(500).default(''),
        }),
      },
    },
    async (request, reply) => {
      const skill = createSkill(request.body);
      return reply.status(201).send(skill);
    },
  );

  typedApp.get(
    '/api/skills/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Skills'],
        summary: 'Get a skill',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      return reply.send(skill);
    },
  );

  typedApp.patch(
    '/api/skills/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Update a skill',
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().min(1).max(100).optional(),
          description: z.string().max(500).optional(),
        }),
      },
    },
    async (request, reply) => {
      const updated = updateSkill(request.params.id, request.body);
      if (!updated) return reply.notFound('Skill not found');
      return reply.send(updated);
    },
  );

  typedApp.delete(
    '/api/skills/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Delete a skill from the preset library',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const deleted = deleteSkill(request.params.id);
      if (!deleted) return reply.notFound('Skill not found');
      return reply.status(204).send();
    },
  );

  // ── Skill file operations ──

  typedApp.get(
    '/api/skills/:id/files',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Skills'],
        summary: 'List files in a skill folder',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string().default('/'),
        }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      try {
        const entries = listSkillFiles(request.params.id, request.query.path);
        return reply.send({ entries });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.get(
    '/api/skills/:id/files/content',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Skills'],
        summary: 'Read a file from a skill folder',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      try {
        const content = readSkillFileContent(request.params.id, request.query.path);
        if (content === null) return reply.notFound('File not found');
        return reply.send({ path: request.query.path, content });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.put(
    '/api/skills/:id/files/content',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Write/update a text file in a skill folder',
        params: z.object({ id: z.string() }),
        body: z.object({
          path: z.string().min(1),
          content: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      try {
        writeSkillFile(request.params.id, request.body.path, request.body.content);
        return reply.status(204).send();
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.get(
    '/api/skills/:id/files/download',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Skills'],
        summary: 'Download a file from a skill folder',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      try {
        const diskPath = getSkillFilePath(request.params.id, request.query.path);
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

  typedApp.post(
    '/api/skills/:id/files/reveal',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Skills'],
        summary: 'Open a skill file location in the OS file manager',
        params: z.object({ id: z.string() }),
        body: z.object({
          path: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      try {
        const diskPath = getSkillEntryPath(request.params.id, request.body.path);
        if (!diskPath) return reply.notFound('Path not found');

        const platform = process.platform;
        if (platform === 'darwin') {
          const stat = fs.statSync(diskPath);
          if (stat.isDirectory()) {
            spawn('open', [diskPath], { detached: true, stdio: 'ignore' }).unref();
          } else {
            spawn('open', ['-R', diskPath], { detached: true, stdio: 'ignore' }).unref();
          }
        } else if (platform === 'win32') {
          spawn('explorer', [`/select,${diskPath}`], { detached: true, stdio: 'ignore' }).unref();
        } else {
          const stat = fs.statSync(diskPath);
          const dir = stat.isDirectory() ? diskPath : path.dirname(diskPath);
          spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
        }

        return reply.status(204).send();
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.post(
    '/api/skills/:id/files/upload',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Upload a file to a skill folder',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');

      const data = await request.file();
      if (!data) return reply.badRequest('No file uploaded');

      const dirPath = (data.fields.path as { value: string } | undefined)?.value || '/';
      const fileName = data.filename || 'unnamed';

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      try {
        const entry = await uploadSkillFile(request.params.id, dirPath, fileName, buffer);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.post(
    '/api/skills/:id/files/folders',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Create a subfolder in a skill',
        params: z.object({ id: z.string() }),
        body: z.object({
          path: z.string().default('/'),
          name: z.string().min(1).max(255),
        }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      try {
        const entry = createSkillFolder(request.params.id, request.body.path, request.body.name);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.delete(
    '/api/skills/:id/files',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Delete a file or folder from a skill',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const skill = getSkill(request.params.id);
      if (!skill) return reply.notFound('Skill not found');
      try {
        const deleted = deleteSkillFile(request.params.id, request.query.path);
        if (!deleted) return reply.notFound('Item not found');
        return reply.status(204).send();
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // ── Agent skill attachment ──

  typedApp.get(
    '/api/agents/:id/skills',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Skills'],
        summary: 'List skills referenced by an agent instruction file',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      return reply.send({ entries: getAgentSkills(request.params.id) });
    },
  );

  typedApp.post(
    '/api/agents/:id/skills',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Copy a preset-library skill into an agent workspace',
        params: z.object({ id: z.string() }),
        body: z.object({
          skillId: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        attachSkillToAgent(request.params.id, request.body.skillId);
        return reply.send({ entries: getAgentSkills(request.params.id) });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.delete(
    '/api/agents/:id/skills/:skillId',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Skills'],
        summary: 'Remove a local skill from an agent workspace',
        params: z.object({
          id: z.string(),
          skillId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');
      try {
        detachSkillFromAgent(request.params.id, request.params.skillId);
        return reply.status(204).send();
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
