import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { getAgent } from '../services/agents.js';
import { uploadFile } from '../services/storage.js';
import { validateUploadedFile } from '../utils/file-validation.js';
import { createAgentRateLimiter } from '../lib/api-helpers.js';
import {
  listAgentConversations,
  listRecentAgentConversations,
  getAgentConversation,
  createAgentConversation,
  validateConversationOwnership,
  deleteAgentConversation,
  renameAgentConversation,
  markAgentConversationRead,
  saveAgentConversationMessage,
  enqueueAgentPrompt,
  getAgentQueuedPromptCount,
  isAgentBusy,
  canRespondToMessageStartImmediately,
  getConversationExecutionItems,
  updateQueueItem,
  retryQueueItem,
  deleteQueueItem,
  clearAgentConversationQueue,
  reorderQueueItems,
  getGlobalRunningAgentCount,
  getMaxConcurrentAgentLimit,
  getActiveMessagePath,
  editMessageAndBranch,
  switchBranch,
  AgentChatError,
} from '../services/agent-chat.js';
import { listAgentRuns } from '../services/agent-runs.js';
import { ApiError } from '../utils/api-errors.js';

// Rate limiter for agent prompt execution — shared across all requests in this process
export const promptRateLimiter = createAgentRateLimiter();

type ChatUploadAttachment = {
  type: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storagePath: string;
};

async function persistUploadedChatFiles(
  fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }>,
  options: { imagesOnly?: boolean } = {},
): Promise<ChatUploadAttachment[]> {
  const attachments: ChatUploadAttachment[] = [];
  const imagesOnly = options.imagesOnly ?? false;

  for (const filePart of fileParts) {
    const fileCheck = validateUploadedFile(filePart.mimetype, filePart.filename, {
      mode: imagesOnly ? 'strict' : 'nonExecutable',
    });
    if (!fileCheck.valid) {
      throw ApiError.badRequest('invalid_chat_upload', fileCheck.error!);
    }

    if (imagesOnly && !filePart.mimetype.startsWith('image/')) {
      throw ApiError.badRequest('chat_upload_images_only', 'Only image files are supported');
    }

    const ext = path.extname(filePart.filename) || '.jpg';
    const uniqueName = `${crypto.randomUUID()}${ext}`;
    const storagePath = '/chat-uploads';

    const entry = await uploadFile(storagePath, uniqueName, filePart.mimetype, filePart.buffer);

    attachments.push({
      type: filePart.mimetype.startsWith('image/') ? 'image' : 'file',
      fileName: filePart.filename,
      mimeType: filePart.mimetype,
      fileSize: filePart.buffer.length,
      storagePath: entry.path,
    });
  }

  return attachments;
}

function requireAgentExists(agentId: string) {
  const agent = getAgent(agentId);
  if (!agent) throw ApiError.notFound('agent_not_found', 'Agent not found');
  return agent;
}

function requireConversationExists(conversationId: string, agentId: string) {
  const conversation = validateConversationOwnership(conversationId, agentId);
  if (!conversation) {
    throw ApiError.notFound('conversation_not_found', 'Conversation not found');
  }
  return conversation;
}

function serializeActivePathEntries(conversationId: string) {
  return getActiveMessagePath(conversationId).map((msg) => ({
    ...msg,
    siblingIndex: msg._siblingIndex,
    siblingCount: msg._siblingCount,
    siblingIds: msg._siblingIds,
    _siblingIndex: undefined,
    _siblingCount: undefined,
    _siblingIds: undefined,
  }));
}

function requirePromptRateLimit(requestUserId: string, agentId: string) {
  const rateLimitKey = `${requestUserId}:${agentId}`;
  if (!promptRateLimiter.isAllowed(rateLimitKey)) {
    throw ApiError.tooMany(
      'agent_prompt_rate_limited',
      'Too many prompt requests. Please wait before sending another message.',
    );
  }
}

function toAgentChatApiError(error: AgentChatError): ApiError {
  if (error.statusCode === 404) {
    return ApiError.notFound(error.code, error.message, error.hint);
  }
  if (error.statusCode === 409) {
    return ApiError.conflict(error.code, error.message, error.hint);
  }
  return ApiError.badRequest(error.code, error.message, error.hint);
}

function rethrowAgentChatError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof AgentChatError) throw toAgentChatApiError(error);
  throw error;
}

