import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RecordMap = Map<string, Map<string, Record<string, unknown>>>;

const mocks = vi.hoisted(() => {
  let nextId = 1;
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
      nextId = 1;
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
      const now = new Date(Date.UTC(2026, 4, 16, 12, 0, nextId)).toISOString();
      const record = {
        ...data,
        id: typeof data.id === 'string' ? data.id : `${name}-${nextId}`,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now,
      };
      nextId += 1;
      collection(name).set(String(record.id), record);
      return record;
    },
    update(name: string, id: string, data: Record<string, unknown>) {
      const existing = collection(name).get(id);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...data,
        id,
        updatedAt: new Date(Date.UTC(2026, 4, 16, 12, 30, nextId++)).toISOString(),
      };
      collection(name).set(id, updated);
      return updated;
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

  return {
    store,
    hasConnectedRemoteAgentRunner: vi.fn(),
    hasAvailableRemoteAgentRunner: vi.fn(),
    cancelRemoteAgentRun: vi.fn(),
  };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/connection.js', () => ({ store: mocks.store }));
vi.mock('./agents.js', () => ({
  getAgent: vi.fn(() => ({
    id: 'agent-1',
    name: 'Test Agent',
    model: 'codex',
    modelId: null,
    thinkingLevel: null,
    apiKeyId: '',
    workspaceApiKey: null,
    groupId: 'group-1',
  })),
  listAgents: vi.fn(() => []),
  prepareAgentWorkspaceAccess: vi.fn(async () => ({
    id: 'agent-1',
    name: 'Test Agent',
    model: 'codex',
    modelId: null,
    thinkingLevel: null,
    apiKeyId: '',
    workspaceApiKey: null,
    groupId: 'group-1',
  })),
}));
vi.mock('./agent-runners.js', () => ({
  dispatchRemoteAgentJob: vi.fn(),
  getRemoteAgentRunnerUnavailableMessage: vi.fn(
    () => 'No remote agent runner is connected. Start or pair an OpenWork runner, then try again.',
  ),
  hasAvailableRemoteAgentRunner: mocks.hasAvailableRemoteAgentRunner,
  hasConnectedRemoteAgentRunner: mocks.hasConnectedRemoteAgentRunner,
  cancelRemoteAgentRun: mocks.cancelRemoteAgentRun,
  isRemoteAgentRunPending: vi.fn(() => false),
  RemoteAgentJobError: class RemoteAgentJobError extends Error {
    stdout = '';
    stderr = '';
  },
}));
vi.mock('./runner-devices.js', () => ({
  runnerRoutingScopesForAgentGroup: vi.fn(() => [{ userId: 'user-1', workspaceId: 'workspace-1' }]),
  workspaceIdsForAgentGroup: vi.fn(() => ['workspace-1']),
}));
vi.mock('../lib/port-allocator.js', () => ({
  allocatePort: vi.fn(async () => 3000),
  releasePort: vi.fn(),
}));

import {
  cancelProcessingQueueItemForRun,
  deleteQueueItem,
  editMessageAndBranch,
  enqueueAgentPrompt,
  reorderQueueItems,
  retryQueueItem,
  switchBranch,
  switchBranchTurn,
  __agentChatTestUtils,
} from './agent-chat.js';
import { getAgentConversationChatView } from './agent-chat-view.js';
import { markAgentChatTurnCompleted } from './agent-chat-turns.js';

function seedConversation(metadata: Record<string, unknown> = {}) {
  mocks.store.insert('conversations', {
    id: 'conversation-1',
    channelType: 'agent',
    status: 'open',
    subject: 'Chat',
    metadata: JSON.stringify({ agentId: 'agent-1', ...metadata }),
    lastMessageAt: '2026-05-16T12:00:00.000Z',
  });
}

function seedTurn(id: string, patch: Record<string, unknown>) {
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
    ...patch,
  });
}

