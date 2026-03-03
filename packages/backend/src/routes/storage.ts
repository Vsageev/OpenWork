import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  listDir,
  createFolder,
  createReference,
  uploadFile,
  renameItem,
  deleteItem,
  getFilePath,
  getDiskPath,
  getStats,
  browseFileSystem,
} from '../services/storage.js';

export async function storageRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List directory contents
  typedApp.get(
    '/api/storage',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Storage'],
        summary: 'List directory contents',
        querystring: z.object({
          path: z.string().default('/'),
        }),
      },
    },
    async (request, reply) => {
      try {
        const entries = listDir(request.query.path);
        return reply.send({ entries });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Get storage stats
  typedApp.get(
    '/api/storage/stats',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Storage'],
        summary: 'Get storage statistics',
      },
    },
    async (_request, reply) => {
      const stats = getStats();
      return reply.send(stats);
    },
  );

  // Browse host filesystem (for reference picker)
  typedApp.get(
    '/api/storage/browse-fs',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Storage'],
        summary: 'Browse the host filesystem for creating references',
        querystring: z.object({
          path: z.string().default('/'),
        }),
      },
    },
    async (request, reply) => {
      try {
        const entries = browseFileSystem(request.query.path);
        return reply.send({ path: request.query.path, entries });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Create folder
  typedApp.post(
    '/api/storage/folders',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Storage'],
        summary: 'Create a new folder',
        body: z.object({
          path: z.string().default('/'),
          name: z.string().min(1).max(255),
        }),
      },
    },
    async (request, reply) => {
      try {
        const entry = createFolder(request.body.path, request.body.name);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Create reference (symlink)
  typedApp.post(
    '/api/storage/references',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Storage'],
        summary: 'Create a reference (symlink) to a local path',
        body: z.object({
          path: z.string().default('/'),
          name: z.string().min(1).max(255),
          target: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      try {
        const entry = createReference(request.body.path, request.body.name, request.body.target);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Upload file (multipart)
  typedApp.post(
    '/api/storage/upload',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Storage'],
        summary: 'Upload a file to storage',
      },
    },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.badRequest('No file uploaded');
      }

      const dirPath = (data.fields.path as { value: string } | undefined)?.value || '/';
      const fileName = data.filename || 'unnamed';
      const mimeType = data.mimetype || 'application/octet-stream';

      // Read file into buffer
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      try {
        const entry = await uploadFile(dirPath, fileName, mimeType, buffer);
        return reply.status(201).send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Download file
  typedApp.get(
    '/api/storage/download',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Storage'],
        summary: 'Download a file',
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      try {
        const diskPath = getFilePath(request.query.path);
        if (!diskPath) {
          return reply.notFound('File not found');
        }

        const fileName = path.basename(diskPath);
        const ext = path.extname(fileName).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.pdf': 'application/pdf',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.txt': 'text/plain',
          '.csv': 'text/csv',
          '.json': 'application/json',
          '.zip': 'application/zip',
          '.doc': 'application/msword',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xls': 'application/vnd.ms-excel',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
        const contentType = mimeMap[ext] || 'application/octet-stream';

        // Ignore EPIPE — client disconnected before the stream finished
        reply.raw.socket?.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EPIPE') request.log.error(err);
        });

        return reply
          .header('Content-Type', contentType)
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .send(fs.createReadStream(diskPath));
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Rename file or folder
  typedApp.patch(
    '/api/storage/rename',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Storage'],
        summary: 'Rename a file or folder',
        body: z.object({
          path: z.string().min(1),
          newName: z.string().min(1).max(255),
        }),
      },
    },
    async (request, reply) => {
      try {
        const entry = renameItem(request.body.path, request.body.newName);
        return reply.send(entry);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  // Reveal file/folder in host OS file manager
  typedApp.post(
    '/api/storage/reveal',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Storage'],
        summary: 'Open a file or folder location in the OS file manager',
        body: z.object({
          path: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      try {
        const diskPath = getDiskPath(request.body.path);
        if (!diskPath) {
          return reply.notFound('Path not found');
        }

        const platform = process.platform;
        if (platform === 'darwin') {
          const stat = fs.statSync(diskPath);
          // -R selects the item in Finder; for folders open the folder itself
          if (stat.isDirectory()) {
            spawn('open', [diskPath], { detached: true, stdio: 'ignore' }).unref();
          } else {
            spawn('open', ['-R', diskPath], { detached: true, stdio: 'ignore' }).unref();
          }
        } else if (platform === 'win32') {
          spawn('explorer', [`/select,${diskPath}`], { detached: true, stdio: 'ignore' }).unref();
        } else {
          // Linux: open the containing directory
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

  // Delete file or folder
  typedApp.delete(
    '/api/storage',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Storage'],
        summary: 'Delete a file or folder',
        querystring: z.object({
          path: z.string(),
        }),
      },
    },
    async (request, reply) => {
      try {
        const deleted = deleteItem(request.query.path);
        if (!deleted) {
          return reply.notFound('Item not found');
        }
        return reply.status(204).send();
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