export async function agentChatRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List recent agent chat conversations across all agents
  typedApp.get(
    '/api/agent-chat/recent',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'List recent agent chat conversations across all agents',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(8),
        }),
      },
    },
    async (request, reply) => {
      const result = listRecentAgentConversations(request.query.limit);
      return reply.send(result);
    },
  );

  // List conversations for an agent
  typedApp.get(
    '/api/agents/:id/chat/conversations',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'List chat conversations for an agent',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const { limit, offset } = request.query;
      const result = listAgentConversations(request.params.id, limit, offset);
      return reply.send(result);
    },
  );

  // Create a new conversation for an agent
  typedApp.post(
    '/api/agents/:id/chat/conversations',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Create a new chat conversation for an agent',
        params: z.object({ id: z.string() }),
        body: z.object({
          subject: z.string().max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const conv = createAgentConversation(request.params.id, request.body.subject);
      return reply.status(201).send(conv);
    },
  );

  // Get a single conversation for an agent
  typedApp.get(
    '/api/agents/:id/chat/conversations/:conversationId',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Get a single chat conversation for an agent',
        params: z.object({ id: z.string(), conversationId: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const conversation = getAgentConversation(request.params.id, request.params.conversationId);
      if (!conversation) {
        throw ApiError.notFound('conversation_not_found', 'Conversation not found');
      }

      return reply.send(conversation);
    },
  );

  // Rename a conversation
  typedApp.patch(
    '/api/agents/:id/chat/conversations/:conversationId',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Rename an agent chat conversation',
        params: z.object({ id: z.string(), conversationId: z.string() }),
        body: z.object({
          subject: z.string().min(1).max(200),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.conversationId, request.params.id);

      const updated = renameAgentConversation(request.params.conversationId, request.body.subject);
      return reply.send(updated);
    },
  );

  // Mark a conversation as read
  typedApp.patch(
    '/api/agents/:id/chat/conversations/:conversationId/read',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Mark an agent chat conversation as read',
        params: z.object({ id: z.string(), conversationId: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.conversationId, request.params.id);

      const updated = markAgentConversationRead(request.params.conversationId);
      return reply.send(updated);
    },
  );

  // Delete a conversation
  typedApp.delete(
    '/api/agents/:id/chat/conversations/:conversationId',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Delete an agent chat conversation and its messages',
        params: z.object({ id: z.string(), conversationId: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.conversationId, request.params.id);

      deleteAgentConversation(request.params.conversationId);
      return reply.status(204).send();
    },
  );

  // List chat messages for a specific conversation
  typedApp.get(
    '/api/agents/:id/chat/messages',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'List chat messages for an agent conversation',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          conversationId: z.string(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.query.conversationId, request.params.id);

      const entries = serializeActivePathEntries(request.query.conversationId);
      const { limit, offset } = request.query;
      const paged = entries.slice(offset, offset + limit);
      return reply.send({ total: entries.length, limit, offset, entries: paged });
    },
  );

  // Append a message to an agent chat conversation (for agent progress/final updates)
  typedApp.post(
    '/api/agents/:id/chat/messages',
    {
      onRequest: [app.authenticate, requirePermission('messages:send')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Append a message to an agent chat conversation',
        params: z.object({ id: z.string() }),
        body: z.object({
          conversationId: z.string(),
          content: z.string().min(1).max(50000),
          isFinal: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.body.conversationId, request.params.id);

      const message = saveAgentConversationMessage({
        conversationId: request.body.conversationId,
        direction: 'inbound',
        content: request.body.content,
        type: request.body.isFinal ? 'text' : 'system',
        metadata: (() => {
          const activeRun = listAgentRuns({
            status: 'running',
            agentId: request.params.id,
            conversationId: request.body.conversationId,
            limit: 1,
          }).entries[0];
          return {
            agentChatUpdate: true,
            isFinal: Boolean(request.body.isFinal),
            runId: activeRun?.id ?? null,
          };
        })(),
      });

      return reply.status(201).send(message);
    },
  );

  // Queue a prompt for backend processing
  typedApp.post(
    '/api/agents/:id/chat/message',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Queue a prompt for backend processing',
        params: z.object({ id: z.string() }),
        body: z.object({
          prompt: z.string().min(1).max(50000),
          conversationId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const userId = (request.user as { sub: string }).sub;
      requirePromptRateLimit(userId, request.params.id);
      requireConversationExists(request.body.conversationId, request.params.id);

      try {
        const wasQueuedOrBusy =
          isAgentBusy(request.params.id, request.body.conversationId) ||
          getAgentQueuedPromptCount(request.params.id, request.body.conversationId) > 0;
        const queued = enqueueAgentPrompt(
          request.params.id,
          request.body.conversationId,
          request.body.prompt,
        );
        const statusCode = wasQueuedOrBusy ? 202 : 201;
        return reply.status(statusCode).send({
          status: 'queued',
          queueItem: queued.queueItem,
          queuedCount: queued.queuedCount,
          concurrency: {
            running: getGlobalRunningAgentCount(),
            limit: getMaxConcurrentAgentLimit(),
          },
        });
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // List execution items for a conversation
  typedApp.get(
    '/api/agents/:id/chat/conversations/:cid/queue',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'List chat execution items for a conversation',
        params: z.object({ id: z.string(), cid: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      const items = getConversationExecutionItems(request.params.id, request.params.cid);
      return reply.send({ entries: items });
    },
  );

  // Clear all queued items for a conversation
  typedApp.delete(
    '/api/agents/:id/chat/conversations/:cid/queue',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Clear all pending queue items for a conversation',
        params: z.object({ id: z.string(), cid: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      const deleted = clearAgentConversationQueue(request.params.id, request.params.cid);
      return reply.send({ deleted });
    },
  );

  // Update a queued item (edit prompt)
  typedApp.patch(
    '/api/agents/:id/chat/queue/:itemId',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Edit a pending queue item',
        params: z.object({ id: z.string(), itemId: z.string() }),
        body: z.object({
          conversationId: z.string(),
          prompt: z.string().min(1).max(50000).optional(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.body.conversationId, request.params.id);

      try {
        const updated = updateQueueItem(
          request.params.itemId,
          request.params.id,
          request.body.conversationId,
          { prompt: request.body.prompt },
        );
        return reply.send(updated);
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Retry a failed or cancelled item
  typedApp.post(
    '/api/agents/:id/chat/queue/:itemId/retry',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Retry a failed or cancelled chat execution item',
        params: z.object({ id: z.string(), itemId: z.string() }),
        body: z.object({
          conversationId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.body.conversationId, request.params.id);

      try {
        const retried = retryQueueItem(
          request.params.itemId,
          request.params.id,
          request.body.conversationId,
        );
        return reply.send(retried);
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Delete a queued item
  typedApp.delete(
    '/api/agents/:id/chat/queue/:itemId',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Remove a pending queue item',
        params: z.object({ id: z.string(), itemId: z.string() }),
        body: z.object({
          conversationId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.body.conversationId, request.params.id);

      try {
        deleteQueueItem(request.params.itemId, request.params.id, request.body.conversationId);
        return reply.status(204).send();
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Reorder queued items
  typedApp.post(
    '/api/agents/:id/chat/conversations/:cid/queue/reorder',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Reorder pending queue items',
        params: z.object({ id: z.string(), cid: z.string() }),
        body: z.object({
          orderedIds: z.array(z.string()),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      try {
        reorderQueueItems(request.params.id, request.params.cid, request.body.orderedIds);
        return reply.send({ ok: true });
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Queue an agent response to the latest message (e.g. after image upload)
  typedApp.post(
    '/api/agents/:id/chat/respond',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary:
          'Queue an agent response to the latest conversation message (e.g. after image upload)',
        params: z.object({ id: z.string() }),
        body: z.object({
          conversationId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const userId = (request.user as { sub: string }).sub;
      requirePromptRateLimit(userId, request.params.id);
      requireConversationExists(request.body.conversationId, request.params.id);

      try {
        const activePath = getActiveMessagePath(request.body.conversationId);
        const leaf = activePath.length > 0 ? activePath[activePath.length - 1] : null;
        const targetMessageId = typeof leaf?.id === 'string' ? (leaf.id as string) : null;
        if (!targetMessageId) {
          throw ApiError.badRequest(
            'response_target_missing',
            'Conversation has no message to respond to',
          );
        }

        const willQueueBehind = !canRespondToMessageStartImmediately(
          request.params.id,
          request.body.conversationId,
          targetMessageId,
        );
        const queued = enqueueAgentPrompt(request.params.id, request.body.conversationId, '', {
          mode: 'respond_to_message',
          targetMessageId,
        });
        const statusCode = willQueueBehind ? 202 : 201;
        return reply.status(statusCode).send({
          status: 'queued',
          queueItem: queued.queueItem,
          queuedCount: queued.queuedCount,
          concurrency: {
            running: getGlobalRunningAgentCount(),
            limit: getMaxConcurrentAgentLimit(),
          },
        });
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Edit a user message and create a new branch
  typedApp.post(
    '/api/agents/:id/chat/conversations/:cid/edit-message',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Edit a user message and create a new conversation branch',
        params: z.object({ id: z.string(), cid: z.string() }),
        body: z.object({
          messageId: z.string(),
          content: z.string().max(50000),
          keepStoragePaths: z.array(z.string()).max(10).optional(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      const userId = (request.user as { sub: string }).sub;
      requirePromptRateLimit(userId, request.params.id);

      try {
        const newMessage = editMessageAndBranch(
          request.params.cid,
          request.body.messageId,
          request.body.content,
          { keepStoragePaths: request.body.keepStoragePaths },
        );

        // Queue the edited prompt for processing
        const willQueueBehind = !canRespondToMessageStartImmediately(
          request.params.id,
          request.params.cid,
          newMessage.id as string,
        );
        const queued = enqueueAgentPrompt(
          request.params.id,
          request.params.cid,
          request.body.content,
          {
            mode: 'respond_to_message',
            targetMessageId: newMessage.id as string,
          },
        );
        const statusCode = willQueueBehind ? 202 : 201;
        return reply.status(statusCode).send({
          message: newMessage,
          entries: serializeActivePathEntries(request.params.cid),
          queueItem: queued.queueItem,
          queuedCount: queued.queuedCount,
          concurrency: {
            running: getGlobalRunningAgentCount(),
            limit: getMaxConcurrentAgentLimit(),
          },
        });
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  typedApp.post(
    '/api/agents/:id/chat/conversations/:cid/edit-message-upload',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Edit a user message, attach images, and create a new conversation branch',
        params: z.object({ id: z.string(), cid: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      const userId = (request.user as { sub: string }).sub;
      requirePromptRateLimit(userId, request.params.id);

      const MAX_ATTACHMENTS = 10;
      const parts = request.parts();
      let messageId: string | undefined;
      let content = '';
      const keepStoragePaths: string[] = [];
      const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'messageId') messageId = part.value as string;
          else if (part.fieldname === 'content') content = (part.value as string) || '';
          else if (part.fieldname === 'keepStoragePaths' && typeof part.value === 'string') {
            keepStoragePaths.push(part.value);
          }
        } else if (part.type === 'file') {
          if (fileParts.length >= MAX_ATTACHMENTS) continue;
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

      if (!messageId) {
        throw ApiError.badRequest('message_id_required', 'messageId is required');
      }
      if (!content.trim() && fileParts.length === 0 && keepStoragePaths.length === 0) {
        throw ApiError.badRequest('message_content_required', 'Content or files are required');
      }

      try {
        const attachments = await persistUploadedChatFiles(fileParts, { imagesOnly: true });
        const newMessage = editMessageAndBranch(request.params.cid, messageId, content.trim(), {
          attachments,
          keepStoragePaths,
        });

        const willQueueBehind = !canRespondToMessageStartImmediately(
          request.params.id,
          request.params.cid,
          newMessage.id as string,
        );
        const queued = enqueueAgentPrompt(request.params.id, request.params.cid, content, {
          mode: 'respond_to_message',
          targetMessageId: newMessage.id as string,
        });
        const statusCode = willQueueBehind ? 202 : 201;
        return reply.status(statusCode).send({
          message: newMessage,
          entries: serializeActivePathEntries(request.params.cid),
          queueItem: queued.queueItem,
          queuedCount: queued.queuedCount,
          concurrency: {
            running: getGlobalRunningAgentCount(),
            limit: getMaxConcurrentAgentLimit(),
          },
        });
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Switch active branch at a message
  typedApp.post(
    '/api/agents/:id/chat/conversations/:cid/switch-branch',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Switch the active branch to a different sibling message',
        params: z.object({ id: z.string(), cid: z.string() }),
        body: z.object({
          messageId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      try {
        switchBranch(request.params.cid, request.body.messageId);
        const entries = serializeActivePathEntries(request.params.cid);
        return reply.send({ entries });
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Upload files to agent chat (up to 10)
  typedApp.post(
    '/api/agents/:id/chat/upload',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Upload up to 10 files to agent chat and create a message with the attachments',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const MAX_ATTACHMENTS = 10;
      const parts = request.parts();
      let conversationId: string | undefined;
      let caption: string | null = null;
      const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'conversationId') conversationId = part.value as string;
          else if (part.fieldname === 'caption') caption = (part.value as string) || null;
        } else if (part.type === 'file') {
          if (fileParts.length >= MAX_ATTACHMENTS) continue;
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

      if (fileParts.length === 0) {
        throw ApiError.badRequest('chat_upload_missing_files', 'No files uploaded');
      }
      if (!conversationId) {
        throw ApiError.badRequest('conversation_id_required', 'conversationId is required');
      }

      requireConversationExists(conversationId, request.params.id);

      const attachments = await persistUploadedChatFiles(fileParts);

      const messageType = attachments.every((attachment) => attachment.type === 'image')
        ? 'image'
        : 'file';

      const message = saveAgentConversationMessage({
        conversationId,
        direction: 'outbound',
        content: caption || '',
        type: messageType,
        attachments,
      });

      return reply.status(201).send(message);
    },
  );
}
