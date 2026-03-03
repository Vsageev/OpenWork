import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { store } from '../db/index.js';
import { getAgent } from '../services/agents.js';
import { uploadFile } from '../services/storage.js';
import { validateUploadedFile } from '../utils/file-validation.js';
import { createAgentRateLimiter } from '../lib/api-helpers.js';
import {
  listAgentConversations,
  createAgentConversation,
  validateConversationOwnership,
  deleteAgentConversation,
  renameAgentConversation,
  markAgentConversationRead,
  saveAgentConversationMessage,
  executePrompt,
  executeRespondToLastMessage,
  isAgentBusy,
  subscribeToRunOutput,
} from '../services/agent-chat.js';

// Rate limiter for agent prompt execution — shared across all requests in this process
const promptRateLimiter = createAgentRateLimiter();

function attachSocketErrorHandler(request: FastifyRequest, reply: FastifyReply) {
  reply.raw.socket?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') request.log.error(err);
  });
}

function safeSseWrite(request: FastifyRequest, reply: FastifyReply, payload: string) {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;
  try {
    reply.raw.write(payload);
    return true;
  } catch (err) {
    const socketErr = err as NodeJS.ErrnoException;
    if (socketErr.code !== 'EPIPE' && socketErr.code !== 'ERR_STREAM_WRITE_AFTER_END') {
      request.log.error(socketErr);
    }
    return false;
  }
}

function safeSseEnd(request: FastifyRequest, reply: FastifyReply) {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  try {
    reply.raw.end();
  } catch (err) {
    const socketErr = err as NodeJS.ErrnoException;
    if (socketErr.code !== 'EPIPE' && socketErr.code !== 'ERR_STREAM_WRITE_AFTER_END') {
      request.log.error(socketErr);
    }
  }
}

