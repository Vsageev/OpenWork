import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  listMessages,
  getMessageById,
  sendMessage,
  updateMessageStatus,
} from '../services/messages.js';
import { sendTelegramMessage } from '../services/telegram-outbound.js';
import { eventBus } from '../services/event-bus.js';
import { getConversationById } from '../services/conversations.js';
import type { Conversation, Message } from '../db/types.js';

const inlineKeyboardButtonSchema = z.object({
  text: z.string().min(1),
  url: z.string().url().optional(),
  callback_data: z.string().max(64).optional(),
});

const sendMessageBody = z.object({
  conversationId: z.uuid(),
  direction: z.enum(['inbound', 'outbound']),
  type: z
    .enum(['text', 'image', 'video', 'document', 'voice', 'sticker', 'location', 'system'])
    .optional(),
  content: z.string().optional(),
  externalId: z.string().optional(),
  attachments: z.any().optional(),
  metadata: z.string().optional(),
  parseMode: z.enum(['HTML', 'MarkdownV2']).optional(),
  inlineKeyboard: z.array(z.array(inlineKeyboardButtonSchema)).optional(),
});

const updateStatusBody = z.object({
  status: z.enum(['pending', 'sent', 'delivered', 'read', 'failed']),
});

export async function messageRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List messages for a conversation
  typedApp.get(
    '/api/messages',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Messages'],
        summary: 'List messages for a conversation',
        querystring: z.object({
          conversationId: z.string(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      if (!request.query.conversationId) {
        return reply.badRequest('conversationId query parameter is required');
      }

      const { entries, total } = await listMessages({
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

  // Get single message
  typedApp.get(
    '/api/messages/:id',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Messages'],
        summary: 'Get a single message by ID',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const message = await getMessageById(request.params.id);
      if (!message) {
        return reply.notFound('Message not found');
      }
      return reply.send(message);
    },
  );

  // Send a message
  typedApp.post(
    '/api/messages',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Messages'],
        summary: 'Send a message',
        body: sendMessageBody,
      },
    },
    async (request, reply) => {
      const { parseMode, inlineKeyboard, ...messageData } = request.body;

      // Store inline keyboard and parse mode in metadata if provided
      let metadata = messageData.metadata;
      if (parseMode || inlineKeyboard) {
        const existing = metadata ? JSON.parse(metadata) as Record<string, unknown> : {};
        if (parseMode) existing.parseMode = parseMode;
        if (inlineKeyboard) existing.inlineKeyboard = inlineKeyboard;
        metadata = JSON.stringify(existing);
      }

      const message = await sendMessage(
        {
          ...messageData,
          metadata,
          senderId: request.user.sub,
        },
        {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
      ) as Message | null;

      if (!message) {
        return reply.notFound('Conversation not found');
      }

      // Emit automation trigger for inbound messages
      if (request.body.direction === 'inbound') {
        const conversation = await getConversationById(request.body.conversationId) as Conversation | null;
        if (conversation) {
          eventBus.emit('message_received', {
            messageId: message.id,
            conversationId: conversation.id,
            contactId: conversation.contactId,
            message: message as unknown as Record<string, unknown>,
          });
        }
      }

      // For outbound messages, attempt to deliver via the appropriate channel
      if (request.body.direction === 'outbound' && message.content) {
        const conversation = await getConversationById(request.body.conversationId) as Conversation | null;

        if (conversation?.channelType === 'telegram') {
          sendTelegramMessage({
            conversationId: request.body.conversationId,
            messageId: message.id,
            text: message.content,
            parseMode,
            inlineKeyboard,
          }).catch((err: unknown) => {
            app.log.error(err, 'Failed to send Telegram message');
          });
        }
      }

      return reply.status(201).send(message);
    },
  );

  // Update message status
  typedApp.patch(
    '/api/messages/:id/status',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Messages'],
        summary: 'Update message status',
        params: z.object({ id: z.uuid() }),
        body: updateStatusBody,
      },
    },
    async (request, reply) => {
      const updated = await updateMessageStatus(request.params.id, request.body.status);
      if (!updated) {
        return reply.notFound('Message not found');
      }

      return reply.send(updated);
    },
  );
}
