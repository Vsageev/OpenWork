import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = {
    getAll: vi.fn(),
    getById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  return {
    store,
    getAgent: vi.fn(),
    hasConnectedRemoteAgentRunner: vi.fn(),
    hasAvailableRemoteAgentRunner: vi.fn(),
  };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/connection.js', () => ({ store: mocks.store }));
vi.mock('./agents.js', () => ({
  getAgent: mocks.getAgent,
  listAgents: vi.fn(() => []),
  prepareAgentWorkspaceAccess: vi.fn(),
}));
vi.mock('./agent-runners.js', () => ({
  dispatchRemoteAgentJob: vi.fn(),
  getRemoteAgentRunnerUnavailableMessage: vi.fn(
    (workspaceId?: string | null) =>
      workspaceId
        ? 'No remote agent runner is connected. Start or pair an OpenWork runner, then try again.'
        : 'No remote agent runner is connected. Start or pair an OpenWork runner, then try again.',
  ),
  hasAvailableRemoteAgentRunner: mocks.hasAvailableRemoteAgentRunner,
  hasConnectedRemoteAgentRunner: mocks.hasConnectedRemoteAgentRunner,
}));

import { __agentChatTestUtils, enqueueAgentPrompt } from './agent-chat.js';

describe('enqueueAgentPrompt runner workspace validation', () => {
  beforeEach(() => {
    const records = new Map<string, Record<string, unknown>>();
    const keyFor = (collection: string, id: string) => `${collection}:${id}`;

    mocks.store.getAll.mockReset();
    mocks.store.getById.mockReset();
    mocks.store.insert.mockReset();
    mocks.store.update.mockReset();
    mocks.store.getById.mockImplementation((collection: string, id: string) =>
      records.get(keyFor(collection, id)) ?? null,
    );
    mocks.store.insert.mockImplementation((collection: string, data: Record<string, unknown>) => {
      const record = {
        ...data,
        id: typeof data.id === 'string' ? data.id : `${collection}-1`,
        createdAt: '2026-05-16T12:00:00.000Z',
        updatedAt: '2026-05-16T12:00:00.000Z',
      };
      records.set(keyFor(collection, record.id), record);
      return record;
    });
    mocks.store.update.mockImplementation(
      (collection: string, id: string, data: Record<string, unknown>) => {
        const record = {
          ...(records.get(keyFor(collection, id)) ?? {}),
          ...data,
          id,
          updatedAt: '2026-05-16T12:00:01.000Z',
        };
        records.set(keyFor(collection, id), record);
        return record;
      },
    );
    mocks.getAgent.mockReset();
    mocks.hasConnectedRemoteAgentRunner.mockReset();
    mocks.hasAvailableRemoteAgentRunner.mockReset();
  });

  it('persists a failed prompt turn when the agent is not assigned to a workspace', () => {
    mocks.getAgent.mockReturnValue({ id: 'agent-1', groupId: null });
    mocks.store.getAll.mockImplementation((collection: string) =>
      collection === 'workspaces' ? [{ id: 'workspace-1', agentGroupIds: [] }] : [],
    );

    expect(() =>
      enqueueAgentPrompt('agent-1', 'conversation-1', 'hello', {
        queuedMessageId: 'message-1',
      }),
    ).toThrow(/not assigned to a workspace/i);
    expect(mocks.hasConnectedRemoteAgentRunner).not.toHaveBeenCalled();
    expect(mocks.store.insert).toHaveBeenCalledWith(
      'messages',
      expect.objectContaining({ id: 'message-1', content: 'hello' }),
    );
    expect(mocks.store.insert).toHaveBeenCalledWith(
      'agentChatTurns',
      expect.objectContaining({ userMessageId: 'message-1', status: 'queued' }),
    );
    expect(mocks.store.insert).not.toHaveBeenCalledWith(
      'agentChatQueue',
      expect.anything(),
    );
    expect(mocks.store.update).toHaveBeenCalledWith(
      'agentChatTurns',
      'agentChatTurns-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('checks runner availability in the agent workspace, not globally', () => {
    mocks.getAgent.mockReturnValue({ id: 'agent-1', groupId: 'group-1', model: 'codex' });
    mocks.store.getAll.mockImplementation((collection: string) =>
      collection === 'workspaces'
        ? [{ id: 'workspace-1', userId: 'user-1', agentGroupIds: ['group-1'] }]
        : [],
    );
    mocks.hasConnectedRemoteAgentRunner.mockReturnValue(false);

    expect(() =>
      enqueueAgentPrompt('agent-1', 'conversation-1', 'hello', {
        queuedMessageId: 'message-1',
      }),
    ).toThrow(/No remote agent runner is connected/i);
    expect(mocks.hasConnectedRemoteAgentRunner).toHaveBeenCalledWith('user-1', 'workspace-1');
    expect(mocks.store.insert).toHaveBeenCalledWith(
      'messages',
      expect.objectContaining({ id: 'message-1', content: 'hello' }),
    );
    expect(mocks.store.insert).not.toHaveBeenCalledWith(
      'agentChatQueue',
      expect.anything(),
    );
    expect(mocks.store.update).toHaveBeenCalledWith(
      'agentChatTurns',
      'agentChatTurns-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });
});

describe('agent chat fallback retry guard', () => {
  beforeEach(() => {
    mocks.store.getById.mockReset();
  });

  it('does not retry with fallback after a user-stopped run', () => {
    mocks.store.getById.mockReturnValue({
      id: 'run-1',
      killedByUser: true,
      errorMessage: 'Killed by user',
    });

    expect(
      __agentChatTestUtils.shouldAttemptFallbackRetry({
        runId: 'run-1',
        errorMessage: 'Remote runner cancelled the job',
        isFallback: false,
        hasFallback: true,
      }),
    ).toBe(false);
  });

  it('allows fallback for ordinary primary-run failures', () => {
    mocks.store.getById.mockReturnValue({
      id: 'run-1',
      killedByUser: false,
      errorMessage: 'Remote runner exited with code 1',
    });

    expect(
      __agentChatTestUtils.shouldAttemptFallbackRetry({
        runId: 'run-1',
        errorMessage: 'Remote runner exited with code 1',
        isFallback: false,
        hasFallback: true,
      }),
    ).toBe(true);
  });
});
