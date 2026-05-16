import Fastify from 'fastify';
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
      const now = new Date(Date.UTC(2026, 4, 16, 12, 0, collection(name).size)).toISOString();
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
vi.mock('../db/connection.js', () => ({ store: mocks.store }));

async function buildRouteApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'test-user' };
  });
  registerErrorHandler(app);
  await app.register(agentChatRoutes);
  return app;
}

function seedAgentConversation(conversationId = 'conversation-1', metadata = {}) {
  mocks.store.insert('agents', {
    id: 'agent-1',
    name: 'Test Agent',
    model: 'codex',
    status: 'active',
  });
  mocks.store.insert('conversations', {
    id: conversationId,
    channelType: 'agent',
    status: 'open',
    subject: 'Chat',
    metadata: JSON.stringify({ agentId: 'agent-1', ...metadata }),
    lastMessageAt: '2026-05-16T12:00:00.000Z',
  });
}

function addMessage(id: string, patch: Record<string, unknown>) {
  return mocks.store.insert('messages', {
    id,
    conversationId: 'conversation-1',
    direction: 'outbound',
    type: 'text',
    content: id,
    status: 'sent',
    attachments: null,
    metadata: null,
    createdAt: `2026-05-16T12:${String(mocks.store.getAll('messages').length).padStart(2, '0')}:00.000Z`,
    ...patch,
  });
}

function addTurn(id: string, patch: Record<string, unknown>) {
  return mocks.store.insert('agentChatTurns', {
    id,
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    parentTurnId: null,
    userMessageId: null,
    assistantMessageId: null,
    status: 'queued',
    runId: null,
    source: 'user',
    createdById: 'test-user',
    turnType: 'follow_up',
    supersedesTurnId: null,
    metadata: {},
    startedAt: null,
    completedAt: null,
    createdAt: `2026-05-16T12:${String(mocks.store.getAll('agentChatTurns').length).padStart(2, '0')}:30.000Z`,
    ...patch,
  });
}

