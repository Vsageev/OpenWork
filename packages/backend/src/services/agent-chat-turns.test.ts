import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let nextId = 1;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const collection = (name: string) => {
    let records = collections.get(name);
    if (!records) {
      records = new Map();
      collections.set(name, records);
    }
    return records;
  };
  const store = {
    reset() {
      nextId = 1;
      collections.clear();
    },
    getAll(name: string) {
      return [...collection(name).values()];
    },
    getById(name: string, id: string) {
      return collection(name).get(id) ?? null;
    },
    insert(name: string, data: Record<string, unknown>) {
      const now = new Date(Date.UTC(2026, 4, 16, 12, 0, nextId)).toISOString();
      const record = {
        ...data,
        id: typeof data.id === 'string' ? data.id : `${name}-${nextId++}`,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now,
      };
      collection(name).set(String(record.id), record);
      return record;
    },
    update(name: string, id: string, data: Record<string, unknown>) {
      const existing = collection(name).get(id);
      if (!existing) return null;
      const updated = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
      collection(name).set(id, updated);
      return updated;
    },
  };
  return { store };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/connection.js', () => ({ store: mocks.store }));

import {
  backfillLegacyAgentChatTurns,
  createAgentChatTurn,
  createReplacementAgentChatTurn,
  listAgentChatTurns,
  markAgentChatTurnStopped,
  validateAgentChatTurnChains,
} from './agent-chat-turns.js';

