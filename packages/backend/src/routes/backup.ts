import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  createBackup,
  listBackups,
  pruneOldBackups,
  getBackupPath,
  getBackupBundle,
  restoreBackup,
  deleteBackup,
  importBackup,
  BackupValidationError,
} from '../services/backup.js';

const backupNameParam = z.object({
  name: z.string().min(1),
});

export async function backupRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/backups',
    {
      onRequest: [app.authenticate, requirePermission('backups:create')],
      schema: {
        tags: ['Backup'],
        summary: 'Create a backup (pg_dump + JSON collection mirrors when tools available)',
      },
    },
    async (_req, reply) => {
      const result = await createBackup();
      return reply.status(201).send({
        message: 'Backup created successfully',
        backup: {
          filename: result.filename,
          sizeBytes: result.sizeBytes,
          createdAt: result.createdAt.toISOString(),
        },
      });
    },
  );

  typedApp.get(
    '/api/backups',
    {
      onRequest: [app.authenticate, requirePermission('backups:read')],
      schema: { tags: ['Backup'], summary: 'List all backups' },
    },
    async (_req, reply) => {
      const backups = await listBackups();
      return reply.send({
        count: backups.length,
        backups: backups.map((b) => ({
          filename: b.filename,
          sizeBytes: b.sizeBytes,
          createdAt: b.createdAt.toISOString(),
        })),
      });
    },
  );

  typedApp.post(
    '/api/backups/import',
    {
      onRequest: [app.authenticate, requirePermission('backups:create')],
      schema: {
        tags: ['Backup'],
        summary: 'Import a backup from a JSON bundle',
        body: z.object({
          collections: z.record(z.string(), z.array(z.unknown())),
          filename: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { collections, filename } = req.body;
      try {
        const result = await importBackup(collections, filename);
        return reply.status(201).send({
          message: 'Backup imported successfully',
          backup: {
            filename: result.filename,
            sizeBytes: result.sizeBytes,
            createdAt: result.createdAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof BackupValidationError) {
          return reply.status(422).send({
            message: err.message,
            validationErrors: err.errors,
          });
        }
        throw err;
      }
    },
  );

  typedApp.get(
    '/api/backups/:name/download',
    {
      onRequest: [app.authenticate, requirePermission('backups:read')],
      schema: {
        tags: ['Backup'],
        summary: 'Download a backup as JSON bundle',
        params: backupNameParam,
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const backupPath = await getBackupPath(name);
      if (!backupPath) {
        return reply.status(404).send({ message: `Backup not found: ${name}` });
      }
      const collections = await getBackupBundle(name);
      return reply
        .header('Content-Disposition', `attachment; filename="${name}.json"`)
        .header('Content-Type', 'application/json')
        .send({ collections });
    },
  );

  typedApp.post(
    '/api/backups/:name/restore',
    {
      onRequest: [app.authenticate, requirePermission('backups:create')],
      schema: {
        tags: ['Backup'],
        summary: 'Restore from a named backup using postgres.dump',
        params: backupNameParam,
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const backupPath = await getBackupPath(name);
      if (!backupPath) {
        return reply.status(404).send({ message: `Backup not found: ${name}` });
      }
      try {
        const { preRestoreBackup } = await restoreBackup(name);
        return reply.send({
          message: `Backup restored: ${name}`,
          preRestoreBackup,
        });
      } catch (err) {
        if (err instanceof BackupValidationError) {
          return reply.status(422).send({
            message: err.message,
            validationErrors: err.errors,
          });
        }
        throw err;
      }
    },
  );

  typedApp.delete(
    '/api/backups/prune',
    {
      onRequest: [app.authenticate, requirePermission('backups:delete')],
      schema: { tags: ['Backup'], summary: 'Prune old backups' },
    },
    async (_req, reply) => {
      const removed = await pruneOldBackups();
      return reply.send({
        message: `Pruned ${removed.length} old backup(s)`,
        removed,
      });
    },
  );

  typedApp.delete(
    '/api/backups/:name',
    {
      onRequest: [app.authenticate, requirePermission('backups:delete')],
      schema: {
        tags: ['Backup'],
        summary: 'Delete a specific backup',
        params: backupNameParam,
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const backupPath = await getBackupPath(name);
      if (!backupPath) {
        return reply.status(404).send({ message: `Backup not found: ${name}` });
      }
      await deleteBackup(name);
      return reply.send({ message: `Backup deleted: ${name}` });
    },
  );
}
