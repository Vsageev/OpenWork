import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { store } from '../db/index.js';
import { requirePermission } from '../middleware/rbac.js';

const createTagBody = z.object({
  name: z.string().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
});

const updateTagBody = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
});

export async function tagRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List all tags
  typedApp.get(
    '/api/tags',
    {
      onRequest: [app.authenticate, requirePermission('cards:read')],
      schema: {
        tags: ['Tags'],
        summary: 'List all tags',
      },
    },
    async (_request, reply) => {
      const entries = store.getAll('tags');
      // Sort by createdAt descending
      entries.sort((a, b) => {
        const aDate = a.createdAt as string || '';
        const bDate = b.createdAt as string || '';
        return bDate.localeCompare(aDate);
      });
      // Count card usages per tag
      const cardTags = store.getAll('cardTags') as any[];
      const countsByTagId = new Map<string, number>();
      for (const ct of cardTags) {
        countsByTagId.set(ct.tagId, (countsByTagId.get(ct.tagId) ?? 0) + 1);
      }
      const enriched = entries.map((tag: any) => ({
        ...tag,
        cardCount: countsByTagId.get(tag.id) ?? 0,
      }));
      return reply.send({ entries: enriched, total: enriched.length });
    },
  );

  // Create tag
  typedApp.post(
    '/api/tags',
    {
      onRequest: [app.authenticate, requirePermission('cards:create')],
      schema: {
        tags: ['Tags'],
        summary: 'Create a new tag',
        body: createTagBody,
      },
    },
    async (request, reply) => {
      const existing = store.findOne('tags', (t) => t.name === request.body.name);

      if (existing) {
        return reply.conflict('Tag with this name already exists');
      }

      const tag = store.insert('tags', request.body);
      return reply.status(201).send(tag);
    },
  );

  // Update tag
  typedApp.patch(
    '/api/tags/:id',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Tags'],
        summary: 'Update an existing tag',
        params: z.object({ id: z.uuid() }),
        body: updateTagBody,
      },
    },
    async (request, reply) => {
      if (request.body.name) {
        const existing = store.findOne('tags', (t) => t.name === request.body.name);

        if (existing && existing.id !== request.params.id) {
          return reply.conflict('Tag with this name already exists');
        }
      }

      const updated = store.update('tags', request.params.id, request.body);

      if (!updated) {
        return reply.notFound('Tag not found');
      }

      return reply.send(updated);
    },
  );

  // Delete tag
  typedApp.delete(
    '/api/tags/:id',
    {
      onRequest: [app.authenticate, requirePermission('cards:delete')],
      schema: {
        tags: ['Tags'],
        summary: 'Delete a tag',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = store.delete('tags', request.params.id);

      if (!deleted) {
        return reply.notFound('Tag not found');
      }

      // Cascade: remove all card-tag associations for the deleted tag
      store.deleteWhere('cardTags', (r: any) => r.tagId === request.params.id);

      return reply.status(204).send();
    },
  );
}