describe('agent chat turns', () => {
  beforeEach(() => {
    mocks.store.reset();
    mocks.store.insert('agents', {
      id: 'agent-1',
      name: 'Test Agent',
    });
  });

  it('stores parent and child turns for normal follow-ups', () => {
    const parent = createAgentChatTurn({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
    });
    const child = createAgentChatTurn({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentUserMessageId: 'message-1',
      userMessageId: 'message-2',
    });

    expect(child.parentTurnId).toBe(parent.id);
    expect(listAgentChatTurns('agent-1', 'conversation-1').map((turn) => turn.id)).toEqual([
      parent.id,
      child.id,
    ]);
  });

  it('creates edit replacement turns and supersedes the original turn', () => {
    const original = createAgentChatTurn({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-original',
      parentTurnId: 'turn-parent',
      status: 'completed',
    });

    const replacement = createReplacementAgentChatTurn(String(original.id), {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-edited',
    });

    expect(replacement).toMatchObject({
      parentTurnId: 'turn-parent',
      supersedesTurnId: original.id,
      turnType: 'edit',
      status: 'queued',
    });
    expect(mocks.store.getById('agentChatTurns', String(original.id))).toMatchObject({
      status: 'superseded',
    });
  });

  it('keeps repeated root edits grouped as root replacement turns', () => {
    mocks.store.insert('messages', {
      id: 'message-original',
      conversationId: 'conversation-1',
      direction: 'outbound',
      parentId: null,
    });
    mocks.store.insert('messages', {
      id: 'message-edit-1',
      conversationId: 'conversation-1',
      direction: 'outbound',
      parentId: 'message-original',
    });
    mocks.store.insert('messages', {
      id: 'message-edit-2',
      conversationId: 'conversation-1',
      direction: 'outbound',
      parentId: 'message-original',
    });

    const original = createAgentChatTurn({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-original',
      status: 'completed',
    });
    const firstEdit = createAgentChatTurn({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-edit-1',
      turnType: 'edit',
      supersedesTurnId: String(original.id),
      status: 'completed',
    });
    const secondEdit = createAgentChatTurn({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-edit-2',
      turnType: 'edit',
      supersedesTurnId: String(firstEdit.id),
    });

    expect(firstEdit).toMatchObject({ parentTurnId: null });
    expect(secondEdit).toMatchObject({
      parentTurnId: null,
      supersedesTurnId: firstEdit.id,
      turnType: 'edit',
    });
  });

  it('repairs repeated root edit turns that were previously parented under the original turn', () => {
    mocks.store.insert('conversations', {
      id: 'conversation-1',
      channelType: 'agent',
      metadata: JSON.stringify({
        agentId: 'agent-1',
        activeBranches: {
          'user:__root__': 'message-original',
        },
      }),
      lastMessageAt: '2026-05-16T12:02:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-original',
      conversationId: 'conversation-1',
      direction: 'outbound',
      parentId: null,
    });
    mocks.store.insert('messages', {
      id: 'message-edit-1',
      conversationId: 'conversation-1',
      direction: 'outbound',
      parentId: 'message-original',
    });
    mocks.store.insert('messages', {
      id: 'message-edit-2',
      conversationId: 'conversation-1',
      direction: 'outbound',
      parentId: 'message-original',
    });
    createAgentChatTurn({
      id: 'turn-original',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-original',
      status: 'superseded',
    });
    createAgentChatTurn({
      id: 'turn-edit-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-edit-1',
      turnType: 'edit',
      supersedesTurnId: 'turn-original',
      status: 'superseded',
    });
    mocks.store.insert('agentChatTurns', {
      id: 'turn-edit-2',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentTurnId: 'turn-original',
      userMessageId: 'message-edit-2',
      assistantMessageId: null,
      status: 'queued',
      runId: null,
      source: 'user',
      createdById: null,
      turnType: 'edit',
      supersedesTurnId: 'turn-edit-1',
      metadata: {},
      startedAt: null,
      completedAt: null,
    });

    const result = backfillLegacyAgentChatTurns();

    expect(result).toMatchObject({ repairedParentLinks: 1, updatedActiveBranches: 1 });
    expect(mocks.store.getById('agentChatTurns', 'turn-edit-2')).toMatchObject({
      parentTurnId: null,
    });
    const metadata = mocks.store.getById('conversations', 'conversation-1')?.metadata;
    const parsedMetadata =
      typeof metadata === 'string' ? JSON.parse(metadata) : (metadata as Record<string, unknown>);
    expect(parsedMetadata.activeBranches).toMatchObject({
      'turn:__root__': 'turn-edit-2',
      'user:__root__': 'message-edit-2',
    });
  });

  it('marks stopped turns separately from failed turns', () => {
    const turn = createAgentChatTurn({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      runId: 'run-1',
      status: 'running',
    });

    const stopped = markAgentChatTurnStopped(String(turn.id), {
      runId: 'run-1',
      errorMessage: 'Killed by user',
    });

    expect(stopped).toMatchObject({
      status: 'stopped',
      runId: 'run-1',
      metadata: { errorMessage: 'Killed by user' },
    });
  });

  it('backfills legacy queue and run rows, preserving parent/child links', () => {
    mocks.store.insert('messages', {
      id: 'message-1',
      conversationId: 'conversation-1',
      direction: 'outbound',
      previousUserMessageId: null,
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-2',
      conversationId: 'conversation-1',
      direction: 'outbound',
      previousUserMessageId: 'message-1',
      createdAt: '2026-05-16T12:01:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'assistant-2',
      conversationId: 'conversation-1',
      direction: 'inbound',
      parentId: 'message-2',
      metadata: JSON.stringify({ runId: 'run-2' }),
      createdAt: '2026-05-16T12:02:00.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'completed',
      queuedMessageId: 'message-1',
      responseMessageId: 'assistant-1',
      lastRunId: 'run-1',
      createdAt: '2026-05-16T12:00:01.000Z',
      completedAt: '2026-05-16T12:00:30.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      triggerType: 'chat',
      status: 'completed',
      responseParentId: 'message-1',
      startedAt: '2026-05-16T12:00:02.000Z',
      finishedAt: '2026-05-16T12:00:30.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-2',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      triggerType: 'chat',
      status: 'completed',
      responseParentId: 'message-2',
      startedAt: '2026-05-16T12:01:02.000Z',
      finishedAt: '2026-05-16T12:02:00.000Z',
    });

    const result = backfillLegacyAgentChatTurns();
    const turns = listAgentChatTurns('agent-1', 'conversation-1');

    expect(result).toMatchObject({ created: 2, updatedQueueItems: 1, updatedRuns: 2 });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      userMessageId: 'message-1',
      assistantMessageId: 'assistant-1',
      runId: 'run-1',
      status: 'completed',
    });
    expect(turns[1]).toMatchObject({
      parentTurnId: turns[0].id,
      userMessageId: 'message-2',
      assistantMessageId: 'assistant-2',
      runId: 'run-2',
      status: 'completed',
    });
    expect(mocks.store.getById('agentChatQueue', 'queue-1')?.turnId).toBe(turns[0].id);
    expect(mocks.store.getById('agent_runs', 'run-2')?.turnId).toBe(turns[1].id);
  });

  it('repairs existing root turns that actually belong under an earlier user turn', () => {
    mocks.store.insert('conversations', {
      id: 'conversation-1',
      channelType: 'agent',
      metadata: JSON.stringify({
        agentId: 'agent-1',
        activeBranches: {
          'user:message-root': 'message-stale-child',
        },
      }),
      lastMessageAt: '2026-05-16T12:04:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-root',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      previousUserMessageId: null,
      parentId: null,
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'assistant-root',
      conversationId: 'conversation-1',
      direction: 'inbound',
      type: 'text',
      parentId: 'message-root',
      createdAt: '2026-05-16T12:01:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-stale-child',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      previousUserMessageId: 'message-root',
      parentId: 'assistant-root',
      createdAt: '2026-05-16T12:02:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-latest-child',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      previousUserMessageId: 'message-root',
      parentId: 'assistant-root',
      createdAt: '2026-05-16T12:03:00.000Z',
    });
    createAgentChatTurn({
      id: 'turn-root',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-root',
      status: 'completed',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('agentChatTurns', {
      id: 'turn-stale-child',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentTurnId: null,
      userMessageId: 'message-stale-child',
      assistantMessageId: null,
      status: 'completed',
      runId: null,
      source: 'legacy_queue',
      createdById: null,
      turnType: 'follow_up',
      supersedesTurnId: null,
      metadata: {},
      startedAt: null,
      completedAt: null,
      createdAt: '2026-05-16T12:02:00.000Z',
    });
    mocks.store.insert('agentChatTurns', {
      id: 'turn-latest-child',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentTurnId: null,
      userMessageId: 'message-latest-child',
      assistantMessageId: null,
      status: 'queued',
      runId: null,
      source: 'user',
      createdById: null,
      turnType: 'follow_up',
      supersedesTurnId: null,
      metadata: {},
      startedAt: null,
      completedAt: null,
      createdAt: '2026-05-16T12:03:00.000Z',
    });

    const result = backfillLegacyAgentChatTurns();

    expect(result).toMatchObject({
      repairedParentLinks: 2,
      updatedActiveBranches: 1,
    });
    expect(mocks.store.getById('agentChatTurns', 'turn-stale-child')).toMatchObject({
      parentTurnId: 'turn-root',
    });
    expect(mocks.store.getById('agentChatTurns', 'turn-latest-child')).toMatchObject({
      parentTurnId: 'turn-root',
    });
    const metadata = mocks.store.getById('conversations', 'conversation-1')?.metadata;
    const parsedMetadata =
      typeof metadata === 'string' ? JSON.parse(metadata) : (metadata as Record<string, unknown>);
    expect(parsedMetadata.activeBranches).toMatchObject({
      'user:message-root': 'message-latest-child',
    });
  });

  it('migrates message-only and parentId-only legacy chains with attachments idempotently', () => {
    mocks.store.insert('conversations', {
      id: 'conversation-1',
      channelType: 'agent',
      metadata: JSON.stringify({ agentId: 'agent-1' }),
      lastMessageAt: '2026-05-16T12:04:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-root',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'file',
      content: 'Attached prompt',
      attachments: [{ type: 'file', storagePath: '/chat-uploads/spec.txt' }],
      parentId: null,
      previousUserMessageId: null,
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'assistant-root',
      conversationId: 'conversation-1',
      direction: 'inbound',
      type: 'text',
      content: 'Attached response',
      parentId: 'message-root',
      createdAt: '2026-05-16T12:01:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-child',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      content: 'Parent id only follow-up',
      parentId: 'assistant-root',
      previousUserMessageId: null,
      createdAt: '2026-05-16T12:02:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'assistant-child',
      conversationId: 'conversation-1',
      direction: 'inbound',
      type: 'text',
      content: 'Second response',
      parentId: 'message-child',
      createdAt: '2026-05-16T12:03:00.000Z',
    });

    const first = backfillLegacyAgentChatTurns();
    const turns = listAgentChatTurns('agent-1', 'conversation-1');
    const second = backfillLegacyAgentChatTurns();

    expect(first).toMatchObject({ migrated: 1, created: 2, invalid: 0 });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      userMessageId: 'message-root',
      assistantMessageId: 'assistant-root',
      source: 'legacy_message',
    });
    expect(turns[1]).toMatchObject({
      parentTurnId: turns[0].id,
      userMessageId: 'message-child',
      assistantMessageId: 'assistant-child',
      source: 'legacy_message',
    });
    expect(mocks.store.getById('messages', 'message-root')?.attachments).toEqual([
      { type: 'file', storagePath: '/chat-uploads/spec.txt' },
    ]);
    expect(second).toMatchObject({ migrated: 0, created: 0, invalid: 0 });
    expect(listAgentChatTurns('agent-1', 'conversation-1')).toHaveLength(2);
  });

  it('migrates queued-only, failed, and stopped legacy execution rows', () => {
    mocks.store.insert('conversations', {
      id: 'conversation-1',
      channelType: 'agent',
      metadata: JSON.stringify({ agentId: 'agent-1' }),
      lastMessageAt: '2026-05-16T12:05:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-failed',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      content: 'Will fail',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-stopped',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      content: 'Will stop',
      previousUserMessageId: 'message-failed',
      createdAt: '2026-05-16T12:02:00.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-only',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'queued',
      prompt: 'Queued but no message yet',
      createdAt: '2026-05-16T11:59:00.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-failed',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      triggerType: 'chat',
      status: 'error',
      errorMessage: 'Model failed',
      responseParentId: 'message-failed',
      startedAt: '2026-05-16T12:00:30.000Z',
      finishedAt: '2026-05-16T12:01:00.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-stopped',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      triggerType: 'chat',
      status: 'error',
      errorMessage: 'Killed by user',
      killedByUser: true,
      responseParentId: 'message-stopped',
      startedAt: '2026-05-16T12:02:30.000Z',
      finishedAt: '2026-05-16T12:03:00.000Z',
    });

    const report = backfillLegacyAgentChatTurns();
    const turns = listAgentChatTurns('agent-1', 'conversation-1');

    expect(report).toMatchObject({ migrated: 1, invalid: 0, updatedQueueItems: 1, updatedRuns: 2 });
    expect(turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userMessageId: null,
          status: 'queued',
          source: 'legacy_queue',
        }),
        expect.objectContaining({
          userMessageId: 'message-failed',
          status: 'failed',
          runId: 'run-failed',
        }),
        expect.objectContaining({
          userMessageId: 'message-stopped',
          status: 'stopped',
          runId: 'run-stopped',
        }),
      ]),
    );
    expect(mocks.store.getById('agentChatQueue', 'queue-only')?.turnId).toBeTruthy();
    expect(mocks.store.getById('agent_runs', 'run-failed')?.turnId).toBeTruthy();
    expect(mocks.store.getById('agent_runs', 'run-stopped')?.turnId).toBeTruthy();
  });

  it('leaves mixed canonical conversations unchanged while migrating missing legacy rows', () => {
    mocks.store.insert('conversations', {
      id: 'conversation-1',
      channelType: 'agent',
      metadata: JSON.stringify({ agentId: 'agent-1' }),
      lastMessageAt: '2026-05-16T12:03:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-canonical',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      content: 'Existing turn',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    createAgentChatTurn({
      id: 'turn-canonical',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-canonical',
      status: 'completed',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'message-legacy',
      conversationId: 'conversation-1',
      direction: 'outbound',
      type: 'text',
      content: 'Legacy missing turn',
      previousUserMessageId: 'message-canonical',
      createdAt: '2026-05-16T12:02:00.000Z',
    });

    const report = backfillLegacyAgentChatTurns();
    const turns = listAgentChatTurns('agent-1', 'conversation-1');

    expect(report).toMatchObject({ migrated: 1, created: 1, invalid: 0 });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ id: 'turn-canonical', userMessageId: 'message-canonical' });
    expect(turns[1]).toMatchObject({
      parentTurnId: 'turn-canonical',
      userMessageId: 'message-legacy',
    });
  });

  it('reports invalid legacy rows and broken turn chains without silently dropping ids', () => {
    mocks.store.insert('conversations', {
      id: 'conversation-1',
      channelType: 'agent',
      metadata: JSON.stringify({ agentId: 'agent-1' }),
      lastMessageAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-bad',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'queued',
      queuedMessageId: 'missing-message',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('agentChatTurns', {
      id: 'turn-broken',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      parentTurnId: 'missing-parent-turn',
      userMessageId: null,
      assistantMessageId: null,
      status: 'completed',
      runId: null,
      source: 'user',
      createdById: null,
      turnType: 'follow_up',
      supersedesTurnId: null,
      metadata: {},
      startedAt: null,
      completedAt: null,
      createdAt: '2026-05-16T12:01:00.000Z',
    });

    const report = backfillLegacyAgentChatTurns();

    expect(report.invalid).toBe(1);
    expect(report.invalidRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'conversation-1',
          queueItemId: 'queue-bad',
          messageId: 'missing-message',
          code: 'queue_user_message_missing',
        }),
        expect.objectContaining({
          conversationId: 'conversation-1',
          turnId: 'turn-broken',
          code: 'turn_parent_missing',
        }),
      ]),
    );
    expect(validateAgentChatTurnChains().some((issue) => issue.code === 'turn_parent_missing')).toBe(
      true,
    );
  });
});