export async function agentChatRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

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
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

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
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const conv = createAgentConversation(request.params.id, request.body.subject);
      return reply.status(201).send(conv);
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
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const conv = validateConversationOwnership(request.params.conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

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
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const conv = validateConversationOwnership(request.params.conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

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
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const conv = validateConversationOwnership(request.params.conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

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
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const conv = validateConversationOwnership(request.query.conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

      const all = store
        .find(
          'messages',
          (r: Record<string, unknown>) => r.conversationId === request.query.conversationId,
        )
        .sort(
          (a: Record<string, unknown>, b: Record<string, unknown>) =>
            new Date(a.createdAt as string).getTime() -
            new Date(b.createdAt as string).getTime(),
        );

      const { limit, offset } = request.query;
      const entries = all.slice(offset, offset + limit);
      return reply.send({ total: all.length, limit, offset, entries });
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
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const conv = validateConversationOwnership(request.body.conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

      const message = saveAgentConversationMessage({
        conversationId: request.body.conversationId,
        direction: 'inbound',
        content: request.body.content,
        type: request.body.isFinal ? 'text' : 'system',
        metadata: {
          agentChatUpdate: true,
          isFinal: Boolean(request.body.isFinal),
        },
      });

      return reply.status(201).send(message);
    },
  );

  // Send a prompt (SSE streaming)
  typedApp.post(
    '/api/agents/:id/chat/message',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Send a prompt to the agent and stream the response via SSE',
        params: z.object({ id: z.string() }),
        body: z.object({
          prompt: z.string().min(1).max(50000),
          conversationId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      // Rate limit per user per agent to prevent prompt spam
      const userId = (request.user as { sub: string }).sub;
      const rateLimitKey = `${userId}:${request.params.id}`;
      if (!promptRateLimiter.isAllowed(rateLimitKey)) {
        return reply.tooManyRequests('Too many prompt requests. Please wait before sending another message.');
      }

      if (isAgentBusy(request.params.id, request.body.conversationId)) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Agent is already processing a prompt',
        });
      }

      const conv = validateConversationOwnership(request.body.conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      attachSocketErrorHandler(request, reply);

      executePrompt(request.params.id, request.body.prompt, request.body.conversationId, {
        onChunk(text) {
          safeSseWrite(request, reply, `data: ${JSON.stringify(text)}\n\n`);
        },
        onDone(message) {
          safeSseWrite(request, reply, `event: done\ndata: ${JSON.stringify({ messageId: message.id })}\n\n`);
          safeSseEnd(request, reply);
        },
        onError(error) {
          safeSseWrite(request, reply, `event: error\ndata: ${JSON.stringify({ error })}\n\n`);
          safeSseEnd(request, reply);
        },
      });
    },
  );

  // Trigger agent to respond to the latest message (e.g. after image upload) — SSE streaming
  typedApp.post(
    '/api/agents/:id/chat/respond',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Trigger agent to respond to the latest conversation message (e.g. after image upload)',
        params: z.object({ id: z.string() }),
        body: z.object({
          conversationId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      // Rate limit per user per agent
      const userId = (request.user as { sub: string }).sub;
      const rateLimitKey = `${userId}:${request.params.id}`;
      if (!promptRateLimiter.isAllowed(rateLimitKey)) {
        return reply.tooManyRequests('Too many prompt requests. Please wait before sending another message.');
      }

      if (isAgentBusy(request.params.id, request.body.conversationId)) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Agent is already processing a prompt',
        });
      }

      const conv = validateConversationOwnership(request.body.conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      attachSocketErrorHandler(request, reply);

      executeRespondToLastMessage(request.params.id, request.body.conversationId, {
        onChunk(text) {
          safeSseWrite(request, reply, `data: ${JSON.stringify(text)}\n\n`);
        },
        onDone(message) {
          safeSseWrite(request, reply, `event: done\ndata: ${JSON.stringify({ messageId: message.id })}\n\n`);
          safeSseEnd(request, reply);
        },
        onError(error) {
          safeSseWrite(request, reply, `event: error\ndata: ${JSON.stringify({ error })}\n\n`);
          safeSseEnd(request, reply);
        },
      });
    },
  );

  // Reconnect to a running agent stream (SSE)
  typedApp.get(
    '/api/agents/:id/chat/stream',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Reconnect to a running agent stream via SSE',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          conversationId: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      if (!isAgentBusy(request.params.id, request.query.conversationId)) {
        return reply.status(204).send();
      }

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      attachSocketErrorHandler(request, reply);

      const subscribed = subscribeToRunOutput(
        request.params.id,
        request.query.conversationId,
        {
          onChunk(text) {
            safeSseWrite(request, reply, `data: ${JSON.stringify(text)}\n\n`);
          },
          onDone(message) {
            safeSseWrite(
              request,
              reply,
              `event: done\ndata: ${JSON.stringify({ messageId: message?.id ?? null })}\n\n`,
            );
            safeSseEnd(request, reply);
          },
          onError(error) {
            safeSseWrite(request, reply, `event: error\ndata: ${JSON.stringify({ error })}\n\n`);
            safeSseEnd(request, reply);
          },
        },
      );

      if (!subscribed) {
        // Race condition: process finished between check and subscribe
        safeSseWrite(request, reply, `event: done\ndata: ${JSON.stringify({ messageId: null })}\n\n`);
        safeSseEnd(request, reply);
      }
    },
  );

  // Upload an image to agent chat
  typedApp.post(
    '/api/agents/:id/chat/upload',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Agent Chat'],
        summary: 'Upload an image to agent chat and create a message with the attachment',
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const agent = getAgent(request.params.id);
      if (!agent) return reply.notFound('Agent not found');

      const data = await request.file();
      if (!data) return reply.badRequest('No file uploaded');

      const conversationId = (data.fields.conversationId as { value: string } | undefined)?.value;
      if (!conversationId) return reply.badRequest('conversationId is required');

      const conv = validateConversationOwnership(conversationId, request.params.id);
      if (!conv) return reply.notFound('Conversation not found');

      const mimeType = data.mimetype || 'application/octet-stream';
      const filename = data.filename || 'image.jpg';

      const fileCheck = validateUploadedFile(mimeType, filename);
      if (!fileCheck.valid) return reply.badRequest(fileCheck.error!);

      if (!mimeType.startsWith('image/')) {
        return reply.badRequest('Only image files are supported');
      }

      // Read file into buffer
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Save to storage under /chat-uploads/ with a unique name
      const ext = path.extname(filename) || '.jpg';
      const uniqueName = `${crypto.randomUUID()}${ext}`;
      const storagePath = '/chat-uploads';

      const entry = await uploadFile(storagePath, uniqueName, mimeType, buffer);

      // Build attachment metadata
      const attachment = {
        type: 'image',
        fileName: filename,
        mimeType,
        fileSize: buffer.length,
        storagePath: entry.path,
      };

      const caption = (data.fields.caption as { value: string } | undefined)?.value || null;

      const message = saveAgentConversationMessage({
        conversationId,
        direction: 'outbound',
        content: caption || '',
        type: 'image',
        attachments: [attachment],
      });

      return reply.status(201).send(message);
    },
  );
}
