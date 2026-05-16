import { describe, expect, it } from 'vitest';
import {
  buildAgentConversationViewModel,
  type AgentChatMessage,
  type AgentChatQueueItem,
  type AgentConversationChatView,
  type AgentConversationChatTurn,
  type AgentConversationRunSummary,
} from './agent-chat-view-model';

const baseMessage = (overrides: Partial<AgentChatMessage>): AgentChatMessage => ({
  id: 'message-1',
  direction: 'outbound',
  content: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
  type: 'text',
  metadata: null,
  attachments: null,
  parentId: null,
  previousUserMessageId: null,
  ...overrides,
});

function queueItem(overrides: Partial<AgentChatQueueItem>): AgentChatQueueItem {
  return {
    id: 'queue-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    mode: 'append_prompt',
    prompt: 'queued prompt',
    status: 'queued',
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    queuedMessageId: 'queued-message-1',
    previousUserMessageId: null,
    ...overrides,
  };
}

function canonicalTurn(overrides: Partial<AgentConversationChatTurn>): AgentConversationChatTurn {
  const id = overrides.id ?? 'turn-1';
  const userMessageId = overrides.userMessage?.id ?? `message-${id}`;
  const createdAt = overrides.createdAt ?? '2026-01-01T00:00:00.000Z';
  return {
    id,
    parentTurnId: null,
    status: 'completed',
    turnType: 'follow_up',
    userMessage: {
      id: userMessageId,
      direction: 'outbound',
      type: 'text',
      content: userMessageId,
      status: 'sent',
      metadata: null,
      attachments: null,
      createdAt,
      updatedAt: null,
    },
    assistantMessage: null,
    execution: { queue: null, run: null },
    branch: {
      parentTurnId: null,
      isSelected: true,
      siblingIndex: 0,
      siblingCount: 1,
      siblingIds: [id],
      siblings: [
        {
          turnId: id,
          userMessageId,
          status: 'completed',
          turnType: 'follow_up',
          supersedesTurnId: null,
          isSelected: true,
          createdAt,
        },
      ],
    },
    edit: {
      supersedesTurnId: null,
      supersededByTurnId: null,
      isSuperseded: false,
    },
    availableActions: ['edit_user_message'],
    createdAt,
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function assertVisibleQueueContract(options: {
  activeAgentId: string;
  activeConvId: string;
  activeRunId?: string | null;
  queueItems: AgentChatQueueItem[];
  runs: AgentConversationRunSummary[];
}) {
  for (const item of options.queueItems) {
    if (item.agentId !== options.activeAgentId || item.conversationId !== options.activeConvId) {
      throw new Error(
        `queued chat state contract violated: violatedContract=queue item belongs to active conversation conversationId=${item.conversationId} queueItemId=${item.id} runId=${item.runId ?? options.activeRunId ?? 'none'} expectedConversationId=${options.activeConvId}`,
      );
    }
  }

  for (const run of options.runs) {
    if (
      (run.agentId && run.agentId !== options.activeAgentId) ||
      (run.conversationId && run.conversationId !== options.activeConvId)
    ) {
      throw new Error(
        `active run contract violated: violatedContract=active run belongs to active conversation conversationId=${run.conversationId ?? 'unknown'} queueItemId=none runId=${run.id} expectedConversationId=${options.activeConvId}`,
      );
    }
  }
}

function assertRehydratedQueueContract(options: {
  activeConvId: string;
  activeRunId?: string | null;
  expectedQueueItems: AgentChatQueueItem[];
  viewQueueItems: AgentChatQueueItem[];
  viewQueuedMessages: ReturnType<typeof buildAgentConversationViewModel>['queuedMessages'];
}) {
  const actualQueueItemIds = new Set(options.viewQueueItems.map((item) => item.id));
  const actualQueuedMessageIds = new Set(
    options.viewQueuedMessages.map(({ message }) => message.id),
  );

  for (const item of options.expectedQueueItems) {
    const queueItemId = item.id;
    const queuedMessageId = item.queuedMessageId ?? '';
    if (!actualQueueItemIds.has(queueItemId) || !actualQueuedMessageIds.has(queuedMessageId)) {
      throw new Error(
        `queued chat state contract violated: violatedContract=rehydrated queue item must remain visible conversationId=${item.conversationId} queueItemId=${queueItemId} runId=${item.runId ?? options.activeRunId ?? 'none'} expectedConversationId=${options.activeConvId} expectedQueuedMessageId=${queuedMessageId}`,
      );
    }
  }
}

function assertSidebarRowStateContract(options: {
  activeAgentId: string;
  activeConvId: string;
  rows: {
    componentName: string;
    agentId: string;
    conversationId: string;
    active: boolean;
    queuedCount: number;
    pendingKey: string | null;
  }[];
}) {
  const activeKey = `${options.activeAgentId}:${options.activeConvId}`;
  for (const row of options.rows) {
    if (!row.active) continue;
    const rowKey = `${row.agentId}:${row.conversationId}`;
    if (rowKey !== activeKey || row.pendingKey !== activeKey) {
      throw new Error(
        `${row.componentName} sidebar state contract violated: stateInput=activeAgentId=${options.activeAgentId} activeConvId=${options.activeConvId} rowAgentId=${row.agentId} rowConversationId=${row.conversationId} classOrContractName=active queued sidebar row owner expected=rowKey=${activeKey} pendingKey=${activeKey} actual=rowKey=${rowKey} pendingKey=${row.pendingKey ?? 'none'} queuedCount=${row.queuedCount}`,
      );
    }
  }
}

describe('buildAgentConversationViewModel', () => {
  it('keeps active response state, queued append messages, and visible history in deterministic owners', () => {
    const activeAgentId = 'agent-sidebar-chat';
    const activeConvId = 'conversation-sidebar-chat';
    const view = buildAgentConversationViewModel({
      messages: [
        baseMessage({
          id: 'message-root',
          content: 'root prompt being answered',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        baseMessage({
          id: 'message-queued-processing',
          content: 'queued while first answer runs',
          previousUserMessageId: 'message-root',
          createdAt: '2026-01-01T00:00:10.000Z',
        }),
        baseMessage({
          id: 'message-queued-waiting',
          content: 'queued after processing item',
          previousUserMessageId: 'message-queued-processing',
          createdAt: '2026-01-01T00:00:20.000Z',
        }),
      ],
      queueItems: [
        {
          id: 'queue-processing-append-1',
          agentId: activeAgentId,
          conversationId: activeConvId,
          mode: 'append_prompt',
          prompt: 'queued while first answer runs',
          status: 'processing',
          attempts: 1,
          createdAt: '2026-01-01T00:00:10.000Z',
          queuedMessageId: 'message-queued-processing',
          previousUserMessageId: 'message-root',
          runId: 'run-active-response',
        },
        {
          id: 'queue-queued-append-2',
          agentId: activeAgentId,
          conversationId: activeConvId,
          mode: 'append_prompt',
          prompt: 'queued after processing item',
          status: 'queued',
          attempts: 0,
          createdAt: '2026-01-01T00:00:20.000Z',
          queuedMessageId: 'message-queued-waiting',
          previousUserMessageId: 'message-queued-processing',
        },
      ],
      activeConversationRuns: [
        {
          id: 'run-active-response',
          responseParentId: 'message-root',
          status: 'running',
          startedAt: '2026-01-01T00:00:12.000Z',
        },
      ],
      activeAgentId,
      activeConvId,
      activeConversationKey: `${activeAgentId}:${activeConvId}`,
      optimisticResponseParentIds: {},
    });

    expect(view.visibleMessages.map((message) => message.id)).toEqual(['message-root']);
    expect(view.showStreamingBubble).toBe(true);
    expect(view.activeProcessingTargetMessageId).toBe('message-root');
    expect(view.queuedQueueItems.map((item) => item.id)).toEqual([
      'queue-processing-append-1',
      'queue-queued-append-2',
    ]);
    expect(
      view.queuedMessages.map(({ message, status, queueItem }) => ({
        messageId: message.id,
        status,
        queueItemId: queueItem?.id,
      })),
    ).toEqual([
      {
        messageId: 'message-queued-processing',
        status: 'processing',
        queueItemId: 'queue-processing-append-1',
      },
      {
        messageId: 'message-queued-waiting',
        status: 'queued',
        queueItemId: 'queue-queued-append-2',
      },
    ]);
    expect(view.queuedMessages.at(-1)).toMatchObject({
      message: {
        id: 'message-queued-waiting',
        content: 'queued after processing item',
        previousUserMessageId: 'message-queued-processing',
      },
      queueItem: {
        id: 'queue-queued-append-2',
        conversationId: activeConvId,
      },
    });
  });

  it('recovers queued append prompts from queue items when the queued message is not in history', () => {
    const view = buildAgentConversationViewModel({
      messages: [],
      queueItems: [
        {
          id: 'queue-1',
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          mode: 'append_prompt',
          prompt: 'queued after reload',
          status: 'queued',
          attempts: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          queuedMessageId: 'queued-message-1',
          previousUserMessageId: null,
        },
      ],
      activeConversationRuns: [],
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
      activeConversationKey: 'agent-1:conversation-1',
      optimisticResponseParentIds: {},
    });

    expect(view.queuedMessages).toHaveLength(1);
    expect(view.queuedMessages[0]).toMatchObject({
      status: 'queued',
      queueItem: { id: 'queue-1' },
      message: {
        id: 'queued-message-1',
        content: 'queued after reload',
        direction: 'outbound',
      },
    });
  });

  it('filters stale queue and run state from other conversations before building visible chat state', () => {
    const activeAgentId = 'agent-visible';
    const activeConvId = 'conversation-visible';
    const view = buildAgentConversationViewModel({
      messages: [baseMessage({ id: 'root', content: 'visible root' })],
      queueItems: [
        queueItem({
          id: 'queue-visible',
          agentId: activeAgentId,
          conversationId: activeConvId,
          prompt: 'visible queued prompt',
          queuedMessageId: 'message-visible-queued',
          runId: 'run-visible',
        }),
        queueItem({
          id: 'queue-sidebar-stale',
          agentId: activeAgentId,
          conversationId: 'conversation-sidebar',
          prompt: 'must not appear on chat',
          queuedMessageId: 'message-sidebar-queued',
          runId: 'run-sidebar',
        }),
      ],
      activeConversationRuns: [
        {
          id: 'run-visible',
          agentId: activeAgentId,
          conversationId: activeConvId,
          responseParentId: 'root',
          status: 'running',
          startedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          id: 'run-sidebar',
          agentId: activeAgentId,
          conversationId: 'conversation-sidebar',
          responseParentId: 'root',
          status: 'running',
          startedAt: '2026-01-01T00:00:02.000Z',
        },
      ],
      activeAgentId,
      activeConvId,
      activeConversationKey: `${activeAgentId}:${activeConvId}`,
      optimisticResponseParentIds: {},
    });

    expect(view.queuedQueueItems.map((item) => item.id)).toEqual(['queue-visible']);
    expect(view.queuedMessages.map(({ message }) => message.content)).toEqual([
      'visible queued prompt',
    ]);
    expect(view.activeProcessingTargetMessageId).toBe('root');
  });

  it('fixture qa-state-completed ignores completed queue and run records for active chat state', () => {
    const activeAgentId = 'agent-completed';
    const activeConvId = 'conversation-completed';
    const view = buildAgentConversationViewModel({
      messages: [
        baseMessage({ id: 'root', content: 'completed prompt' }),
        baseMessage({
          id: 'assistant-completed-response',
          direction: 'inbound',
          content: 'done',
          parentId: 'root',
          createdAt: '2026-01-01T00:00:30.000Z',
        }),
      ],
      queueItems: [
        queueItem({
          id: 'queue-completed',
          agentId: activeAgentId,
          conversationId: activeConvId,
          prompt: 'completed queued prompt',
          status: 'completed',
          queuedMessageId: 'message-completed',
          runId: 'run-completed',
        }),
      ],
      activeConversationRuns: [
        {
          id: 'run-completed',
          agentId: activeAgentId,
          conversationId: activeConvId,
          responseParentId: 'root',
          status: 'completed',
          startedAt: '2026-01-01T00:00:01.000Z',
        },
      ],
      activeAgentId,
      activeConvId,
      activeConversationKey: `${activeAgentId}:${activeConvId}`,
      optimisticResponseParentIds: {},
    });

    expect(view.visibleMessages.map((message) => message.id)).toEqual([
      'root',
      'assistant-completed-response',
    ]);
    expect(view.queuedQueueItems).toHaveLength(0);
    expect(view.queuedMessages).toHaveLength(0);
    expect(view.activeConversationRun).toBeNull();
    expect(view.activeProcessingTargetMessageId).toBeNull();
    expect(view.showStreamingBubble).toBe(false);
  });

  it('renders the next prompt normally after the previous prompt was stopped', () => {
    const activeAgentId = 'agent-stopped-followup';
    const activeConvId = 'conversation-stopped-followup';
    const view = buildAgentConversationViewModel({
      messages: [
        baseMessage({
          id: 'stopped-root',
          content: 'prompt that was stopped',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        baseMessage({
          id: 'followup-after-stop',
          content: 'new prompt after stop',
          previousUserMessageId: 'stopped-root',
          createdAt: '2026-01-01T00:00:30.000Z',
        }),
      ],
      queueItems: [
        queueItem({
          id: 'queue-stopped-root',
          agentId: activeAgentId,
          conversationId: activeConvId,
          prompt: 'prompt that was stopped',
          status: 'cancelled',
          queuedMessageId: 'stopped-root',
          previousUserMessageId: null,
          runId: null,
          errorMessage: 'Cancelled by user',
        }),
        queueItem({
          id: 'queue-followup-processing',
          agentId: activeAgentId,
          conversationId: activeConvId,
          prompt: 'new prompt after stop',
          status: 'processing',
          queuedMessageId: 'followup-after-stop',
          previousUserMessageId: 'stopped-root',
          runId: 'run-followup',
          createdAt: '2026-01-01T00:00:30.000Z',
        }),
      ],
      activeConversationRuns: [
        {
          id: 'run-followup',
          agentId: activeAgentId,
          conversationId: activeConvId,
          responseParentId: 'followup-after-stop',
          status: 'running',
          startedAt: '2026-01-01T00:00:31.000Z',
        },
      ],
      activeAgentId,
      activeConvId,
      activeConversationKey: `${activeAgentId}:${activeConvId}`,
      optimisticResponseParentIds: {},
    });

    expect(view.visibleMessages.map((message) => message.id)).toEqual([
      'stopped-root',
      'followup-after-stop',
    ]);
    expect(view.queuedMessages).toHaveLength(0);
    expect(view.activeConversationRun?.id).toBe('run-followup');
    expect(view.activeProcessingTargetMessageId).toBe('followup-after-stop');
    expect(view.showStreamingBubble).toBe(true);
  });

  it('negative control reports mismatched queued conversation identifiers with queue and run context', () => {
    expect(() =>
      assertVisibleQueueContract({
        activeAgentId: 'agent-1',
        activeConvId: 'conversation-active',
        activeRunId: 'run-active',
        queueItems: [
          queueItem({
            id: 'queue-mismatch',
            agentId: 'agent-1',
            conversationId: 'conversation-other',
            runId: 'run-other',
          }),
        ],
        runs: [],
      }),
    ).toThrow(
      /conversationId=conversation-other.*queueItemId=queue-mismatch.*runId=run-other.*expectedConversationId=conversation-active/,
    );
  });

  it('negative control reports stale sidebar run state with run and conversation context', () => {
    expect(() =>
      assertVisibleQueueContract({
        activeAgentId: 'agent-1',
        activeConvId: 'conversation-active',
        queueItems: [],
        runs: [
          {
            id: 'run-sidebar',
            agentId: 'agent-1',
            conversationId: 'conversation-sidebar',
            responseParentId: 'message-1',
            status: 'running',
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ).toThrow(
      /violatedContract=active run belongs to active conversation.*conversationId=conversation-sidebar.*queueItemId=none.*runId=run-sidebar.*expectedConversationId=conversation-active/,
    );
  });

  it('negative control detects stale active sidebar row after conversation changes during queued state', () => {
    expect(() =>
      assertSidebarRowStateContract({
        activeAgentId: 'agent-1',
        activeConvId: 'conversation-new',
        rows: [
          {
            componentName: 'AgentSidebarItem',
            agentId: 'agent-1',
            conversationId: 'conversation-old',
            active: true,
            queuedCount: 1,
            pendingKey: 'agent-1:conversation-old',
          },
        ],
      }),
    ).toThrow(
      /AgentSidebarItem sidebar state contract violated: stateInput=activeAgentId=agent-1 activeConvId=conversation-new rowAgentId=agent-1 rowConversationId=conversation-old classOrContractName=active queued sidebar row owner expected=rowKey=agent-1:conversation-new pendingKey=agent-1:conversation-new actual=rowKey=agent-1:conversation-old pendingKey=agent-1:conversation-old queuedCount=1/,
    );
  });

  it('negative control detects when persisted queue rehydration is removed', () => {
    const activeAgentId = 'agent-1';
    const activeConvId = 'conversation-1';
    const persistedQueueItems = [
      queueItem({
        id: 'queue-rehydrated',
        agentId: activeAgentId,
        conversationId: activeConvId,
        prompt: 'queued prompt recovered after reload',
        queuedMessageId: 'queued-message-rehydrated',
        runId: 'run-rehydrated',
      }),
    ];

    const staleView = buildAgentConversationViewModel({
      messages: [],
      queueItems: [],
      activeConversationRuns: [
        {
          id: 'run-rehydrated',
          agentId: activeAgentId,
          conversationId: activeConvId,
          responseParentId: null,
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeAgentId,
      activeConvId,
      activeConversationKey: `${activeAgentId}:${activeConvId}`,
      optimisticResponseParentIds: {},
    });

    expect(() =>
      assertRehydratedQueueContract({
        activeConvId,
        activeRunId: 'run-rehydrated',
        expectedQueueItems: persistedQueueItems,
        viewQueueItems: staleView.queuedQueueItems,
        viewQueuedMessages: staleView.queuedMessages,
      }),
    ).toThrow(
      /violatedContract=rehydrated queue item must remain visible.*conversationId=conversation-1.*queueItemId=queue-rehydrated.*runId=run-rehydrated.*expectedConversationId=conversation-1/,
    );
  });

  it('does not recover queued append prompts that belong to a different selected branch', () => {
    const view = buildAgentConversationViewModel({
      messages: [
        baseMessage({ id: 'root', content: 'root' }),
        baseMessage({
          id: 'assistant-response',
          direction: 'inbound',
          content: 'response',
          parentId: 'root',
          createdAt: '2026-01-01T00:00:30.000Z',
        }),
        baseMessage({
          id: 'selected-child',
          content: 'selected child',
          previousUserMessageId: 'root',
          createdAt: '2026-01-01T00:01:00.000Z',
        }),
      ],
      queueItems: [
        {
          id: 'queue-1',
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          mode: 'append_prompt',
          prompt: 'hidden branch queued prompt',
          status: 'queued',
          attempts: 0,
          createdAt: '2026-01-01T00:02:00.000Z',
          queuedMessageId: 'other-child',
          previousUserMessageId: 'root',
        },
      ],
      activeConversationRuns: [],
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
      activeConversationKey: 'agent-1:conversation-1',
      optimisticResponseParentIds: {},
    });

    expect(view.queuedMessages).toHaveLength(0);
    expect(view.queuedQueueItems).toHaveLength(0);
  });

  it('does not show the original root prompt as queued after switching to an active edited root branch', () => {
    const view = buildAgentConversationViewModel({
      messages: [
        baseMessage({
          id: 'edited-root',
          content: 'edited version',
          previousUserMessageId: null,
          siblingIndex: 1,
          siblingCount: 2,
          siblingIds: ['original-root', 'edited-root'],
          createdAt: '2026-01-01T00:00:10.000Z',
        }),
      ],
      queueItems: [
        queueItem({
          id: 'queue-original-root',
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          prompt: 'original version',
          status: 'processing',
          queuedMessageId: 'original-root',
          previousUserMessageId: null,
          runId: 'run-original-root',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      activeConversationRuns: [
        {
          id: 'run-edited-root',
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          responseParentId: 'edited-root',
          status: 'running',
          startedAt: '2026-01-01T00:00:11.000Z',
        },
      ],
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
      activeConversationKey: 'agent-1:conversation-1',
      optimisticResponseParentIds: {},
    });

    expect(view.visibleMessages.map((message) => message.id)).toEqual(['edited-root']);
    expect(view.queuedQueueItems.map((item) => item.id)).not.toContain('queue-original-root');
    expect(view.queuedMessages.map(({ message }) => message.id)).not.toContain('original-root');
    expect(view.activeConversationRun?.id).toBe('run-edited-root');
    expect(view.activeProcessingTargetMessageId).toBe('edited-root');
    expect(view.showStreamingBubble).toBe(true);
  });

  it('hides sibling root append queue when siblingIds are missing but siblingCount proves variants', () => {
    const view = buildAgentConversationViewModel({
      messages: [
        baseMessage({
          id: 'edited-root',
          content: 'edited version',
          previousUserMessageId: null,
          siblingIndex: 1,
          siblingCount: 2,
          createdAt: '2026-01-01T00:00:10.000Z',
        }),
      ],
      queueItems: [
        queueItem({
          id: 'queue-original-root',
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          prompt: 'original version',
          status: 'processing',
          queuedMessageId: 'original-root',
          previousUserMessageId: null,
          runId: 'run-original-root',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      activeConversationRuns: [
        {
          id: 'run-edited-root',
          agentId: 'agent-1',
          conversationId: 'conversation-1',
          responseParentId: 'edited-root',
          status: 'running',
          startedAt: '2026-01-01T00:00:11.000Z',
        },
      ],
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
      activeConversationKey: 'agent-1:conversation-1',
      optimisticResponseParentIds: {},
    });

    expect(view.queuedQueueItems.map((item) => item.id)).not.toContain('queue-original-root');
    expect(view.queuedMessages.map(({ message }) => message.id)).not.toContain('original-root');
  });

  it('renders canonical turn view statuses without reconstructing from legacy queue lineage', () => {
    const canonicalView: AgentConversationChatView = {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      total: 3,
      branches: [],
      entries: [
        {
          id: 'turn-stopped',
          parentTurnId: null,
          status: 'stopped',
          turnType: 'follow_up',
          userMessage: {
            id: 'message-stopped',
            direction: 'outbound',
            type: 'text',
            content: 'stop this',
            status: 'sent',
            metadata: null,
            attachments: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: null,
          },
          assistantMessage: null,
          execution: {
            queue: {
              id: 'queue-stopped',
              status: 'cancelled',
              runId: 'run-stopped',
              errorMessage: 'Cancelled by user',
              attempts: 1,
              maxAttempts: 3,
              nextAttemptAt: null,
              startedAt: '2026-01-01T00:00:01.000Z',
              completedAt: '2026-01-01T00:00:02.000Z',
              usedFallback: false,
              fallbackModel: null,
            },
            run: {
              id: 'run-stopped',
              status: 'error',
              errorMessage: 'Killed by user',
              responseText: null,
              startedAt: '2026-01-01T00:00:01.000Z',
              finishedAt: '2026-01-01T00:00:02.000Z',
              durationMs: 1000,
            },
          },
          branch: {
            parentTurnId: null,
            isSelected: true,
            siblingIndex: 0,
            siblingCount: 1,
            siblingIds: ['turn-stopped'],
            siblings: [
              {
                turnId: 'turn-stopped',
                userMessageId: 'message-stopped',
                status: 'stopped',
                turnType: 'follow_up',
                supersedesTurnId: null,
                isSelected: true,
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
          edit: {
            supersedesTurnId: null,
            supersededByTurnId: null,
            isSuperseded: false,
          },
          availableActions: ['retry', 'switch_branch'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: null,
          startedAt: '2026-01-01T00:00:01.000Z',
          completedAt: '2026-01-01T00:00:02.000Z',
        },
        {
          id: 'turn-edit',
          parentTurnId: 'turn-stopped',
          status: 'processing',
          turnType: 'edit',
          userMessage: {
            id: 'message-edit',
            direction: 'outbound',
            type: 'text',
            content: 'edited follow-up',
            status: 'sent',
            metadata: null,
            attachments: null,
            createdAt: '2026-01-01T00:01:00.000Z',
            updatedAt: null,
          },
          assistantMessage: null,
          execution: {
            queue: {
              id: 'queue-edit',
              status: 'processing',
              runId: 'run-edit',
              errorMessage: null,
              attempts: 1,
              maxAttempts: 3,
              nextAttemptAt: null,
              startedAt: '2026-01-01T00:01:01.000Z',
              completedAt: null,
              usedFallback: false,
              fallbackModel: null,
            },
            run: {
              id: 'run-edit',
              status: 'running',
              errorMessage: null,
              responseText: null,
              startedAt: '2026-01-01T00:01:01.000Z',
              finishedAt: null,
              durationMs: null,
            },
          },
          branch: {
            parentTurnId: 'turn-stopped',
            isSelected: true,
            siblingIndex: 1,
            siblingCount: 2,
            siblingIds: ['turn-original', 'turn-edit'],
            siblings: [
              {
                turnId: 'turn-original',
                userMessageId: 'message-original',
                status: 'superseded',
                turnType: 'follow_up',
                supersedesTurnId: null,
                isSelected: false,
                createdAt: '2026-01-01T00:00:30.000Z',
              },
              {
                turnId: 'turn-edit',
                userMessageId: 'message-edit',
                status: 'processing',
                turnType: 'edit',
                supersedesTurnId: 'turn-original',
                isSelected: true,
                createdAt: '2026-01-01T00:01:00.000Z',
              },
            ],
          },
          edit: {
            supersedesTurnId: 'turn-original',
            supersededByTurnId: null,
            isSuperseded: false,
          },
          availableActions: ['edit_user_message', 'stop', 'switch_branch'],
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: null,
          startedAt: '2026-01-01T00:01:01.000Z',
          completedAt: null,
        },
        {
          id: 'turn-queued',
          parentTurnId: 'turn-edit',
          status: 'queued',
          turnType: 'follow_up',
          userMessage: {
            id: 'message-queued',
            direction: 'outbound',
            type: 'text',
            content: 'queued next',
            status: 'sent',
            metadata: null,
            attachments: null,
            createdAt: '2026-01-01T00:02:00.000Z',
            updatedAt: null,
          },
          assistantMessage: null,
          execution: {
            queue: {
              id: 'queue-queued',
              status: 'queued',
              runId: null,
              errorMessage: null,
              attempts: 0,
              maxAttempts: 3,
              nextAttemptAt: '2026-01-01T00:02:00.000Z',
              startedAt: null,
              completedAt: null,
              usedFallback: false,
              fallbackModel: null,
            },
            run: null,
          },
          branch: {
            parentTurnId: 'turn-edit',
            isSelected: true,
            siblingIndex: 0,
            siblingCount: 1,
            siblingIds: ['turn-queued'],
            siblings: [
              {
                turnId: 'turn-queued',
                userMessageId: 'message-queued',
                status: 'queued',
                turnType: 'follow_up',
                supersedesTurnId: null,
                isSelected: true,
                createdAt: '2026-01-01T00:02:00.000Z',
              },
            ],
          },
          edit: {
            supersedesTurnId: null,
            supersededByTurnId: null,
            isSuperseded: false,
          },
          availableActions: ['edit_queue_item', 'delete_queue_item'],
          createdAt: '2026-01-01T00:02:00.000Z',
          updatedAt: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    };

    const view = buildAgentConversationViewModel({
      canonicalView,
      messages: [],
      queueItems: [],
      activeConversationRuns: [],
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
      activeConversationKey: 'agent-1:conversation-1',
      optimisticResponseParentIds: {},
    });

    expect(view.visibleMessages.map((message) => message.id)).toEqual([
      'message-stopped',
      'message-edit',
    ]);
    expect(view.visibleMessages.find((message) => message.id === 'message-edit')).toMatchObject({
      turnId: 'turn-edit',
      turnStatus: 'processing',
      turnType: 'edit',
      siblingIds: ['message-original', 'message-edit'],
    });
    expect(view.errorsByMessageId.get('message-stopped')?.[0]).toMatchObject({
      id: 'queue-stopped',
      status: 'cancelled',
      turnId: 'turn-stopped',
      availableActions: ['retry', 'switch_branch'],
    });
    expect(view.queuedMessages).toEqual([
      expect.objectContaining({
        status: 'queued',
        queueItem: expect.objectContaining({ id: 'queue-queued', turnId: 'turn-queued' }),
        message: expect.objectContaining({ id: 'message-queued' }),
      }),
    ]);
    expect(view.activeConversationRun?.id).toBe('run-edit');
    expect(view.activeProcessingTargetMessageId).toBe('message-edit');
    expect(view.showStreamingBubble).toBe(true);
  });

  it('preserves canonical turn order instead of re-sorting messages by timestamp', () => {
    const canonicalView: AgentConversationChatView = {
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      total: 2,
      branches: [],
      entries: [
        canonicalTurn({
          id: 'turn-first',
          userMessage: {
            id: 'message-first',
            direction: 'outbound',
            type: 'text',
            content: 'server-selected first',
            status: 'sent',
            metadata: null,
            attachments: null,
            createdAt: '2026-01-01T00:02:00.000Z',
            updatedAt: null,
          },
          createdAt: '2026-01-01T00:02:00.000Z',
        }),
        canonicalTurn({
          id: 'turn-second',
          parentTurnId: 'turn-first',
          userMessage: {
            id: 'message-second',
            direction: 'outbound',
            type: 'text',
            content: 'server-selected second',
            status: 'sent',
            metadata: null,
            attachments: null,
            createdAt: '2026-01-01T00:01:00.000Z',
            updatedAt: null,
          },
          createdAt: '2026-01-01T00:01:00.000Z',
        }),
      ],
    };

    const view = buildAgentConversationViewModel({
      canonicalView,
      messages: [],
      queueItems: [],
      activeConversationRuns: [],
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
      activeConversationKey: 'agent-1:conversation-1',
      optimisticResponseParentIds: {},
    });

    expect(view.visibleMessages.map((message) => message.id)).toEqual([
      'message-first',
      'message-second',
    ]);
  });

  it('does not render a stale canonical view for a different active conversation', () => {
    const canonicalView: AgentConversationChatView = {
      agentId: 'agent-1',
      conversationId: 'conversation-old',
      total: 1,
      branches: [],
      entries: [canonicalTurn({ id: 'turn-old' })],
    };

    const view = buildAgentConversationViewModel({
      canonicalView,
      messages: [baseMessage({ id: 'legacy-visible', content: 'legacy fallback should not show' })],
      queueItems: [],
      activeConversationRuns: [],
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
      activeConversationKey: 'agent-1:conversation-1',
      optimisticResponseParentIds: {},
    });

    expect(view.visibleMessages).toEqual([]);
    expect(view.queuedMessages).toEqual([]);
    expect(view.showStreamingBubble).toBe(false);
  });
});
