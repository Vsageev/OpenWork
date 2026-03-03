import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  listCards,
  getCardById,
  createCard,
  updateCard,
  deleteCard,
  addCardTag,
  removeCardTag,
  addCardLink,
  removeCardLink,
  listCardComments,
  createCardComment,
  updateCardComment,
  deleteCardComment,
} from '../services/cards.js';

const createCardBody = z.object({
  collectionId: z.uuid(),
  name: z.string().min(1).max(500),
  description: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  assigneeId: z.uuid().nullable().optional(),
  position: z.number().int().min(0).optional(),
});

const updateCardBody = z.object({
  name: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  assigneeId: z.uuid().nullable().optional(),
  collectionId: z.uuid().optional(),
  position: z.number().int().min(0).optional(),
});

export async function cardRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List cards
  typedApp.get(
    '/api/cards',
    {
      onRequest: [app.authenticate, requirePermission('cards:read')],
      schema: {
        tags: ['Cards'],
        summary: 'List cards',
        querystring: z.object({
          collectionId: z.uuid().optional(),
          assigneeId: z.uuid().optional(),
          search: z.string().optional(),
          completed: z.coerce.boolean().optional(),
          priority: z.enum(['high', 'medium', 'low']).optional(),
          dueDateBefore: z.string().optional(),
          dueDateAfter: z.string().optional(),
          tagId: z.uuid().optional(),
          countOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { entries, total } = await listCards({
        collectionId: request.query.collectionId,
        assigneeId: request.query.assigneeId,
        search: request.query.search,
        completed: request.query.completed,
        priority: request.query.priority,
        dueDateBefore: request.query.dueDateBefore,
        dueDateAfter: request.query.dueDateAfter,
        tagId: request.query.tagId,
        limit: request.query.countOnly ? 0 : request.query.limit,
        offset: request.query.countOnly ? 0 : request.query.offset,
      });

      if (request.query.countOnly) {
        return reply.send({ total });
      }

      return reply.send({
        total,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  // Get single card
  typedApp.get(
    '/api/cards/:id',
    {
      onRequest: [app.authenticate, requirePermission('cards:read')],
      schema: {
        tags: ['Cards'],
        summary: 'Get a single card by ID',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const card = await getCardById(request.params.id);
      if (!card) {
        return reply.notFound('Card not found');
      }
      return reply.send(card);
    },
  );

  // Create card
  typedApp.post(
    '/api/cards',
    {
      onRequest: [app.authenticate, requirePermission('cards:create')],
      schema: {
        tags: ['Cards'],
        summary: 'Create a new card',
        body: createCardBody,
      },
    },
    async (request, reply) => {
      const card = await createCard(request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(201).send(card);
    },
  );

  // Update card
  typedApp.patch(
    '/api/cards/:id',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Update an existing card',
        params: z.object({ id: z.uuid() }),
        body: updateCardBody,
      },
    },
    async (request, reply) => {
      const updated = await updateCard(request.params.id, request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!updated) {
        return reply.notFound('Card not found');
      }

      return reply.send(updated);
    },
  );

  // Delete card
  typedApp.delete(
    '/api/cards/:id',
    {
      onRequest: [app.authenticate, requirePermission('cards:delete')],
      schema: {
        tags: ['Cards'],
        summary: 'Delete a card',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = await deleteCard(request.params.id, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!deleted) {
        return reply.notFound('Card not found');
      }

      return reply.status(204).send();
    },
  );

  // Add tag to card
  typedApp.post(
    '/api/cards/:id/tags',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Add a tag to a card',
        params: z.object({ id: z.uuid() }),
        body: z.object({ tagId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const card = await getCardById(request.params.id);
      if (!card) {
        return reply.notFound('Card not found');
      }

      await addCardTag(request.params.id, request.body.tagId);
      return reply.status(201).send({ success: true });
    },
  );

  // Remove tag from card
  typedApp.delete(
    '/api/cards/:id/tags/:tagId',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Remove a tag from a card',
        params: z.object({ id: z.uuid(), tagId: z.uuid() }),
      },
    },
    async (request, reply) => {
      await removeCardTag(request.params.id, request.params.tagId);
      return reply.status(204).send();
    },
  );

  // Add linked card
  typedApp.post(
    '/api/cards/:id/links',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Link another card to this card',
        params: z.object({ id: z.uuid() }),
        body: z.object({ targetCardId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const card = await getCardById(request.params.id);
      if (!card) {
        return reply.notFound('Card not found');
      }

      if (request.params.id === request.body.targetCardId) {
        return reply.badRequest('Cannot link a card to itself');
      }

      const targetCard = await getCardById(request.body.targetCardId);
      if (!targetCard) {
        return reply.notFound('Target card not found');
      }

      const link = await addCardLink(request.params.id, request.body.targetCardId);
      return reply.status(201).send(link);
    },
  );

  // Remove linked card
  typedApp.delete(
    '/api/cards/:id/links/:linkId',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Remove a card link',
        params: z.object({ id: z.uuid(), linkId: z.uuid() }),
      },
    },
    async (request, reply) => {
      await removeCardLink(request.params.linkId);
      return reply.status(204).send();
    },
  );

  // List card comments
  typedApp.get(
    '/api/cards/:id/comments',
    {
      onRequest: [app.authenticate, requirePermission('cards:read')],
      schema: {
        tags: ['Cards'],
        summary: 'List comments on a card',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const card = await getCardById(request.params.id);
      if (!card) {
        return reply.notFound('Card not found');
      }

      const { entries, total } = await listCardComments(
        request.params.id,
        request.query.limit,
        request.query.offset,
      );

      return reply.send({
        total,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  // Create card comment
  typedApp.post(
    '/api/cards/:id/comments',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Add a comment to a card',
        params: z.object({ id: z.uuid() }),
        body: z.object({ content: z.string().min(1).max(5000) }),
      },
    },
    async (request, reply) => {
      const card = await getCardById(request.params.id);
      if (!card) {
        return reply.notFound('Card not found');
      }

      const comment = await createCardComment(
        request.params.id,
        request.body.content,
        {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
      );

      return reply.status(201).send(comment);
    },
  );

  // Update card comment
  typedApp.patch(
    '/api/cards/:id/comments/:commentId',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Update a comment on a card',
        params: z.object({ id: z.uuid(), commentId: z.uuid() }),
        body: z.object({ content: z.string().min(1).max(5000) }),
      },
    },
    async (request, reply) => {
      const updated = await updateCardComment(request.params.commentId, request.body.content, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!updated) {
        return reply.notFound('Comment not found');
      }

      return reply.send(updated);
    },
  );

  // Delete card comment
  typedApp.delete(
    '/api/cards/:id/comments/:commentId',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Delete a comment from a card',
        params: z.object({ id: z.uuid(), commentId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = await deleteCardComment(request.params.commentId, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!deleted) {
        return reply.notFound('Comment not found');
      }

      return reply.status(204).send();
    },
  );
}