describe('agent chat canonical view endpoint', () => {
  beforeEach(() => {
    mocks.store.reset();
  });

  it('returns ordered turn rows with completed, queued, processing, failed, and stopped controls', async () => {
    seedAgentConversation();
    addMessage('user-1', { content: 'completed prompt' });
    addMessage('assistant-1', {
      direction: 'inbound',
      content: 'completed response',
      parentId: 'user-1',
      metadata: JSON.stringify({ runId: 'run-1' }),
    });
    addMessage('user-2', { content: 'queued prompt' });
    addMessage('user-3', { content: 'processing prompt' });
    addMessage('user-4', { content: 'failed prompt' });
    addMessage('user-5', { content: 'stopped prompt' });

    addTurn('turn-1', {
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      status: 'completed',
      runId: 'run-1',
    });
    addTurn('turn-2', {
      parentTurnId: 'turn-1',
      userMessageId: 'user-2',
      status: 'queued',
    });
    addTurn('turn-3', {
      parentTurnId: 'turn-2',
      userMessageId: 'user-3',
      status: 'running',
      runId: 'run-3',
    });
    addTurn('turn-4', {
      parentTurnId: 'turn-3',
      userMessageId: 'user-4',
      status: 'failed',
      runId: 'run-4',
    });
    addTurn('turn-5', {
      parentTurnId: 'turn-4',
      userMessageId: 'user-5',
      status: 'stopped',
      runId: 'run-5',
    });

    mocks.store.insert('agentChatQueue', {
      id: 'queue-2',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'queued',
      turnId: 'turn-2',
      queuedMessageId: 'user-2',
      attempts: 0,
      maxAttempts: 3,
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-3',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'processing',
      turnId: 'turn-3',
      queuedMessageId: 'user-3',
      runId: 'run-3',
      attempts: 1,
      maxAttempts: 3,
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-4',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'failed',
      turnId: 'turn-4',
      queuedMessageId: 'user-4',
      lastRunId: 'run-4',
      errorMessage: 'Model failed',
      attempts: 3,
      maxAttempts: 3,
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-5',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'cancelled',
      turnId: 'turn-5',
      queuedMessageId: 'user-5',
      lastRunId: 'run-5',
      errorMessage: 'Killed by user',
      attempts: 1,
      maxAttempts: 3,
    });
    mocks.store.insert('agent_runs', {
      id: 'run-1',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'completed',
      conversationId: 'conversation-1',
      responseParentId: 'user-1',
      turnId: 'turn-1',
      responseText: 'completed response',
      startedAt: '2026-05-16T12:00:30.000Z',
      finishedAt: '2026-05-16T12:01:00.000Z',
      durationMs: 30000,
    });
    mocks.store.insert('agent_runs', {
      id: 'run-3',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      conversationId: 'conversation-1',
      responseParentId: 'user-3',
      turnId: 'turn-3',
      startedAt: '2026-05-16T12:03:30.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-4',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'error',
      conversationId: 'conversation-1',
      responseParentId: 'user-4',
      turnId: 'turn-4',
      errorMessage: 'Model failed',
      startedAt: '2026-05-16T12:04:30.000Z',
      finishedAt: '2026-05-16T12:05:00.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-5',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'error',
      conversationId: 'conversation-1',
      responseParentId: 'user-5',
      turnId: 'turn-5',
      errorMessage: 'Killed by user',
      killedByUser: true,
      startedAt: '2026-05-16T12:05:30.000Z',
      finishedAt: '2026-05-16T12:06:00.000Z',
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
      'turn-4',
      'turn-5',
    ]);
    expect(body.entries.map((turn: Record<string, unknown>) => turn.status)).toEqual([
      'completed',
      'queued',
      'processing',
      'failed',
      'stopped',
    ]);
    expect(body.entries[1].availableActions).toEqual(
      expect.arrayContaining(['edit_queue_item', 'delete_queue_item']),
    );
    expect(body.entries[2].availableActions).toContain('stop');
    expect(body.entries[3].availableActions).toContain('retry');
    expect(body.entries[4].availableActions).toContain('retry');
    expect(body.entries[0].assistantMessage).toMatchObject({
      id: 'assistant-1',
      content: 'completed response',
    });

    await app.close();
  });

  it('returns edit provenance and branch metadata without exposing raw queue rows', async () => {
    seedAgentConversation('conversation-1', { activeBranches: { 'turn:turn-root': 'turn-edit' } });
    addMessage('user-root', { content: 'root prompt' });
    addMessage('user-original', { content: 'original branch' });
    addMessage('user-edit', { content: 'edited branch' });
    addMessage('user-alt', { content: 'other branch' });
    addMessage('assistant-edit', {
      direction: 'inbound',
      content: 'edited response',
      parentId: 'user-edit',
      metadata: JSON.stringify({ runId: 'run-edit' }),
    });

    addTurn('turn-root', {
      userMessageId: 'user-root',
      status: 'completed',
    });
    addTurn('turn-original', {
      parentTurnId: 'turn-root',
      userMessageId: 'user-original',
      status: 'superseded',
    });
    addTurn('turn-edit', {
      parentTurnId: 'turn-root',
      userMessageId: 'user-edit',
      assistantMessageId: 'assistant-edit',
      status: 'completed',
      runId: 'run-edit',
      turnType: 'edit',
      supersedesTurnId: 'turn-original',
    });
    addTurn('turn-alt', {
      parentTurnId: 'turn-root',
      userMessageId: 'user-alt',
      status: 'completed',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-edit',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'completed',
      conversationId: 'conversation-1',
      responseParentId: 'user-edit',
      turnId: 'turn-edit',
      startedAt: '2026-05-16T12:03:30.000Z',
      finishedAt: '2026-05-16T12:04:00.000Z',
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual([
      'turn-root',
      'turn-edit',
    ]);
    expect(body.entries[1]).toMatchObject({
      id: 'turn-edit',
      turnType: 'edit',
      edit: {
        supersedesTurnId: 'turn-original',
        isSuperseded: false,
      },
      branch: {
        siblingCount: 3,
        siblingIds: ['turn-original', 'turn-edit', 'turn-alt'],
      },
    });
    expect(body.entries[1].branch.siblings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: 'turn-original', status: 'superseded' }),
        expect.objectContaining({ turnId: 'turn-edit', isSelected: true }),
      ]),
    );
    expect(body.entries[1]).not.toHaveProperty('metadata');
    expect(body.entries[1].execution.queue).toBeNull();

    await app.close();
  });

  it('returns 404 for a conversation that does not belong to the agent', async () => {
    seedAgentConversation();
    const app = await buildRouteApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/missing/view',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: 'conversation_not_found',
      message: 'Conversation not found',
    });

    await app.close();
  });
});

