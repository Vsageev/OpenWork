import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { cardCustomFieldsSchema } from '../schemas/cards.js';
import { validateUploadedFile } from '../utils/file-validation.js';
import { uploadFile } from '../services/storage.js';
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
  customFields: cardCustomFieldsSchema.optional(),
  assigneeId: z.uuid().nullable().optional(),
  position: z.number().int().min(0).optional(),
});

const updateCardBody = z.object({
  name: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  customFields: cardCustomFieldsSchema.optional(),
  assigneeId: z.uuid().nullable().optional(),
  collectionId: z.uuid().optional(),
  position: z.number().int().min(0).optional(),
});

const MAX_CARD_IMAGE_UPLOADS = 10;

async function uploadCardImages(
  request: FastifyRequest,
  maxImages = MAX_CARD_IMAGE_UPLOADS,
) {
  const parts = request.parts();
  const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];

  for await (const part of parts) {
    if (part.type !== 'file') continue;
    if (fileParts.length >= maxImages) continue;

    const chunks: Buffer[] = [];
    for await (const chunk of part.file) {
      chunks.push(chunk);
    }

    fileParts.push({
      mimetype: part.mimetype || 'application/octet-stream',
      filename: part.filename || 'image.jpg',
      buffer: Buffer.concat(chunks),
    });
  }

  if (fileParts.length === 0) {
    throw new Error('No files uploaded');
  }

  const uploads: Array<{
    fileName: string;
    mimeType: string;
    fileSize: number;
    storagePath: string;
  }> = [];

  for (const filePart of fileParts) {
    const fileCheck = validateUploadedFile(filePart.mimetype, filePart.filename);
    if (!fileCheck.valid) throw new Error(fileCheck.error!);

    if (!filePart.mimetype.startsWith('image/')) {
      throw new Error('Only image files are supported');
    }

    const ext = path.extname(filePart.filename) || '.jpg';
    const uniqueName = `${crypto.randomUUID()}${ext}`;
    const storagePath = '/card-uploads';
    const entry = await uploadFile(storagePath, uniqueName, filePart.mimetype, filePart.buffer);

    uploads.push({
      fileName: filePart.filename,
      mimeType: filePart.mimetype,
      fileSize: filePart.buffer.length,
      storagePath: entry.path,
    });
  }

  return uploads;
}

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

  // Upload images to a card comment (up to 10)
  typedApp.post(
    '/api/cards/:id/comments/upload',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Upload up to 10 images and create a comment with attachments',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const card = await getCardById(request.params.id);
      if (!card) return reply.notFound('Card not found');

      const parts = request.parts();
      let caption: string | null = null;
      const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'caption') caption = (part.value as string) || null;
        } else if (part.type === 'file') {
          if (fileParts.length >= MAX_CARD_IMAGE_UPLOADS) continue;
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          fileParts.push({
            mimetype: part.mimetype || 'application/octet-stream',
            filename: part.filename || 'image.jpg',
            buffer: Buffer.concat(chunks),
          });
        }
      }

      if (fileParts.length === 0) return reply.badRequest('No files uploaded');

      const attachments: Array<{
        type: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        storagePath: string;
      }> = [];

      for (const filePart of fileParts) {
        const fileCheck = validateUploadedFile(filePart.mimetype, filePart.filename);
        if (!fileCheck.valid) return reply.badRequest(fileCheck.error!);

        if (!filePart.mimetype.startsWith('image/')) {
          return reply.badRequest('Only image files are supported');
        }

        const ext = path.extname(filePart.filename) || '.jpg';
        const uniqueName = `${crypto.randomUUID()}${ext}`;
        const storagePath = '/card-uploads';

        const entry = await uploadFile(storagePath, uniqueName, filePart.mimetype, filePart.buffer);

        attachments.push({
          type: 'image',
          fileName: filePart.filename,
          mimeType: filePart.mimetype,
          fileSize: filePart.buffer.length,
          storagePath: entry.path,
        });
      }

      const comment = await createCardComment(
        request.params.id,
        caption || '',
        {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
        attachments,
      );

      return reply.status(201).send(comment);
    },
  );

  typedApp.post(
    '/api/cards/description/images/upload',
    {
      onRequest: [app.authenticate, requirePermission('cards:create')],
      schema: {
        tags: ['Cards'],
        summary: 'Upload up to 10 images for new card description markdown',
      },
    },
    async (request, reply) => {
      try {
        const uploads = await uploadCardImages(request);
        return reply.status(201).send({
          images: uploads.map((upload) => ({
            ...upload,
            markdown: `![${upload.fileName}](/api/storage/download?path=${encodeURIComponent(upload.storagePath)})`,
          })),
        });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  typedApp.post(
    '/api/cards/:id/description/images/upload',
    {
      onRequest: [app.authenticate, requirePermission('cards:update')],
      schema: {
        tags: ['Cards'],
        summary: 'Upload up to 10 images for card description markdown',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const card = await getCardById(request.params.id);
      if (!card) return reply.notFound('Card not found');

      try {
        const uploads = await uploadCardImages(request);
        return reply.status(201).send({
          images: uploads.map((upload) => ({
            ...upload,
            markdown: `![${upload.fileName}](/api/storage/download?path=${encodeURIComponent(upload.storagePath)})`,
          })),
        });
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
