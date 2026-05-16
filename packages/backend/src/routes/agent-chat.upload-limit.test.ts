import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../plugins/error-handler.js';
import { agentChatRoutes } from './agent-chat.js';

type RecordMap = Map<string, Map<string, Record<string, unknown>>>;

const mocks = vi.hoisted(() => {
  const records: RecordMap = new Map();

  function collection(name: string) {
    let map = records.get(name);
    if (!map) {
      map = new Map();
      records.set(name, map);
    }
    return map;
  }

  const store = {
    reset() {
      records.clear();
    },
    getAll(name: string) {
      return [...collection(name).values()];
    },
    find(name: string, predicate: (record: Record<string, unknown>) => boolean) {
      return [...collection(name).values()].filter((record) => predicate(record));
    },
    getById(name: string, id: string) {
      return collection(name).get(id) ?? null;
    },
    insert(name: string, data: Record<string, unknown>) {
      const now = new Date().toISOString();
      const record = {
        ...data,
        id: typeof data.id === 'string' ? data.id : `${name}-${collection(name).size + 1}`,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now,
      };
      collection(name).set(String(record.id), record);
      return record;
    },
    update(name: string, id: string, data: Record<string, unknown>) {
      const existing = collection(name).get(id);
      if (!existing) return null;
      const record = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
      collection(name).set(id, record);
      return record;
    },
    delete(name: string, id: string) {
      const existing = collection(name).get(id) ?? null;
      collection(name).delete(id);
      return existing;
    },
    async transaction<T>(operation: () => T | Promise<T>) {
      return operation();
    },
    async lockAgentChatQueueConversation() {},
    async lockAgentRunRowForUpdate() {},
    async reload() {},
    async flush() {},
  };

  return { store };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));

function multipartPayload(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; value: string }>,
) {
  const boundary = `----openwork-test-${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            'Content-Type: text/plain\r\n\r\n' +
            `${part.value}\r\n`,
        ),
      );
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`),
      );
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    boundary,
    body: Buffer.concat(chunks),
  };
}

function fileParts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: 'files',
    filename: `attachment-${index + 1}.txt`,
    value: `attachment ${index + 1}`,
  }));
}

async function buildRouteApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(multipart);
  app.decorate('authenticate', async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'test-user' };
  });
  registerErrorHandler(app);
  await app.register(agentChatRoutes);
  return app;
}

beforeEach(() => {
  mocks.store.reset();
  mocks.store.insert('agents', {
    id: 'agent-1',
    name: 'Test Agent',
    model: 'codex',
    status: 'active',
  });
  mocks.store.insert('conversations', {
    id: 'conversation-1',
    metadata: JSON.stringify({ agentId: 'agent-1' }),
  });
});

describe('agent chat upload attachment limit', () => {
  it('returns a structured 400 instead of dropping extra queue edit upload files', async () => {
    const app = await buildRouteApp();
    const { boundary, body } = multipartPayload([
      { name: 'conversationId', value: 'conversation-1' },
      { name: 'prompt', value: 'Updated queued prompt' },
      ...fileParts(11),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/chat/queue/item-1/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      code: 'chat_attachment_limit_exceeded',
      message: 'A chat message can include up to 10 attachments',
    });

    await app.close();
  });

  it('returns a structured 400 instead of dropping extra chat upload files', async () => {
    const app = await buildRouteApp();
    const { boundary, body } = multipartPayload([
      { name: 'conversationId', value: 'conversation-1' },
      { name: 'messageId', value: 'message-1' },
      ...fileParts(11),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/chat/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      code: 'chat_attachment_limit_exceeded',
      message: 'A chat message can include up to 10 attachments',
    });

    await app.close();
  });

  it('returns a structured 400 instead of dropping extra edit upload files', async () => {
    const app = await buildRouteApp();
    const { boundary, body } = multipartPayload([
      { name: 'messageId', value: 'message-1' },
      { name: 'newMessageId', value: 'message-2' },
      { name: 'content', value: 'Updated message' },
      ...fileParts(11),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/edit-message-upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      code: 'chat_attachment_limit_exceeded',
      message: 'A chat message can include up to 10 attachments',
    });

    await app.close();
  });

  it('returns a structured 400 instead of dropping extra upload-and-respond files', async () => {
    const app = await buildRouteApp();
    const { boundary, body } = multipartPayload([
      { name: 'conversationId', value: 'conversation-1' },
      { name: 'messageId', value: 'message-1' },
      ...fileParts(11),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/chat/upload-and-respond',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      code: 'chat_attachment_limit_exceeded',
      message: 'A chat message can include up to 10 attachments',
    });

    await app.close();
  });
});
