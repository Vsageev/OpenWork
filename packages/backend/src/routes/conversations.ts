import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  listConversations,
  getConversationById,
  createConversation,
  updateConversation,
  markConversationRead,
  markAllConversationsRead,
  deleteConversation,
} from '../services/conversations.js';
import { ApiError } from '../utils/api-errors.js';
import { eventBus } from '../services/event-bus.js';

const createConversationBody = z.object({
  contactId: z.uuid(),
  assigneeId: z.uuid().optional(),
  channelType: z.enum(['telegram', 'internal', 'other', 'email', 'web_chat']),
  status: z.enum(['open', 'closed', 'archived']).optional(),
  subject: z.string().max(255).optional(),
  externalId: z.string().max(255).optional(),
  metadata: z.string().optional(),
});

const updateConversationBody = z.object({
  assigneeId: z.uuid().nullable().optional(),
  status: z.enum(['open', 'closed', 'archived']).optional(),
  subject: z.string().max(255).nullable().optional(),
  isUnread: z.boolean().optional(),
  metadata: z.string().nullable().optional(),
});

export async function conversationRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List conversations
  typedApp.get(
    '/api/conversations',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Conversations'],
        summary: 'List conversations',
        querystring: z.object({
          contactId: z.string().optional(),
          assigneeId: z.string().optional(),
          channelType: z.string().optional(),
          status: z.string().optional(),
          isUnread: z.coerce.boolean().optional(),
          search: z.string().optional(),
          countOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { entries, total } = await listConversations({
        contactId: request.query.contactId,
        assigneeId: request.query.assigneeId,
        channelType: request.query.channelType,
        status: request.query.status,
        isUnread: request.query.isUnread,
        search: request.query.search,
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

  // Get single conversation
  typedApp.get(
    '/api/conversations/:id',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Conversations'],
        summary: 'Get a single conversation by ID',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const conversation = await getConversationById(request.params.id);
      if (!conversation) {
        return reply.notFound('Conversation not found');
      }
      return reply.send(conversation);
    },
  );

  // Create conversation
  typedApp.post(
    '/api/conversations',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Conversations'],
        summary: 'Create a new conversation',
        body: createConversationBody,
      },
    },
    async (request, reply) => {
      const conversation = await createConversation(request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      }) as any;

      // Emit automation trigger
      eventBus.emit('conversation_created', {
        conversationId: conversation.id,
        contactId: request.body.contactId,
        conversation: conversation as unknown as Record<string, unknown>,
      });

      return reply.status(201).send(conversation);
    },
  );

  // Update conversation
  typedApp.patch(
    '/api/conversations/:id',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Conversations'],
        summary: 'Update an existing conversation',
        params: z.object({ id: z.uuid() }),
        body: updateConversationBody,
      },
    },
    async (request, reply) => {
      const updated = await updateConversation(request.params.id, request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!updated) {
        return reply.notFound('Conversation not found');
      }

      return reply.send(updated);
    },
  );

  // Delete conversation
  typedApp.delete(
    '/api/conversations/:id',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Conversations'],
        summary: 'Delete a conversation and its messages',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = await deleteConversation(request.params.id, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!deleted) {
        throw ApiError.notFound('conversation_not_found', `Conversation ${request.params.id} not found`);
      }

      return reply.status(204).send();
    },
  );

  // Mark all conversations as read
  typedApp.post(
    '/api/conversations/read-all',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Conversations'],
        summary: 'Mark all conversations as read',
      },
    },
    async (_request, reply) => {
      const count = markAllConversationsRead();
      return reply.send({ count });
    },
  );

  // Mark conversation as read
  typedApp.post(
    '/api/conversations/:id/read',
    {
      onRequest: [app.authenticate, requirePermission('messages:read')],
      schema: {
        tags: ['Conversations'],
        summary: 'Mark a conversation as read',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const updated = await markConversationRead(request.params.id);
      if (!updated) {
        return reply.notFound('Conversation not found');
      }
      return reply.send(updated);
    },
  );
}
