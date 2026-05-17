import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  listDrafts,
  getDraftById,
  upsertDraft,
  deleteDraft,
} from '../services/message-drafts.js';
import { sendMessage } from '../services/messages.js';
import { getConversationById } from '../services/conversations.js';
import { sendTelegramMessage } from '../services/telegram-outbound.js';
import { ApiError } from '../utils/api-errors.js';
import type { Conversation, Message } from '../db/types.js';

const upsertDraftBody = z.object({
  conversationId: z.uuid(),
  content: z.string(),
  attachments: z.any().optional(),
  metadata: z.string().optional(),
});

export async function messageDraftRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List drafts
  typedApp.get(
    '/api/message-drafts',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Message Drafts'],
        summary: 'List message drafts',
        querystring: z.object({
          conversationId: z.string().optional(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { entries, total } = await listDrafts({
        conversationId: request.query.conversationId,
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

  // Get single draft
  typedApp.get(
    '/api/message-drafts/:id',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Message Drafts'],
        summary: 'Get a single message draft by ID',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const draft = await getDraftById(request.params.id);
      if (!draft) {
        throw ApiError.notFound('draft_not_found', `Draft ${request.params.id} not found`);
      }
      return reply.send(draft);
    },
  );

  // Upsert draft
  typedApp.put(
    '/api/message-drafts',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Message Drafts'],
        summary: 'Create or update a message draft (one per conversation)',
        body: upsertDraftBody,
      },
    },
    async (request, reply) => {
      const draft = await upsertDraft(request.body);
      if (!draft) {
        throw ApiError.notFound(
          'conversation_not_found',
          `Conversation ${request.body.conversationId} not found`,
        );
      }
      return reply.send(draft);
    },
  );

  // Delete draft
  typedApp.delete(
    '/api/message-drafts/:id',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Message Drafts'],
        summary: 'Delete a message draft',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = await deleteDraft(request.params.id);
      if (!deleted) {
        throw ApiError.notFound('draft_not_found', `Draft ${request.params.id} not found`);
      }
      return reply.status(204).send();
    },
  );

  // Send draft
  typedApp.post(
    '/api/message-drafts/:id/send',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Message Drafts'],
        summary: 'Send a draft as a message, then delete the draft',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const draft = await getDraftById(request.params.id);
      if (!draft) {
        throw ApiError.notFound('draft_not_found', `Draft ${request.params.id} not found`);
      }

      const conversationId = draft.conversationId as string;
      const content = draft.content as string;

      const message = await sendMessage(
        {
          conversationId,
          senderId: request.user.sub,
          direction: 'outbound',
          type: 'text',
          content,
          attachments: draft.attachments as unknown,
          metadata: draft.metadata as string | undefined,
        },
        {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
      ) as Message | null;

      if (!message) {
        throw ApiError.notFound('conversation_not_found', `Conversation ${conversationId} not found`);
      }

      // Delete the draft
      await deleteDraft(request.params.id);

      // Fire-and-forget channel delivery
      const conversation = await getConversationById(conversationId) as Conversation | null;
      if (conversation && content) {
        if (conversation.channelType === 'telegram') {
          sendTelegramMessage({
            conversationId,
            messageId: message.id,
            text: content,
          }).catch((err: unknown) => {
            app.log.error(err, 'Failed to send Telegram message from draft');
          });
        }
      }

      return reply.status(201).send(message);
    },
  );
}
