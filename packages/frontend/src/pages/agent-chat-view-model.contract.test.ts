import { describe, expect, it } from 'vitest';
import {
  buildAgentConversationViewModel,
  type AgentChatMessage,
  type AgentChatQueueItem,
  type AgentConversationRunSummary,
} from './agent-chat-view-model';

function failContract(options: {
  componentName: string;
  stateInput: string;
  contractName: string;
  expected: string;
  actual: string;
}): never {
  throw new Error(
    `${options.componentName} view-model contract violated: stateInput=${options.stateInput} classOrContractName=${options.contractName} expected=${options.expected} actual=${options.actual}`,
  );
}

const baseTime = '2026-05-15T10:00:00.000Z';

function msg(partial: Partial<AgentChatMessage> & Pick<AgentChatMessage, 'id' | 'direction'>): AgentChatMessage {
  return {
    content: '',
    createdAt: baseTime,
    type: 'text',
    metadata: null,
    attachments: null,
    parentId: null,
    previousUserMessageId: null,
    ...partial,
  };
}

function queueAppend(partial: Partial<AgentChatQueueItem> & Pick<AgentChatQueueItem, 'id' | 'agentId' | 'conversationId'>): AgentChatQueueItem {
  return {
    mode: 'append_prompt',
    prompt: '',
    status: 'queued',
    attempts: 0,
    createdAt: baseTime,
    targetMessageId: null,
    queuedMessageId: null,
    previousUserMessageId: null,
    runId: null,
    errorMessage: null,
    ...partial,
  };
}

describe('buildAgentConversationViewModel contract', () => {
  const activeAgentId = 'agent-a';
  const activeConvId = 'conv-a';
  const activeKey = `${activeAgentId}:${activeConvId}`;

  it('negative control: queue items for another conversation never populate queuedMessages or streaming for the active chat', () => {
    const mRoot = msg({
      id: 'u0',
      direction: 'outbound',
      previousUserMessageId: null,
      content: 'root',
    });
    const mFollow = msg({
      id: 'u1',
      direction: 'outbound',
      previousUserMessageId: 'u0',
      content: 'follow-up queued style',
    });
    const inbound = msg({
      id: 'a0',
      direction: 'inbound',
      parentId: 'u0',
      content: 'assistant',
    });

    const foreignQueued: AgentChatQueueItem = queueAppend({
      id: 'q-foreign',
      agentId: activeAgentId,
      conversationId: 'conv-other',
      status: 'queued',
      prompt: 'leak attempt',
      queuedMessageId: 'ghost-msg',
      previousUserMessageId: null,
    });

    const vm = buildAgentConversationViewModel({
      messages: [mRoot, inbound, mFollow],
      queueItems: [foreignQueued],
      activeConversationRuns: [],
      activeAgentId,
      activeConvId,
      activeConversationKey: activeKey,
      optimisticResponseParentIds: {},
    });

    if (vm.queuedQueueItems.length !== 0) {
      failContract({
        componentName: 'buildAgentConversationViewModel',
        stateInput: 'activeConvId=conv-a queueItems include conv-other append_prompt',
        contractName: 'queuedQueueItems.length',
        expected: '0',
        actual: String(vm.queuedQueueItems.length),
      });
    }
    const leaked = vm.queuedMessages.some(
      (row) => row.queueItem?.id === 'q-foreign' || row.message.content === 'leak attempt',
    );
    if (leaked) {
      failContract({
        componentName: 'buildAgentConversationViewModel',
        stateInput: 'foreign conv queue forced into options.queueItems',
        contractName: 'queuedMessages foreign leak',
        expected: 'no rows tied to foreign queue item',
        actual: JSON.stringify(vm.queuedMessages.map((r) => ({ mid: r.message.id, qid: r.queueItem?.id }))),
      });
    }
    if (vm.showStreamingBubble) {
      failContract({
        componentName: 'buildAgentConversationViewModel',
        stateInput: 'foreign-only queue items',
        contractName: 'showStreamingBubble',
        expected: 'false',
        actual: 'true',
      });
    }
  });

  it('negative control: running agent run for another conversation does not become activeConversationRun', () => {
    const m0 = msg({ id: 'u0', direction: 'outbound', content: 'hi' });
    const a0 = msg({ id: 'r0', direction: 'inbound', parentId: 'u0', content: 'hey' });

    const foreignRun: AgentConversationRunSummary = {
      id: 'run-foreign',
      agentId: activeAgentId,
      conversationId: 'conv-other',
      responseParentId: 'u0',
      status: 'running',
      startedAt: baseTime,
    };

    const vm = buildAgentConversationViewModel({
      messages: [m0, a0],
      queueItems: [],
      activeConversationRuns: [foreignRun],
      activeAgentId,
      activeConvId,
      activeConversationKey: activeKey,
      optimisticResponseParentIds: {},
    });

    if (vm.activeConversationRun !== null) {
      failContract({
        componentName: 'buildAgentConversationViewModel',
        stateInput: 'activeConvId=conv-a runs include conv-other',
        contractName: 'activeConversationRun',
        expected: 'null',
        actual: vm.activeConversationRun.id,
      });
    }
  });

  it('active conversation: queued append and running output surface only for matching agent+conversation', () => {
    // No inbound reply yet for u0 → follow-up u1 is "queued style" and still drives queue UI + streaming.
    const m0 = msg({ id: 'u0', direction: 'outbound', content: 'hi' });
    const m1 = msg({
      id: 'u1',
      direction: 'outbound',
      previousUserMessageId: 'u0',
      content: 'queued user',
    });

    const localQueued = queueAppend({
      id: 'q-local',
      agentId: activeAgentId,
      conversationId: activeConvId,
      status: 'processing',
      prompt: 'queued user',
      queuedMessageId: 'u1',
      previousUserMessageId: 'u0',
    });

    // Run anchored to visible u0 (u1 is hidden from visibleMessages while queued-style).
    const localRun: AgentConversationRunSummary = {
      id: 'run-local',
      agentId: activeAgentId,
      conversationId: activeConvId,
      responseParentId: 'u0',
      status: 'running',
      startedAt: baseTime,
    };

    const vm = buildAgentConversationViewModel({
      messages: [m0, m1],
      queueItems: [localQueued],
      activeConversationRuns: [localRun],
      activeAgentId,
      activeConvId,
      activeConversationKey: activeKey,
      optimisticResponseParentIds: {},
    });

    expect(vm.queuedQueueItems.some((q) => q.id === 'q-local')).toBe(true);
    expect(vm.queuedMessages.some((r) => r.message.id === 'u1')).toBe(true);
    expect(vm.activeConversationRun?.id).toBe('run-local');
    expect(vm.showStreamingBubble).toBe(true);
  });

  it('negative control: simulating stale queue row ids after active conversation switch — prior conv queue item must not match new activeConvId', () => {
    const m0 = msg({ id: 'u0', direction: 'outbound', content: 'hi' });
    const staleItem = queueAppend({
      id: 'q-stale',
      agentId: activeAgentId,
      conversationId: 'conv-old',
      status: 'queued',
      prompt: 'old conv',
      queuedMessageId: 'u-old',
      previousUserMessageId: null,
    });

    const vm = buildAgentConversationViewModel({
      messages: [m0],
      queueItems: [staleItem],
      activeConversationRuns: [],
      activeAgentId,
      activeConvId,
      activeConversationKey: activeKey,
      optimisticResponseParentIds: {},
    });

    expect(vm.queuedQueueItems).toHaveLength(0);
    expect(vm.queuedMessages.filter((r) => r.queueItem?.id === 'q-stale')).toHaveLength(0);
  });
});