function seedMessage(id: string, patch: Record<string, unknown>) {
  return mocks.store.insert('messages', {
    id,
    conversationId: 'conversation-1',
    direction: 'outbound',
    type: 'text',
    content: id,
    status: 'sent',
    attachments: null,
    metadata: null,
    parentId: null,
    previousUserMessageId: null,
    ...patch,
  });
}

describe('agent chat turn write paths', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    mocks.store.reset();
    mocks.hasConnectedRemoteAgentRunner.mockReset();
    mocks.hasAvailableRemoteAgentRunner.mockReset();
    mocks.cancelRemoteAgentRun.mockReset();
    mocks.hasConnectedRemoteAgentRunner.mockReturnValue(true);
    mocks.hasAvailableRemoteAgentRunner.mockReturnValue(true);
    seedConversation();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('resolves prompt-path previous user when parent is outbound (prefers stored id over outbound-parent recursion)', () => {
    seedMessage('message-1', { content: 'First' });
    seedMessage('message-2', {
      content: 'Second',
      parentId: 'message-1',
      previousUserMessageId: 'message-1',
    });
    const message2 = mocks.store.getById('messages', 'message-2');
    expect(message2).toBeTruthy();
    expect(
      __agentChatTestUtils.getPreviousUserMessageIdForPromptPath('conversation-1', message2!),
    ).toBe('message-1');
  });

  it('puts the exact latest chat turn and user message at the top of queued-run prompts', () => {
    seedMessage('message-1', { content: 'First user message' });
    seedMessage('assistant-1', {
      direction: 'inbound',
      content: 'First assistant response',
      parentId: 'message-1',
    });
    seedMessage('message-2', {
      content: 'Latest queued message',
      parentId: 'assistant-1',
      previousUserMessageId: 'message-1',
    });

    const prompt = __agentChatTestUtils.buildPromptWithHistory(
      'agent-1',
      'conversation-1',
      undefined,
      'message-2',
      { turnId: 'turn-2' },
    );

    expect(prompt).toContain('chatTurnId: turn-2');
    expect(prompt).toContain('latestUserMessageId: message-2');
    expect(prompt.indexOf('Latest User Message')).toBeLessThan(
      prompt.indexOf('Continue the conversation below'),
    );
    expect(prompt.indexOf('User: Latest queued message')).toBeLessThan(
      prompt.indexOf('User: First user message'),
    );
  });

  it('keeps branch switching working after editing a message that was initially queued', () => {
    seedMessage('message-1', {
      content: 'First',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    seedTurn('turn-1', {
      userMessageId: 'message-1',
      status: 'completed',
      createdAt: '2026-05-16T12:00:01.000Z',
    });
    seedMessage('message-2', {
      content: 'Queued follow-up, later completed',
      parentId: 'message-1',
      previousUserMessageId: 'message-1',
      createdAt: '2026-05-16T12:00:02.000Z',
    });
    seedTurn('turn-2', {
      parentTurnId: 'turn-1',
      userMessageId: 'message-2',
      status: 'completed',
      createdAt: '2026-05-16T12:00:03.000Z',
    });

    const editedMessage = editMessageAndBranch(
      'conversation-1',
      'message-2',
      'Edited queued follow-up',
      {
        newMessageId: 'message-2-edit',
      },
    );
    const edit = enqueueAgentPrompt('agent-1', 'conversation-1', 'Edited queued follow-up', {
      mode: 'respond_to_message',
      targetMessageId: String(editedMessage.id),
      createdById: 'test-user',
      turnType: 'edit',
      supersedesMessageId: 'message-2',
    });

    expect(editedMessage).toMatchObject({
      id: 'message-2-edit',
      parentId: 'message-1',
      previousUserMessageId: 'message-1',
    });
    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual(['turn-1', String(edit.queueItem.turnId)]);

    switchBranch('conversation-1', 'message-2');
    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual(['turn-1', 'turn-2']);

    switchBranch('conversation-1', 'message-2-edit');
    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual(['turn-1', String(edit.queueItem.turnId)]);
  });

  it('switches by exact turn when branch siblings share a user message id', () => {
    seedMessage('message-1', {
      content: 'First',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    seedTurn('turn-1', {
      userMessageId: 'message-1',
      status: 'completed',
      createdAt: '2026-05-16T12:00:01.000Z',
    });
    seedTurn('turn-2', {
      userMessageId: 'message-1',
      status: 'completed',
      createdAt: '2026-05-16T12:00:02.000Z',
    });
    seedTurn('turn-3', {
      userMessageId: 'message-1',
      status: 'completed',
      createdAt: '2026-05-16T12:00:03.000Z',
    });

    switchBranchTurn('conversation-1', 'turn-2');

    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual(['turn-2']);
    const metadata = mocks.store.getById('conversations', 'conversation-1')?.metadata;
    const parsedMetadata =
      typeof metadata === 'string' ? JSON.parse(metadata) : (metadata as Record<string, unknown>);
    expect(parsedMetadata.activeBranches).toMatchObject({
      'turn:__root__': 'turn-2',
      'user:__root__': 'message-1',
    });
  });

  it('switches a legacy edited follow-up by turn lineage when message previous user metadata is missing', () => {
    seedConversation({
      activeBranches: {
        'user:__root__': 'message-1-edit',
        'turn:__root__': 'turn-1-edit',
      },
    });
    seedMessage('message-1', {
      content: 'First',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    seedTurn('turn-1', {
      userMessageId: 'message-1',
      status: 'superseded',
      createdAt: '2026-05-16T12:00:01.000Z',
    });
    seedMessage('message-2', {
      content: 'Second',
      parentId: 'message-1',
      previousUserMessageId: 'message-1',
      createdAt: '2026-05-16T12:00:02.000Z',
    });
    seedTurn('turn-2', {
      parentTurnId: 'turn-1',
      userMessageId: 'message-2',
      status: 'superseded',
      createdAt: '2026-05-16T12:00:03.000Z',
    });
    seedMessage('message-2-edit', {
      content: 'Edited second',
      parentId: 'message-1',
      previousUserMessageId: null,
      createdAt: '2026-05-16T12:00:04.000Z',
    });
    seedTurn('turn-2-edit', {
      parentTurnId: 'turn-1',
      userMessageId: 'message-2-edit',
      status: 'completed',
      turnType: 'edit',
      supersedesTurnId: 'turn-2',
      createdAt: '2026-05-16T12:00:05.000Z',
    });
    seedMessage('message-1-edit', {
      content: 'Edited first',
      parentId: 'message-1',
      previousUserMessageId: null,
      createdAt: '2026-05-16T12:00:06.000Z',
    });
    seedTurn('turn-1-edit', {
      parentTurnId: null,
      userMessageId: 'message-1-edit',
      status: 'completed',
      turnType: 'edit',
      supersedesTurnId: 'turn-1',
      createdAt: '2026-05-16T12:00:07.000Z',
    });

    switchBranch('conversation-1', 'message-2-edit');

    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual(['turn-1', 'turn-2-edit']);
    const metadata = mocks.store.getById('conversations', 'conversation-1')?.metadata;
    const parsedMetadata =
      typeof metadata === 'string' ? JSON.parse(metadata) : (metadata as Record<string, unknown>);
    expect(parsedMetadata.activeBranches).toMatchObject({
      'user:__root__': 'message-1',
      'turn:__root__': 'turn-1',
      'user:message-1': 'message-2-edit',
      'turn:turn-1': 'turn-2-edit',
    });
  });

  it('persists outbound parent as previous user id when client omits previousUserMessageId on a queued follow-up', () => {
    mocks.store.insert('agent_runs', {
      id: 'active-run',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      conversationId: 'conversation-1',
      responseParentId: 'message-1',
      startedAt: '2026-05-16T11:59:00.000Z',
    });

    enqueueAgentPrompt('agent-1', 'conversation-1', 'First queued prompt', {
      queuedMessageId: 'message-1',
      createdById: 'test-user',
    });
    enqueueAgentPrompt('agent-1', 'conversation-1', 'Second queued prompt', {
      queuedMessageId: 'message-2',
      createdById: 'test-user',
    });

    const message2 = mocks.store.getById('messages', 'message-2');
    expect(message2).toMatchObject({
      parentId: 'message-1',
      previousUserMessageId: 'message-1',
    });
    expect(
      __agentChatTestUtils.getPreviousUserMessageIdForPromptPath('conversation-1', message2!),
    ).toBe('message-1');
  });

  it('persists queued text prompts as messages and turns before execution drains', () => {
    mocks.store.insert('agent_runs', {
      id: 'active-run',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      conversationId: 'conversation-1',
      responseParentId: 'active-message',
      startedAt: '2026-05-16T11:59:00.000Z',
    });

    const first = enqueueAgentPrompt('agent-1', 'conversation-1', 'First queued prompt', {
      queuedMessageId: 'message-1',
      createdById: 'test-user',
    });
    const second = enqueueAgentPrompt('agent-1', 'conversation-1', 'Second queued prompt', {
      queuedMessageId: 'message-2',
      previousUserMessageId: 'message-1',
      createdById: 'test-user',
    });

    expect(mocks.store.getById('messages', 'message-1')).toMatchObject({
      direction: 'outbound',
      content: 'First queued prompt',
    });
    expect(mocks.store.getById('messages', 'message-2')).toMatchObject({
      direction: 'outbound',
      content: 'Second queued prompt',
      previousUserMessageId: 'message-1',
    });
    expect(first.queueItem.turnId).toBeTruthy();
    expect(second.queueItem.turnId).toBeTruthy();
    expect(mocks.store.getById('agentChatTurns', String(first.queueItem.turnId))).toMatchObject({
      userMessageId: 'message-1',
      status: 'queued',
    });
    expect(mocks.store.getById('agentChatTurns', String(second.queueItem.turnId))).toMatchObject({
      parentTurnId: first.queueItem.turnId,
      userMessageId: 'message-2',
      status: 'queued',
    });
  });

  it('keeps stopped turns selectable and allows a follow-up child turn', () => {
    seedMessage('message-1', { content: 'Stop this prompt' });
    seedTurn('turn-1', {
      userMessageId: 'message-1',
      status: 'running',
      runId: 'run-1',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-1',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      conversationId: 'conversation-1',
      responseParentId: 'message-1',
      turnId: 'turn-1',
      startedAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'processing',
      turnId: 'turn-1',
      runId: 'run-1',
      queuedMessageId: 'message-1',
      attempts: 1,
      maxAttempts: 4,
    });

    expect(cancelProcessingQueueItemForRun('run-1')).toBe(true);
    const followUp = enqueueAgentPrompt('agent-1', 'conversation-1', 'Follow-up after stop', {
      queuedMessageId: 'message-2',
      previousUserMessageId: 'message-1',
      createdById: 'test-user',
    });

    expect(mocks.store.getById('agentChatTurns', 'turn-1')).toMatchObject({
      status: 'stopped',
      runId: 'run-1',
    });
    expect(mocks.store.getById('agentChatQueue', 'queue-1')).toMatchObject({
      status: 'cancelled',
      runId: null,
      errorMessage: 'Cancelled by user',
    });
    expect(mocks.store.getById('agentChatTurns', String(followUp.queueItem.turnId))).toMatchObject({
      parentTurnId: 'turn-1',
      userMessageId: 'message-2',
      status: 'queued',
    });
    const conversationMetadata = JSON.parse(
      String(mocks.store.getById('conversations', 'conversation-1')?.metadata),
    );
    expect(conversationMetadata.activeBranches ?? {}).not.toHaveProperty('turn:turn-1');
  });

  it('creates an explicit edit replacement turn and chains follow-ups from it', () => {
    seedMessage('message-original', {
      content: 'Original prompt',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    seedTurn('turn-original', {
      userMessageId: 'message-original',
      status: 'completed',
      createdAt: '2026-05-16T12:00:01.000Z',
    });

    const editedMessage = editMessageAndBranch(
      'conversation-1',
      'message-original',
      'Edited prompt',
      {
        newMessageId: 'message-edited',
      },
    );
    const edit = enqueueAgentPrompt('agent-1', 'conversation-1', 'Edited prompt', {
      mode: 'respond_to_message',
      targetMessageId: String(editedMessage.id),
      createdById: 'test-user',
      turnType: 'edit',
      supersedesMessageId: 'message-original',
    });
    const followUp = enqueueAgentPrompt('agent-1', 'conversation-1', 'Follow-up to edit', {
      queuedMessageId: 'message-follow-up',
      previousUserMessageId: String(editedMessage.id),
      createdById: 'test-user',
    });

    expect(mocks.store.getById('agentChatTurns', 'turn-original')).toMatchObject({
      status: 'superseded',
    });
    expect(mocks.store.getById('agentChatTurns', String(edit.queueItem.turnId))).toMatchObject({
      userMessageId: 'message-edited',
      supersedesTurnId: 'turn-original',
      turnType: 'edit',
      status: 'queued',
    });
    expect(mocks.store.getById('agentChatTurns', String(followUp.queueItem.turnId))).toMatchObject({
      parentTurnId: edit.queueItem.turnId,
      userMessageId: 'message-follow-up',
    });
  });

  it('does not cancel pending execution for a superseded message when queuing its edit', () => {
    seedMessage('message-original', {
      content: 'Original prompt',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    seedTurn('turn-original', {
      userMessageId: 'message-original',
      status: 'running',
      runId: 'run-original',
      createdAt: '2026-05-16T12:00:01.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-original',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      triggerType: 'chat',
      status: 'running',
      executor: 'remote',
      conversationId: 'conversation-1',
      responseParentId: 'message-original',
      turnId: 'turn-original',
      startedAt: '2026-05-16T12:00:02.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-original',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'processing',
      turnId: 'turn-original',
      runId: 'run-original',
      queuedMessageId: 'message-original',
      attempts: 1,
      maxAttempts: 4,
      createdAt: '2026-05-16T12:00:03.000Z',
    });

    const editedMessage = editMessageAndBranch(
      'conversation-1',
      'message-original',
      'Edited prompt',
      {
        newMessageId: 'message-edited',
      },
    );
    const edit = enqueueAgentPrompt('agent-1', 'conversation-1', 'Edited prompt', {
      mode: 'respond_to_message',
      targetMessageId: String(editedMessage.id),
      createdById: 'test-user',
      turnType: 'edit',
      supersedesMessageId: 'message-original',
    });

    expect(mocks.cancelRemoteAgentRun).not.toHaveBeenCalled();
    expect(mocks.store.getById('agentChatQueue', 'queue-original')).toMatchObject({
      status: 'processing',
      runId: 'run-original',
    });
    expect(mocks.store.getById('agent_runs', 'run-original')).toMatchObject({
      status: 'running',
    });
    expect(mocks.store.getById('agentChatTurns', 'turn-original')).toMatchObject({
      status: 'superseded',
    });
    expect(mocks.store.getById('agentChatTurns', String(edit.queueItem.turnId))).toMatchObject({
      userMessageId: 'message-edited',
      supersedesTurnId: 'turn-original',
      status: 'queued',
    });
    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual([String(edit.queueItem.turnId)]);

    markAgentChatTurnCompleted('turn-original', {
      assistantMessageId: 'assistant-original',
      runId: 'run-original',
    });
    expect(mocks.store.getById('agentChatTurns', 'turn-original')).toMatchObject({
      status: 'superseded',
      assistantMessageId: 'assistant-original',
      runId: 'run-original',
    });
    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual([String(edit.queueItem.turnId)]);
  });

  it('keeps a repeated edit on the original branch instead of appending after the previous edit', () => {
    seedMessage('message-original', {
      content: 'Original root prompt',
      parentId: null,
    });
    seedMessage('message-edit-1', {
      content: 'First edited root prompt',
      parentId: 'message-original',
    });
    seedTurn('turn-original', {
      userMessageId: 'message-original',
      status: 'superseded',
      turnType: 'follow_up',
    });
    seedTurn('turn-edit-1', {
      userMessageId: 'message-edit-1',
      status: 'completed',
      turnType: 'edit',
      supersedesTurnId: 'turn-original',
    });

    const editedMessage = editMessageAndBranch(
      'conversation-1',
      'message-edit-1',
      'Second edited root prompt',
      {
        newMessageId: 'message-edit-2',
      },
    );
    const edit = enqueueAgentPrompt('agent-1', 'conversation-1', 'Second edited root prompt', {
      mode: 'respond_to_message',
      targetMessageId: String(editedMessage.id),
      createdById: 'test-user',
      turnType: 'edit',
      supersedesMessageId: 'message-edit-1',
    });

    expect(editedMessage).toMatchObject({
      id: 'message-edit-2',
      parentId: null,
      previousUserMessageId: null,
    });
    expect(mocks.store.getById('agentChatTurns', String(edit.queueItem.turnId))).toMatchObject({
      parentTurnId: null,
      userMessageId: 'message-edit-2',
      supersedesTurnId: 'turn-edit-1',
      turnType: 'edit',
    });
    expect(
      getAgentConversationChatView('agent-1', 'conversation-1').entries.map((entry) => entry.id),
    ).toEqual([String(edit.queueItem.turnId)]);
  });

  it('selects a newly sent follow-up even when branch metadata points at an older sibling', () => {
    seedConversation({
      activeBranches: {
        'user:message-root': 'message-old-child',
      },
    });
    seedMessage('message-root', {
      content: 'Root prompt',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'assistant-root',
      conversationId: 'conversation-1',
      direction: 'inbound',
      type: 'text',
      content: 'Root response',
      status: 'sent',
      attachments: null,
      metadata: null,
      parentId: 'message-root',
      createdAt: '2026-05-16T12:01:00.000Z',
    });
    seedMessage('message-old-child', {
      content: 'Older follow-up',
      parentId: 'assistant-root',
      previousUserMessageId: 'message-root',
      createdAt: '2026-05-16T12:02:00.000Z',
    });
    seedTurn('turn-root', {
      userMessageId: 'message-root',
      assistantMessageId: 'assistant-root',
      status: 'completed',
      createdAt: '2026-05-16T12:00:00.000Z',
    });
    seedTurn('turn-old-child', {
      parentTurnId: 'turn-root',
      userMessageId: 'message-old-child',
      status: 'completed',
      createdAt: '2026-05-16T12:02:00.000Z',
    });

    const followUp = enqueueAgentPrompt('agent-1', 'conversation-1', 'Latest follow-up', {
      queuedMessageId: 'message-latest-child',
      previousUserMessageId: 'message-root',
      createdById: 'test-user',
    });

    expect(mocks.store.getById('agentChatTurns', String(followUp.queueItem.turnId))).toMatchObject({
      parentTurnId: 'turn-root',
      userMessageId: 'message-latest-child',
    });
    expect(
      JSON.parse(String(mocks.store.getById('conversations', 'conversation-1')?.metadata))
        .activeBranches,
    ).toMatchObject({
      'user:message-root': 'message-latest-child',
    });
  });

  it('materializes legacy message-only turns before continuing an old chat', () => {
    seedMessage('legacy-user-1', {
      content: 'Old prompt',
      createdAt: '2026-05-16T11:00:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'legacy-assistant-1',
      conversationId: 'conversation-1',
      direction: 'inbound',
      type: 'text',
      content: 'Old response',
      status: 'sent',
      attachments: null,
      metadata: null,
      parentId: 'legacy-user-1',
      createdAt: '2026-05-16T11:01:00.000Z',
    });
    seedMessage('legacy-user-2', {
      content: 'Second old prompt',
      parentId: 'legacy-assistant-1',
      previousUserMessageId: null,
      createdAt: '2026-05-16T11:02:00.000Z',
    });
    mocks.store.insert('messages', {
      id: 'legacy-assistant-2',
      conversationId: 'conversation-1',
      direction: 'inbound',
      type: 'text',
      content: 'Second old response',
      status: 'sent',
      attachments: null,
      metadata: null,
      parentId: 'legacy-user-2',
      createdAt: '2026-05-16T11:03:00.000Z',
    });

    const before = getAgentConversationChatView('agent-1', 'conversation-1');
    expect(before.entries.map((turn) => turn.userMessage?.id)).toEqual([
      'legacy-user-1',
      'legacy-user-2',
    ]);

    const followUp = enqueueAgentPrompt('agent-1', 'conversation-1', 'Continue old chat', {
      queuedMessageId: 'legacy-follow-up',
      previousUserMessageId: 'legacy-user-2',
      createdById: 'test-user',
    });
    const legacyTurn1 = mocks.store
      .getAll('agentChatTurns')
      .find((turn) => turn.userMessageId === 'legacy-user-1');
    const legacyTurn2 = mocks.store
      .getAll('agentChatTurns')
      .find((turn) => turn.userMessageId === 'legacy-user-2');

    expect(legacyTurn1).toMatchObject({
      source: 'legacy_message',
      userMessageId: 'legacy-user-1',
      assistantMessageId: 'legacy-assistant-1',
    });
    expect(legacyTurn2).toMatchObject({
      source: 'legacy_message',
      parentTurnId: legacyTurn1?.id,
      userMessageId: 'legacy-user-2',
      assistantMessageId: 'legacy-assistant-2',
    });
    expect(mocks.store.getById('agentChatTurns', String(followUp.queueItem.turnId))).toMatchObject({
      parentTurnId: legacyTurn2?.id,
      userMessageId: 'legacy-follow-up',
    });

    const after = getAgentConversationChatView('agent-1', 'conversation-1');
    expect(after.entries.map((turn) => turn.userMessage?.id)).toEqual([
      'legacy-user-1',
      'legacy-user-2',
      'legacy-follow-up',
    ]);
  });

  it('marks failed prompt turns when queue insertion cannot proceed', () => {
    mocks.hasConnectedRemoteAgentRunner.mockReturnValue(false);
    mocks.hasAvailableRemoteAgentRunner.mockReturnValue(false);

    expect(() =>
      enqueueAgentPrompt('agent-1', 'conversation-1', 'Prompt with no runner', {
        queuedMessageId: 'message-failed',
        createdById: 'test-user',
      }),
    ).toThrow(/No remote agent runner is connected/i);

    const turn = mocks.store
      .getAll('agentChatTurns')
      .find((candidate) => candidate.userMessageId === 'message-failed');
    expect(mocks.store.getById('messages', 'message-failed')).toMatchObject({
      content: 'Prompt with no runner',
    });
    expect(turn).toMatchObject({
      status: 'failed',
      userMessageId: 'message-failed',
    });
    expect(mocks.store.getAll('agentChatQueue')).toHaveLength(0);
  });

  it('uses the same message-turn-queue path for attachment prompts', () => {
    const queued = enqueueAgentPrompt('agent-1', 'conversation-1', '', {
      queuedMessageId: 'message-attachment',
      createdById: 'test-user',
      attachments: [
        {
          type: 'file',
          fileName: 'spec.txt',
          mimeType: 'text/plain',
          fileSize: 12,
          storagePath: '/chat-uploads/spec.txt',
        },
      ],
    });

    expect(mocks.store.getById('messages', 'message-attachment')).toMatchObject({
      type: 'file',
      attachments: [
        {
          type: 'file',
          fileName: 'spec.txt',
          storagePath: '/chat-uploads/spec.txt',
        },
      ],
    });
    expect(mocks.store.getById('agentChatTurns', String(queued.queueItem.turnId))).toMatchObject({
      userMessageId: 'message-attachment',
      status: 'queued',
    });
    expect(queued.queueItem).toMatchObject({
      queuedMessageId: 'message-attachment',
      turnId: queued.queueItem.turnId,
      attachments: [
        {
          type: 'file',
          fileName: 'spec.txt',
          storagePath: '/chat-uploads/spec.txt',
        },
      ],
    });
  });

  it('keeps retry, remove, and reorder queue operations in sync with turn state', () => {
    seedMessage('message-1', { content: 'First' });
    seedMessage('message-2', {
      content: 'Second',
      previousUserMessageId: 'message-1',
      parentId: 'message-1',
    });
    seedMessage('message-3', {
      content: 'Third',
      previousUserMessageId: 'message-2',
      parentId: 'message-2',
    });
    seedTurn('turn-1', {
      userMessageId: 'message-1',
      status: 'failed',
      createdAt: '2026-05-16T12:00:01.000Z',
    });
    seedTurn('turn-2', {
      userMessageId: 'message-2',
      status: 'queued',
      createdAt: '2026-05-16T12:00:02.000Z',
    });
    seedTurn('turn-3', {
      userMessageId: 'message-3',
      status: 'queued',
      createdAt: '2026-05-16T12:00:03.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'failed',
      turnId: 'turn-1',
      queuedMessageId: 'message-1',
      attempts: 4,
      maxAttempts: 4,
      errorMessage: 'Model failed',
      createdAt: '2026-05-16T12:00:01.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-2',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'queued',
      turnId: 'turn-2',
      queuedMessageId: 'message-2',
      attempts: 0,
      maxAttempts: 4,
      createdAt: '2026-05-16T12:00:02.000Z',
    });
    mocks.store.insert('agentChatQueue', {
      id: 'queue-3',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      mode: 'append_prompt',
      status: 'queued',
      turnId: 'turn-3',
      queuedMessageId: 'message-3',
      attempts: 0,
      maxAttempts: 4,
      createdAt: '2026-05-16T12:00:03.000Z',
    });

    retryQueueItem('queue-1', 'agent-1', 'conversation-1');
    expect(mocks.store.getById('agentChatTurns', 'turn-1')).toMatchObject({
      status: 'queued',
    });

    reorderQueueItems('agent-1', 'conversation-1', ['queue-3', 'queue-1', 'queue-2']);
    const queueOrder = mocks.store
      .getAll('agentChatQueue')
      .filter((item) => item.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((item) => item.id);
    const turnOrder = mocks.store
      .getAll('agentChatTurns')
      .filter((turn) => turn.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((turn) => turn.id);
    expect(queueOrder).toEqual(['queue-3', 'queue-1', 'queue-2']);
    expect(turnOrder).toEqual(['turn-3', 'turn-1', 'turn-2']);

    deleteQueueItem('queue-1', 'agent-1', 'conversation-1');
    expect(mocks.store.getById('agentChatQueue', 'queue-1')).toBeNull();
    expect(mocks.store.getById('agentChatTurns', 'turn-1')).toMatchObject({
      status: 'stopped',
      metadata: { errorMessage: 'Removed from queue' },
    });
  });
});