describe('agent chat turn lifecycle regression matrix API view', () => {
  beforeEach(() => {
    mocks.store.reset();
  });

  it('renders a stopped first prompt followed by a normal follow-up turn', async () => {
    seedAgentConversation();
    addMessage('message-first', { content: 'First prompt' });
    addMessage('message-follow-up', {
      content: 'Follow-up after stop',
      previousUserMessageId: 'message-first',
    });
    addTurn('turn-first', {
      userMessageId: 'message-first',
      status: 'stopped',
      runId: 'run-first',
    });
    addTurn('turn-follow-up', {
      parentTurnId: 'turn-first',
      userMessageId: 'message-follow-up',
      status: 'running',
      runId: 'run-follow-up',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-first',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'cancelled',
      turnId: 'turn-first',
      queuedMessageId: 'message-first',
      lastRunId: 'run-first',
      errorMessage: 'Killed by user',
      attempts: 1,
      maxAttempts: 3,
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-follow-up',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'processing',
      turnId: 'turn-follow-up',
      queuedMessageId: 'message-follow-up',
      runId: 'run-follow-up',
      attempts: 1,
      maxAttempts: 3,
    });
    mocks.store.insert('agent_runs', {
      id: 'run-follow-up',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      conversationId: 'conversation-1',
      responseParentId: 'message-follow-up',
      turnId: 'turn-follow-up',
      startedAt: '2026-05-16T12:02:00.000Z',
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual([
      'turn-first',
      'turn-follow-up',
    ]);
    expect(body.entries[0]).toMatchObject({
      status: 'stopped',
      turnType: 'follow_up',
      availableActions: expect.arrayContaining(['retry']),
    });
    expect(body.entries[1]).toMatchObject({
      parentTurnId: 'turn-first',
      status: 'processing',
      turnType: 'follow_up',
      userMessage: { id: 'message-follow-up', content: 'Follow-up after stop' },
      execution: {
        queue: { id: 'queue-follow-up', status: 'processing' },
        run: { id: 'run-follow-up', status: 'running' },
      },
      availableActions: expect.arrayContaining(['stop']),
    });

    await app.close();
  });

  it('renders an edit of the first prompt as an explicit replacement, not a follow-up', async () => {
    seedAgentConversation('conversation-1', { activeBranches: { 'turn:__root__': 'turn-edit' } });
    addMessage('message-original', { content: 'Original first prompt' });
    addMessage('message-edit', { content: 'Edited first prompt' });
    addTurn('turn-original', {
      userMessageId: 'message-original',
      status: 'superseded',
    });
    addTurn('turn-edit', {
      userMessageId: 'message-edit',
      status: 'queued',
      turnType: 'edit',
      supersedesTurnId: 'turn-original',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-edit',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'respond_to_message',
      status: 'queued',
      turnId: 'turn-edit',
      targetMessageId: 'message-edit',
      queuedMessageId: 'message-edit',
      attempts: 0,
      maxAttempts: 3,
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual(['turn-edit']);
    expect(body.entries[0]).toMatchObject({
      parentTurnId: null,
      turnType: 'edit',
      edit: {
        supersedesTurnId: 'turn-original',
        isSuperseded: false,
      },
      branch: {
        siblingCount: 2,
        siblingIds: ['turn-original', 'turn-edit'],
      },
      execution: {
        queue: { id: 'queue-edit', status: 'queued' },
      },
    });
    expect(body.entries[0]).not.toMatchObject({ turnType: 'follow_up' });

    await app.close();
  });

  it('keeps active execution visible when switching back to the superseded original prompt', async () => {
    seedAgentConversation('conversation-1', {
      activeBranches: { 'turn:__root__': 'turn-original' },
    });
    addMessage('message-original', { content: 'Original first prompt' });
    addMessage('message-edit', { content: 'Edited first prompt' });
    addTurn('turn-original', {
      userMessageId: 'message-original',
      status: 'superseded',
      runId: 'run-original',
    });
    addTurn('turn-edit', {
      userMessageId: 'message-edit',
      status: 'completed',
      turnType: 'edit',
      supersedesTurnId: 'turn-original',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-original',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'respond_to_message',
      status: 'processing',
      turnId: 'turn-original',
      targetMessageId: 'message-original',
      queuedMessageId: 'message-original',
      runId: 'run-original',
      attempts: 1,
      maxAttempts: 3,
    });
    mocks.store.insert('agent_runs', {
      id: 'run-original',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      conversationId: 'conversation-1',
      responseParentId: 'message-original',
      turnId: 'turn-original',
      startedAt: '2026-05-16T12:02:00.000Z',
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual([
      'turn-original',
    ]);
    expect(body.entries[0]).toMatchObject({
      status: 'processing',
      userMessage: { id: 'message-original', content: 'Original first prompt' },
      edit: {
        supersededByTurnId: 'turn-edit',
        isSuperseded: true,
      },
      execution: {
        queue: { id: 'queue-original', status: 'processing' },
        run: { id: 'run-original', status: 'running' },
      },
      availableActions: expect.arrayContaining(['stop']),
    });

    await app.close();
  });

  it('renders a follow-up on an edited prior prompt branch', async () => {
    seedAgentConversation('conversation-1', { activeBranches: { 'turn:__root__': 'turn-edit' } });
    addMessage('message-original', { content: 'Original prompt' });
    addMessage('message-edit', { content: 'Edited prompt' });
    addMessage('message-follow-up', {
      content: 'Follow-up on edited branch',
      previousUserMessageId: 'message-edit',
    });
    addTurn('turn-original', {
      userMessageId: 'message-original',
      status: 'superseded',
    });
    addTurn('turn-edit', {
      userMessageId: 'message-edit',
      status: 'completed',
      turnType: 'edit',
      supersedesTurnId: 'turn-original',
    });
    addTurn('turn-follow-up', {
      parentTurnId: 'turn-edit',
      userMessageId: 'message-follow-up',
      status: 'queued',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-follow-up',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'queued',
      turnId: 'turn-follow-up',
      queuedMessageId: 'message-follow-up',
      previousUserMessageId: 'message-edit',
      attempts: 0,
      maxAttempts: 3,
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual([
      'turn-edit',
      'turn-follow-up',
    ]);
    expect(body.entries[0]).toMatchObject({
      turnType: 'edit',
      edit: { supersedesTurnId: 'turn-original' },
    });
    expect(body.entries[1]).toMatchObject({
      parentTurnId: 'turn-edit',
      turnType: 'follow_up',
      userMessage: { id: 'message-follow-up', content: 'Follow-up on edited branch' },
    });

    await app.close();
  });

  it('renders multiple queued prompts behind an active run in turn order', async () => {
    seedAgentConversation();
    addMessage('message-active', { content: 'Active prompt' });
    addMessage('message-queued-1', {
      content: 'Queued prompt one',
      previousUserMessageId: 'message-active',
    });
    addMessage('message-queued-2', {
      content: 'Queued prompt two',
      previousUserMessageId: 'message-queued-1',
    });
    addTurn('turn-active', {
      userMessageId: 'message-active',
      status: 'running',
      runId: 'run-active',
    });
    addTurn('turn-queued-1', {
      parentTurnId: 'turn-active',
      userMessageId: 'message-queued-1',
      status: 'queued',
    });
    addTurn('turn-queued-2', {
      parentTurnId: 'turn-queued-1',
      userMessageId: 'message-queued-2',
      status: 'queued',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-active',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      conversationId: 'conversation-1',
      responseParentId: 'message-active',
      turnId: 'turn-active',
      startedAt: '2026-05-16T12:00:30.000Z',
    });
    for (const [id, turnId, messageId, previousUserMessageId] of [
      ['queue-active', 'turn-active', 'message-active', null],
      ['queue-queued-1', 'turn-queued-1', 'message-queued-1', 'message-active'],
      ['queue-queued-2', 'turn-queued-2', 'message-queued-2', 'message-queued-1'],
    ] as const) {
      mocks.store.insert('agentChatQueue', {
        id,
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        mode: 'append_prompt',
        status: id === 'queue-active' ? 'processing' : 'queued',
        turnId,
        queuedMessageId: messageId,
        previousUserMessageId,
        runId: id === 'queue-active' ? 'run-active' : null,
        attempts: id === 'queue-active' ? 1 : 0,
        maxAttempts: 3,
      });
    }

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual([
      'turn-active',
      'turn-queued-1',
      'turn-queued-2',
    ]);
    expect(body.entries.map((turn: Record<string, unknown>) => turn.status)).toEqual([
      'processing',
      'queued',
      'queued',
    ]);
    expect(body.entries[1].availableActions).toEqual(
      expect.arrayContaining(['edit_queue_item', 'delete_queue_item']),
    );
    expect(body.entries[2]).toMatchObject({
      parentTurnId: 'turn-queued-1',
      userMessage: { id: 'message-queued-2', content: 'Queued prompt two' },
    });

    await app.close();
  });

  it('renders upload caption attachments followed by a normal follow-up', async () => {
    seedAgentConversation();
    addMessage('message-upload', {
      content: 'Caption with attachment',
      type: 'file',
      attachments: [
        {
          type: 'file',
          fileName: 'brief.pdf',
          mimeType: 'application/pdf',
          fileSize: 128,
          storagePath: '/chat-uploads/brief.pdf',
        },
      ],
    });
    addMessage('message-follow-up', {
      content: 'Follow-up after upload',
      previousUserMessageId: 'message-upload',
    });
    addTurn('turn-upload', {
      userMessageId: 'message-upload',
      status: 'completed',
    });
    addTurn('turn-follow-up', {
      parentTurnId: 'turn-upload',
      userMessageId: 'message-follow-up',
      status: 'queued',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-follow-up',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'queued',
      turnId: 'turn-follow-up',
      queuedMessageId: 'message-follow-up',
      previousUserMessageId: 'message-upload',
      attempts: 0,
      maxAttempts: 3,
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.id)).toEqual([
      'turn-upload',
      'turn-follow-up',
    ]);
    expect(body.entries[0]).toMatchObject({
      userMessage: {
        id: 'message-upload',
        content: 'Caption with attachment',
        attachments: [
          {
            fileName: 'brief.pdf',
            storagePath: '/chat-uploads/brief.pdf',
          },
        ],
      },
    });
    expect(body.entries[1]).toMatchObject({
      parentTurnId: 'turn-upload',
      turnType: 'follow_up',
      execution: { queue: { id: 'queue-follow-up', status: 'queued' } },
    });

    await app.close();
  });

  it('renders failed and cancelled queue items with retry/removal controls', async () => {
    seedAgentConversation();
    addMessage('message-failed', { content: 'Prompt that failed' });
    addMessage('message-cancelled', {
      content: 'Prompt that was cancelled',
      previousUserMessageId: 'message-failed',
    });
    addTurn('turn-failed', {
      userMessageId: 'message-failed',
      status: 'failed',
      runId: 'run-failed',
    });
    addTurn('turn-cancelled', {
      parentTurnId: 'turn-failed',
      userMessageId: 'message-cancelled',
      status: 'stopped',
      runId: 'run-cancelled',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-failed',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'failed',
      turnId: 'turn-failed',
      queuedMessageId: 'message-failed',
      lastRunId: 'run-failed',
      errorMessage: 'Model failed',
      attempts: 3,
      maxAttempts: 3,
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-cancelled',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'cancelled',
      turnId: 'turn-cancelled',
      queuedMessageId: 'message-cancelled',
      lastRunId: 'run-cancelled',
      errorMessage: 'Removed from queue',
      attempts: 1,
      maxAttempts: 3,
    });

    const app = await buildRouteApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/chat/conversations/conversation-1/view',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries.map((turn: Record<string, unknown>) => turn.status)).toEqual([
      'failed',
      'stopped',
    ]);
    expect(body.entries[0]).toMatchObject({
      execution: { queue: { id: 'queue-failed', status: 'failed' } },
      availableActions: expect.arrayContaining(['retry', 'delete_queue_item']),
    });
    expect(body.entries[1]).toMatchObject({
      execution: { queue: { id: 'queue-cancelled', status: 'cancelled' } },
      availableActions: expect.arrayContaining(['retry', 'delete_queue_item']),
    });

    await app.close();
  });
});
