import { describe, expect, it } from 'vitest';
import {
  buildAgentConversationViewModel,
  type AgentConversationChatTurn,
  type AgentConversationChatView,
} from './agent-chat-view-model';

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

function canonicalView(entries: AgentConversationChatTurn[]): AgentConversationChatView {
  return {
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    total: entries.length,
    branches: [],
    entries,
  };
}

function buildView(canonical: AgentConversationChatView) {
  return buildAgentConversationViewModel({
    canonicalView: canonical,
    activeAgentId: 'agent-1',
    activeConvId: 'conversation-1',
  });
}

describe('buildAgentConversationViewModel', () => {
  it('renders canonical turn status, queue, run, and branch fields without legacy reconstruction', () => {
    const view = buildView(
      canonicalView([
        canonicalTurn({
          id: 'turn-stopped',
          status: 'stopped',
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
          execution: {
            queue: {
              id: 'queue-stopped',
              turnId: 'turn-stopped',
              status: 'cancelled',
              position: null,
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
              turnId: 'turn-stopped',
              status: 'error',
              errorMessage: 'Killed by user',
              responseText: null,
              startedAt: '2026-01-01T00:00:01.000Z',
              finishedAt: '2026-01-01T00:00:02.000Z',
              durationMs: 1000,
            },
          },
          availableActions: ['retry', 'switch_branch'],
        }),
        canonicalTurn({
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
          execution: {
            queue: {
              id: 'queue-edit',
              turnId: 'turn-edit',
              status: 'processing',
              position: 1,
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
              turnId: 'turn-edit',
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
        }),
        canonicalTurn({
          id: 'turn-queued',
          parentTurnId: 'turn-edit',
          status: 'queued',
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
          execution: {
            queue: {
              id: 'queue-queued',
              turnId: 'turn-queued',
              status: 'queued',
              position: 2,
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
          availableActions: ['edit_queue_item', 'delete_queue_item'],
        }),
      ]),
    );

    expect(view.visibleMessages.map((message) => message.id)).toEqual([
      'message-stopped',
      'message-edit',
    ]);
    expect(view.visibleMessages.find((message) => message.id === 'message-edit')).toMatchObject({
      turnId: 'turn-edit',
      turnStatus: 'processing',
      turnType: 'edit',
      siblingIds: ['message-original', 'message-edit'],
      siblingTurnIds: ['turn-original', 'turn-edit'],
    });
    expect(view.errorsByMessageId.get('message-stopped')?.[0]).toMatchObject({
      id: 'queue-stopped',
      status: 'cancelled',
      turnId: 'turn-stopped',
      availableActions: ['retry', 'switch_branch'],
    });
    expect(view.queuedQueueItems).toEqual([
      expect.objectContaining({ id: 'queue-queued', turnId: 'turn-queued' }),
    ]);
    expect(view.queuedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: 'message-queued' }),
        queueItem: expect.objectContaining({ id: 'queue-queued', turnId: 'turn-queued' }),
        status: 'queued',
      }),
    ]);
    expect(view.effectivePendingBranchExecutionsByMessageId.get('message-queued')).toBeUndefined();
    expect(view.activeConversationRun?.id).toBe('run-edit');
    expect(view.activeProcessingTargetMessageId).toBe('message-edit');
    expect(view.showStreamingBubble).toBe(true);
  });

  it('preserves canonical turn order instead of re-sorting messages by timestamp', () => {
    const view = buildView(
      canonicalView([
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
      ]),
    );

    expect(view.visibleMessages.map((message) => message.id)).toEqual([
      'message-first',
      'message-second',
    ]);
  });

  it('does not render a stale canonical view for a different active conversation', () => {
    const view = buildAgentConversationViewModel({
      canonicalView: {
        agentId: 'agent-1',
        conversationId: 'conversation-old',
        total: 1,
        branches: [],
        entries: [canonicalTurn({ id: 'turn-old' })],
      },
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
    });

    expect(view.visibleMessages).toEqual([]);
    expect(view.showStreamingBubble).toBe(false);
  });

  it('renders canonical view without accepting legacy state or optimistic rows', () => {
    const view = buildAgentConversationViewModel({
      canonicalView: canonicalView([canonicalTurn({ id: 'turn-canonical' })]),
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
    });

    expect(view.visibleMessages.map((message) => message.id)).toEqual(['message-turn-canonical']);
    expect(view.queuedQueueItems).toEqual([]);
    expect(view.activeConversationRun).toBeNull();
    expect(view.showStreamingBubble).toBe(false);
  });

  it('uses canonical turn ids as branch targets when sibling turns share a user message', () => {
    const siblings: AgentConversationChatTurn['branch']['siblings'] = [
      {
        turnId: 'turn-1',
        userMessageId: 'message-shared',
        status: 'completed',
        turnType: 'follow_up',
        supersedesTurnId: null,
        isSelected: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        turnId: 'turn-2',
        userMessageId: 'message-shared',
        status: 'completed',
        turnType: 'follow_up',
        supersedesTurnId: null,
        isSelected: false,
        createdAt: '2026-01-01T00:01:00.000Z',
      },
      {
        turnId: 'turn-3',
        userMessageId: 'message-third',
        status: 'completed',
        turnType: 'follow_up',
        supersedesTurnId: null,
        isSelected: true,
        createdAt: '2026-01-01T00:02:00.000Z',
      },
    ];
    const view = buildView(
      canonicalView([
        canonicalTurn({
          id: 'turn-3',
          userMessage: {
            id: 'message-third',
            direction: 'outbound',
            type: 'text',
            content: 'third branch',
            status: 'sent',
            metadata: null,
            attachments: null,
            createdAt: '2026-01-01T00:02:00.000Z',
            updatedAt: null,
          },
          branch: {
            parentTurnId: null,
            isSelected: true,
            siblingIndex: 2,
            siblingCount: 3,
            siblingIds: ['turn-1', 'turn-2', 'turn-3'],
            siblings,
          },
        }),
      ]),
    );

    expect(view.visibleMessages[0]).toMatchObject({
      id: 'message-third',
      siblingIndex: 2,
      siblingCount: 3,
      siblingIds: ['message-shared', 'message-shared', 'message-third'],
      siblingTurnIds: ['turn-1', 'turn-2', 'turn-3'],
    });
  });
});
