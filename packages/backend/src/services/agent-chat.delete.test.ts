import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = {
    transaction: vi.fn(),
    delete: vi.fn(),
  };

  return {
    store,
    clearAgentRunConversationReferences: vi.fn(),
    deleteAllMessagesForConversation: vi.fn(),
    deleteAllMessageDraftsForConversation: vi.fn(),
    deleteChatQueueItemsForConversation: vi.fn(),
  };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/repositories/agent-execution-repository.js', () => ({
  AGENT_CHAT_QUEUE_COLLECTION: 'agentChatQueue',
  clearAgentRunConversationReferences: mocks.clearAgentRunConversationReferences,
  countQueuedAppendPromptsForConversation: vi.fn(() => 0),
  countRunningAgentRunsWithLivePid: vi.fn(() => 0),
  deleteChatQueueItemsForConversation: mocks.deleteChatQueueItemsForConversation,
  findAgentRunIdsForRetentionCleanup: vi.fn(() => []),
  findAgentRunsWithLegacyTriggerTypes: vi.fn(() => []),
  findChatQueueItemProcessingForRunId: vi.fn(() => null),
  findLivePersistedChatRuns: vi.fn(() => []),
  listChatQueueItemsWithStatusNative: vi.fn(async () => []),
  listConversationChatQueueItems: vi.fn(() => []),
}));
vi.mock('../db/repositories/message-drafts-repository.js', () => ({
  deleteAllMessageDraftsForConversation: mocks.deleteAllMessageDraftsForConversation,
}));
vi.mock('../db/repositories/messages-repository.js', () => ({
  compareMessagesChronologically: vi.fn(() => 0),
  deleteAllMessagesForConversation: mocks.deleteAllMessagesForConversation,
  listMessagesByConversationId: vi.fn(() => []),
  listMessagesByConversationIdNative: vi.fn(async () => ({ entries: [], total: 0 })),
}));
vi.mock('../db/repositories/api-keys-repository.js', () => ({
  getApiKeyRecord: vi.fn(() => null),
}));
vi.mock('./agents.js', () => ({
  getAgent: vi.fn(() => null),
  listAgents: vi.fn(async () => []),
  prepareAgentWorkspaceAccess: vi.fn(),
}));
vi.mock('./agent-runners.js', () => ({
  dispatchRemoteAgentJob: vi.fn(),
  getRemoteAgentRunnerUnavailableMessage: vi.fn(() => 'No runner available'),
  hasAvailableRemoteAgentRunner: vi.fn(() => false),
  hasConnectedRemoteAgentRunner: vi.fn(() => false),
}));
vi.mock('./runner-devices.js', () => ({
  workspaceIdsForAgentGroup: vi.fn(() => []),
}));
vi.mock('../lib/port-allocator.js', () => ({
  allocatePort: vi.fn(async () => 3000),
  releasePort: vi.fn(),
}));

import { deleteAgentConversation } from './agent-chat.js';

describe('deleteAgentConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.transaction.mockImplementation(async (operation: () => Promise<unknown>) =>
      operation(),
    );
    mocks.store.delete.mockReturnValue({ id: 'conversation-1' });
    mocks.clearAgentRunConversationReferences.mockResolvedValue(undefined);
  });

  it('deletes dependent chat state and clears run references before deleting the conversation', async () => {
    await expect(deleteAgentConversation('conversation-1')).resolves.toEqual({
      id: 'conversation-1',
    });

    expect(mocks.store.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAllMessagesForConversation).toHaveBeenCalledWith('conversation-1');
    expect(mocks.deleteAllMessageDraftsForConversation).toHaveBeenCalledWith('conversation-1');
    expect(mocks.deleteChatQueueItemsForConversation).toHaveBeenCalledWith('conversation-1');
    expect(mocks.clearAgentRunConversationReferences).toHaveBeenCalledWith('conversation-1');
    expect(mocks.store.delete).toHaveBeenCalledWith('conversations', 'conversation-1');

    expect(
      mocks.clearAgentRunConversationReferences.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.store.delete.mock.invocationCallOrder[0]);
  });
});
