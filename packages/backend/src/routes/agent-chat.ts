import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  searchAgentMessages,
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
  editMessageAndBranch,
  switchBranch,
  switchBranchTurn,
  activateMessagePathForSearchResult,
  serializeAllConversationMessageEntries,
  enqueueAgentResponseToMessage,
  AgentChatError,
  resolveAgentChatProcessWorkingDirectory,
} from '../services/agent-chat.js';
import { listAgentRuns } from '../services/agent-runs.js';
import { getAgentConversationChatView } from '../services/agent-chat-view.js';
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

const MAX_CHAT_UPLOAD_ATTACHMENTS = 10;

const chatViewStatusSchema = z.enum([
  'queued',
  'processing',
  'completed',
  'failed',
  'stopped',
  'superseded',
]);
const chatViewActionSchema = z.enum([
  'edit_user_message',
  'edit_queue_item',
  'delete_queue_item',
  'retry',
  'stop',
  'switch_branch',
]);
const chatViewMessageSchema = z
  .object({
    id: z.string(),
    direction: z.enum(['inbound', 'outbound']),
    type: z.string(),
    content: z.string().nullable(),
    status: z.string().nullable(),
    metadata: z.unknown().nullable(),
    attachments: z.unknown().nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();
const chatViewQueueSchema = z
  .object({
    id: z.string(),
    turnId: z.string(),
    status: z.string(),
    position: z.number().nullable(),
    runId: z.string().nullable(),
    errorMessage: z.string().nullable(),
    attempts: z.number().nullable(),
    maxAttempts: z.number().nullable(),
    nextAttemptAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    usedFallback: z.boolean(),
    fallbackModel: z.string().nullable(),
  })
  .strict();
const chatViewRunSchema = z
  .object({
    id: z.string(),
    turnId: z.string().nullable(),
    status: z.string(),
    errorMessage: z.string().nullable(),
    responseText: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
  })
  .strict();
const chatViewSiblingSchema = z
  .object({
    turnId: z.string(),
    userMessageId: z.string().nullable(),
    status: chatViewStatusSchema,
    turnType: z.string(),
    supersedesTurnId: z.string().nullable(),
    isSelected: z.boolean(),
    createdAt: z.string().nullable(),
  })
  .strict();
const chatViewTurnSchema = z
  .object({
    id: z.string(),
    parentTurnId: z.string().nullable(),
    status: chatViewStatusSchema,
    turnType: z.string(),
    userMessage: chatViewMessageSchema.nullable(),
    assistantMessage: chatViewMessageSchema.nullable(),
    execution: z
      .object({
        queue: chatViewQueueSchema.nullable(),
        run: chatViewRunSchema.nullable(),
      })
      .strict(),
    branch: z
      .object({
        parentTurnId: z.string().nullable(),
        isSelected: z.boolean(),
        siblingIndex: z.number(),
        siblingCount: z.number(),
        siblingIds: z.array(z.string()),
        siblings: z.array(chatViewSiblingSchema),
      })
      .strict(),
    edit: z
      .object({
        supersedesTurnId: z.string().nullable(),
        supersededByTurnId: z.string().nullable(),
        isSuperseded: z.boolean(),
      })
      .strict(),
    availableActions: z.array(chatViewActionSchema),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict();
const agentConversationChatViewResponseSchema = z
  .object({
    conversationId: z.string(),
    agentId: z.string(),
    total: z.number(),
    entries: z.array(chatViewTurnSchema),
    branches: z.array(
      z
        .object({
          parentTurnId: z.string().nullable(),
          selectedTurnId: z.string().nullable(),
          turnIds: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

function chatAttachmentLimitExceededError() {
  return ApiError.badRequest(
    'chat_attachment_limit_exceeded',
    `A chat message can include up to ${MAX_CHAT_UPLOAD_ATTACHMENTS} attachments`,
    `Remove extra files and try again with ${MAX_CHAT_UPLOAD_ATTACHMENTS} or fewer attachments.`,
  );
}

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

function serializeCanonicalMessageEntries(agentId: string, conversationId: string) {
  const view = getAgentConversationChatView(agentId, conversationId);
  return view.entries.flatMap((turn) =>
    [turn.userMessage, turn.assistantMessage].flatMap((message) => {
      if (!message) return [];
      return {
        id: message.id,
        direction: message.direction,
        type: message.type,
        content: message.content ?? '',
        status: message.status,
        metadata: message.metadata,
        attachments: message.attachments,
        createdAt: message.createdAt ?? turn.createdAt,
        updatedAt: message.updatedAt,
        parentId: message.direction === 'inbound' ? (turn.userMessage?.id ?? null) : null,
        previousUserMessageId: null,
        turnId: turn.id,
        turnStatus: turn.status,
        turnType: turn.turnType,
        availableActions: turn.availableActions,
      };
    }),
  );
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

function revealPathInFileManager(diskPath: string) {
  const platform = process.platform;
  if (platform === 'darwin') {
    const stat = fs.statSync(diskPath);
    if (stat.isDirectory()) {
      spawn('open', [diskPath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('open', ['-R', diskPath], { detached: true, stdio: 'ignore' }).unref();
    }
    return;
  }

  if (platform === 'win32') {
    spawn('explorer', [`/select,${diskPath}`], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const stat = fs.statSync(diskPath);
  const dir = stat.isDirectory() ? diskPath : path.dirname(diskPath);
  spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
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
      const result = await listRecentAgentConversations(request.query.limit);
      return reply.send(result);
    },
  );

  // Search messages across all agent chat conversations
  typedApp.get(
    '/api/agent-chat/search',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Search messages across all agent chat conversations',
        querystring: z.object({
          q: z.string().min(1).max(200),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
      },
    },
    async (request, reply) => {
      const result = await searchAgentMessages(request.query.q, request.query.limit);
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

  typedApp.get(
    '/api/agents/:id/chat/conversations/:conversationId/view',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Get canonical chat turn view for an agent conversation',
        params: z.object({ id: z.string(), conversationId: z.string() }),
        response: {
          200: agentConversationChatViewResponseSchema,
        },
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.conversationId, request.params.id);

      const view = getAgentConversationChatView(request.params.id, request.params.conversationId);
      return reply.send(view);
    },
  );

  typedApp.post(
    '/api/agents/:id/chat/conversations/:conversationId/reveal-folder',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Reveal a conversation subfolder in the OS file manager',
        params: z.object({ id: z.string(), conversationId: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.conversationId, request.params.id);

      const conversation = getAgentConversation(request.params.id, request.params.conversationId);
      if (!conversation) {
        throw ApiError.notFound('conversation_not_found', 'Conversation not found');
      }
      if (conversation.workspaceMode !== 'subfolder') {
        throw ApiError.conflict(
          'conversation_folder_unavailable',
          'This conversation does not use a dedicated subfolder',
        );
      }

      const diskPath = resolveAgentChatProcessWorkingDirectory(
        request.params.id,
        request.params.conversationId,
      );
      revealPathInFileManager(diskPath);
      return reply.status(204).send();
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

      await deleteAgentConversation(request.params.conversationId);
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
          scope: z.enum(['active', 'all']).default('active'),
          limit: z.coerce.number().int().min(1).max(2000).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.query.conversationId, request.params.id);

      const entries =
        request.query.scope === 'all'
          ? serializeAllConversationMessageEntries(request.query.conversationId)
          : serializeCanonicalMessageEntries(request.params.id, request.query.conversationId);
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

      const running = await listAgentRuns({
        status: 'running',
        agentId: request.params.id,
        conversationId: request.body.conversationId,
        limit: 1,
      });
      const activeRun = running.entries[0];

      const message = saveAgentConversationMessage({
        conversationId: request.body.conversationId,
        direction: 'inbound',
        content: request.body.content,
        type: request.body.isFinal ? 'text' : 'system',
        metadata: {
          agentChatUpdate: true,
          isFinal: Boolean(request.body.isFinal),
          runId: activeRun?.id ?? null,
        },
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
          messageId: z.string(),
          previousUserMessageId: z.string().nullable().optional(),
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
          {
            queuedMessageId: request.body.messageId,
            previousUserMessageId: request.body.previousUserMessageId ?? null,
            createdById: userId,
          },
        );
        const statusCode = wasQueuedOrBusy ? 202 : 201;
        return reply.status(statusCode).send({
          status: 'queued',
          message: queued.userMessage,
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
          prompt: z.string().max(50000).optional(),
          keepStoragePaths: z.array(z.string()).optional(),
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
          {
            prompt: request.body.prompt,
            keepStoragePaths: request.body.keepStoragePaths,
          },
        );
        return reply.send(updated);
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  typedApp.post(
    '/api/agents/:id/chat/queue/:itemId/upload',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Edit a pending queue item and attach files',
        params: z.object({ id: z.string(), itemId: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const parts = request.parts();
      let conversationId: string | undefined;
      let prompt: string | undefined;
      const keepStoragePaths: string[] = [];
      const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];
      let uploadedFileCount = 0;

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'conversationId') conversationId = part.value as string;
          else if (part.fieldname === 'prompt') prompt = (part.value as string) || '';
          else if (part.fieldname === 'keepStoragePaths' && typeof part.value === 'string') {
            keepStoragePaths.push(part.value);
          }
        } else if (part.type === 'file') {
          uploadedFileCount += 1;
          if (uploadedFileCount > MAX_CHAT_UPLOAD_ATTACHMENTS) {
            throw chatAttachmentLimitExceededError();
          }
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          fileParts.push({
            mimetype: part.mimetype || 'application/octet-stream',
            filename: part.filename || 'file',
            buffer: Buffer.concat(chunks),
          });
        }
      }

      if (!conversationId) {
        throw ApiError.badRequest('conversation_id_required', 'conversationId is required');
      }
      requireConversationExists(conversationId, request.params.id);

      try {
        const attachments = await persistUploadedChatFiles(fileParts);
        const updated = updateQueueItem(request.params.itemId, request.params.id, conversationId, {
          prompt,
          attachments,
          keepStoragePaths,
        });
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
          targetMessageId: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const userId = (request.user as { sub: string }).sub;
      requirePromptRateLimit(userId, request.params.id);
      requireConversationExists(request.body.conversationId, request.params.id);

      try {
        const queued = enqueueAgentResponseToMessage(
          request.params.id,
          request.body.conversationId,
          {
            targetMessageId: request.body.targetMessageId ?? null,
            createdById: userId,
          },
        );
        const statusCode = queued.willQueueBehind ? 202 : 201;
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
          originalMessageId: z.string(),
          newMessageId: z.string(),
          previousUserMessageId: z.string().nullable().optional(),
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
          request.body.originalMessageId,
          request.body.content,
          {
            newMessageId: request.body.newMessageId,
            previousUserMessageId: request.body.previousUserMessageId ?? null,
            keepStoragePaths: request.body.keepStoragePaths,
          },
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
            createdById: userId,
            turnType: 'edit',
            supersedesMessageId: request.body.originalMessageId,
          },
        );
        const statusCode = willQueueBehind ? 202 : 201;
        return reply.status(statusCode).send({
          message: newMessage,
          entries: serializeCanonicalMessageEntries(request.params.id, request.params.cid),
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
        summary: 'Edit a user message, attach files, and create a new conversation branch',
        params: z.object({ id: z.string(), cid: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      const userId = (request.user as { sub: string }).sub;
      requirePromptRateLimit(userId, request.params.id);

      const parts = request.parts();
      let originalMessageId: string | undefined;
      let newMessageId: string | undefined;
      let previousUserMessageId: string | null = null;
      let content = '';
      const keepStoragePaths: string[] = [];
      const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];
      let uploadedFileCount = 0;

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'messageId') originalMessageId = part.value as string;
          else if (part.fieldname === 'newMessageId') newMessageId = part.value as string;
          else if (part.fieldname === 'previousUserMessageId') {
            previousUserMessageId = ((part.value as string) || '').trim() || null;
          } else if (part.fieldname === 'content') {
            content = (part.value as string) || '';
          } else if (part.fieldname === 'keepStoragePaths' && typeof part.value === 'string') {
            keepStoragePaths.push(part.value);
          }
        } else if (part.type === 'file') {
          uploadedFileCount += 1;
          if (uploadedFileCount > MAX_CHAT_UPLOAD_ATTACHMENTS) {
            throw chatAttachmentLimitExceededError();
          }
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

      if (!originalMessageId) {
        throw ApiError.badRequest('message_id_required', 'messageId is required');
      }
      if (!newMessageId) {
        throw ApiError.badRequest('new_message_id_required', 'newMessageId is required');
      }
      if (!content.trim() && fileParts.length === 0 && keepStoragePaths.length === 0) {
        throw ApiError.badRequest('message_content_required', 'Content or files are required');
      }

      try {
        const attachments = await persistUploadedChatFiles(fileParts);
        const newMessage = editMessageAndBranch(
          request.params.cid,
          originalMessageId,
          content.trim(),
          {
            newMessageId,
            previousUserMessageId,
            attachments,
            keepStoragePaths,
          },
        );

        const willQueueBehind = !canRespondToMessageStartImmediately(
          request.params.id,
          request.params.cid,
          newMessage.id as string,
        );
        const queued = enqueueAgentPrompt(request.params.id, request.params.cid, content, {
          mode: 'respond_to_message',
          targetMessageId: newMessage.id as string,
          createdById: userId,
          turnType: 'edit',
          supersedesMessageId: originalMessageId,
        });
        const statusCode = willQueueBehind ? 202 : 201;
        return reply.status(statusCode).send({
          message: newMessage,
          entries: serializeCanonicalMessageEntries(request.params.id, request.params.cid),
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

  // Activate the branch path containing a message, used when jumping from search results.
  typedApp.post(
    '/api/agents/:id/chat/conversations/:cid/activate-message',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Activate the branch path containing a chat message',
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
        activateMessagePathForSearchResult(request.params.cid, request.body.messageId);
        const entries = serializeCanonicalMessageEntries(request.params.id, request.params.cid);
        return reply.send({ entries });
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
        body: z
          .object({
            messageId: z.string().optional(),
            turnId: z.string().optional(),
          })
          .refine((body) => Boolean(body.messageId || body.turnId), {
            message: 'messageId or turnId is required',
          }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);
      requireConversationExists(request.params.cid, request.params.id);

      try {
        if (request.body.turnId) {
          switchBranchTurn(request.params.cid, request.body.turnId);
        } else {
          switchBranch(request.params.cid, request.body.messageId!);
        }
        const entries = serializeCanonicalMessageEntries(request.params.id, request.params.cid);
        return reply.send({ entries });
      } catch (err) {
        rethrowAgentChatError(err);
      }
    },
  );

  // Upload files to agent chat and queue an agent response in one request (up to 10)
  typedApp.post(
    '/api/agents/:id/chat/upload-and-respond',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Upload up to 10 files to agent chat and queue an agent response',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      requireAgentExists(request.params.id);

      const userId = (request.user as { sub: string }).sub;
      requirePromptRateLimit(userId, request.params.id);

      const parts = request.parts();
      let conversationId: string | undefined;
      let messageId: string | undefined;
      let previousUserMessageId: string | null = null;
      let caption: string | null = null;
      const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];
      let uploadedFileCount = 0;

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'conversationId') conversationId = part.value as string;
          else if (part.fieldname === 'messageId') messageId = part.value as string;
          else if (part.fieldname === 'previousUserMessageId') {
            previousUserMessageId = ((part.value as string) || '').trim() || null;
          } else if (part.fieldname === 'caption') {
            caption = (part.value as string) || null;
          }
        } else if (part.type === 'file') {
          uploadedFileCount += 1;
          if (uploadedFileCount > MAX_CHAT_UPLOAD_ATTACHMENTS) {
            throw chatAttachmentLimitExceededError();
          }
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
      if (!messageId) {
        throw ApiError.badRequest('message_id_required', 'messageId is required');
      }

      requireConversationExists(conversationId, request.params.id);

      try {
        const attachments = await persistUploadedChatFiles(fileParts);

        const wasQueuedOrBusy =
          isAgentBusy(request.params.id, conversationId) ||
          getAgentQueuedPromptCount(request.params.id, conversationId) > 0;
        const queued = enqueueAgentPrompt(request.params.id, conversationId, caption || '', {
          queuedMessageId: messageId,
          previousUserMessageId,
          attachments,
          createdById: userId,
        });
        const statusCode = wasQueuedOrBusy ? 202 : 201;
        return reply.status(statusCode).send({
          status: 'queued',
          message: queued.userMessage,
          entries: serializeCanonicalMessageEntries(request.params.id, conversationId),
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

      const parts = request.parts();
      let conversationId: string | undefined;
      let messageId: string | undefined;
      let previousUserMessageId: string | null = null;
      let caption: string | null = null;
      const fileParts: Array<{ mimetype: string; filename: string; buffer: Buffer }> = [];
      let uploadedFileCount = 0;

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'conversationId') conversationId = part.value as string;
          else if (part.fieldname === 'messageId') messageId = part.value as string;
          else if (part.fieldname === 'previousUserMessageId') {
            previousUserMessageId = ((part.value as string) || '').trim() || null;
          } else if (part.fieldname === 'caption') {
            caption = (part.value as string) || null;
          }
        } else if (part.type === 'file') {
          uploadedFileCount += 1;
          if (uploadedFileCount > MAX_CHAT_UPLOAD_ATTACHMENTS) {
            throw chatAttachmentLimitExceededError();
          }
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
      if (!messageId) {
        throw ApiError.badRequest('message_id_required', 'messageId is required');
      }

      requireConversationExists(conversationId, request.params.id);

      const attachments = await persistUploadedChatFiles(fileParts);

      const messageType = attachments.every((attachment) => attachment.type === 'image')
        ? 'image'
        : 'file';

      const message = saveAgentConversationMessage({
        id: messageId,
        conversationId,
        direction: 'outbound',
        content: caption || '',
        type: messageType,
        attachments,
        previousUserMessageId,
      });

      return reply.status(201).send(message);
    },
  );
}
