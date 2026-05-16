/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  buildAgentConversationViewModel,
  type AgentChatAttachment,
  type AgentConversationChatTurn,
  type AgentConversationChatTurnStatus,
  type AgentConversationChatView,
} from './agent-chat-view-model';

const agentId = 'agent-1';
const conversationId = 'conversation-1';
const baseTime = '2026-05-16T12:00:00.000Z';

function attachment(overrides: Partial<AgentChatAttachment> = {}): AgentChatAttachment {
  return {
    type: 'file',
    fileName: 'brief.pdf',
    mimeType: 'application/pdf',
    fileSize: 128,
    storagePath: '/chat-uploads/brief.pdf',
    ...overrides,
  };
}

function turn(options: {
  id: string;
  content: string;
  parentTurnId?: string | null;
  status?: AgentConversationChatTurnStatus;
  turnType?: string;
  messageId?: string;
  createdAt?: string;
  attachments?: AgentChatAttachment[] | null;
  supersedesTurnId?: string | null;
  supersededByTurnId?: string | null;
  siblingIds?: string[];
  siblingUserMessageIds?: string[];
  siblingStatuses?: AgentConversationChatTurnStatus[];
  queue?: {
    id: string;
    status: 'queued' | 'processing' | 'failed' | 'cancelled';
    runId?: string | null;
    errorMessage?: string | null;
  } | null;
  run?: {
    id: string;
    status: 'running' | 'completed' | 'error';
    errorMessage?: string | null;
  } | null;
  actions?: AgentConversationChatTurn['availableActions'];
}): AgentConversationChatTurn {
  const status = options.status ?? 'completed';
  const messageId = options.messageId ?? `message-${options.id}`;
  const createdAt = options.createdAt ?? baseTime;
  const siblingIds = options.siblingIds ?? [options.id];
  const siblingUserMessageIds = options.siblingUserMessageIds ?? [messageId];
  const siblingStatuses = options.siblingStatuses ?? siblingIds.map(() => status);
  const siblingIndex = Math.max(0, siblingIds.indexOf(options.id));
  return {
    id: options.id,
    parentTurnId: options.parentTurnId ?? null,
    status,
    turnType: options.turnType ?? 'follow_up',
    userMessage: {
      id: messageId,
      direction: 'outbound',
      type: options.attachments?.length ? 'file' : 'text',
      content: options.content,
      status: 'sent',
      metadata: null,
      attachments: options.attachments ?? null,
      createdAt,
      updatedAt: null,
    },
    assistantMessage: null,
    execution: {
      queue: options.queue
        ? {
            id: options.queue.id,
            status: options.queue.status,
            runId: options.queue.runId ?? options.run?.id ?? null,
            errorMessage: options.queue.errorMessage ?? null,
            attempts: options.queue.status === 'queued' ? 0 : 1,
            maxAttempts: 3,
            nextAttemptAt: null,
            startedAt: options.queue.status === 'processing' ? createdAt : null,
            completedAt:
              options.queue.status === 'failed' || options.queue.status === 'cancelled'
                ? createdAt
                : null,
            usedFallback: false,
            fallbackModel: null,
          }
        : null,
      run: options.run
        ? {
            id: options.run.id,
            status: options.run.status,
            errorMessage: options.run.errorMessage ?? null,
            responseText: null,
            startedAt: createdAt,
            finishedAt: options.run.status === 'running' ? null : createdAt,
            durationMs: options.run.status === 'running' ? null : 1000,
          }
        : null,
    },
    branch: {
      parentTurnId: options.parentTurnId ?? null,
      isSelected: true,
      siblingIndex,
      siblingCount: siblingIds.length,
      siblingIds,
      siblings: siblingIds.map((turnId, index) => ({
        turnId,
        userMessageId: siblingUserMessageIds[index] ?? null,
        status: siblingStatuses[index] ?? 'completed',
        turnType: turnId === options.id ? (options.turnType ?? 'follow_up') : 'follow_up',
        supersedesTurnId: turnId === options.id ? (options.supersedesTurnId ?? null) : null,
        isSelected: turnId === options.id,
        createdAt,
      })),
    },
    edit: {
      supersedesTurnId: options.supersedesTurnId ?? null,
      supersededByTurnId: options.supersededByTurnId ?? null,
      isSuperseded: Boolean(options.supersededByTurnId),
    },
    availableActions: options.actions ?? ['edit_user_message'],
    createdAt,
    updatedAt: null,
    startedAt: options.run?.status === 'running' ? createdAt : null,
    completedAt: status === 'completed' ? createdAt : null,
  };
}

function canonicalView(entries: AgentConversationChatTurn[]): AgentConversationChatView {
  return {
    agentId,
    conversationId,
    total: entries.length,
    entries,
    branches: [],
  };
}

function renderTranscript(viewData: AgentConversationChatView) {
  const view = buildAgentConversationViewModel({
    canonicalView: viewData,
    messages: [],
    queueItems: [],
    activeConversationRuns: [],
    activeAgentId: agentId,
    activeConvId: conversationId,
    activeConversationKey: `${agentId}:${conversationId}`,
    optimisticResponseParentIds: {},
  });
  const root = document.createElement('section');
  root.dataset.testid = 'agent-chat-transcript';

  for (const message of view.visibleMessages) {
    const row = document.createElement('article');
    row.dataset.testid = 'message-row';
    row.dataset.messageId = message.id;
    row.dataset.turnStatus = message.turnStatus ?? '';
    row.dataset.turnType = message.turnType ?? '';
    row.textContent = message.content;
    for (const att of message.attachments ?? []) {
      const chip = document.createElement('span');
      chip.dataset.testid = 'attachment-chip';
      chip.textContent = att.fileName;
      row.append(chip);
    }
    if (message.turnStatus === 'stopped') {
      const badge = document.createElement('span');
      badge.dataset.testid = 'turn-badge';
      badge.textContent = 'Stopped';
      row.append(badge);
    }
    const notices = view.errorsByMessageId.get(message.id) ?? [];
    for (const item of notices) {
      const notice = document.createElement('div');
      notice.dataset.testid = 'execution-notice';
      notice.dataset.queueStatus = item.status;
      notice.textContent = item.status === 'cancelled' ? 'Run stopped' : 'Run failed';
      if (item.availableActions?.includes('retry')) {
        const retry = document.createElement('button');
        retry.ariaLabel = 'Retry';
        notice.append(retry);
      }
      if (item.availableActions?.includes('delete_queue_item')) {
        const remove = document.createElement('button');
        remove.ariaLabel = 'Remove from queue';
        notice.append(remove);
      }
      row.append(notice);
    }
    root.append(row);
  }

  for (const { message, status, queueItem } of view.queuedMessages) {
    const row = document.createElement('article');
    row.dataset.testid = 'queued-message-row';
    row.dataset.messageId = message.id;
    row.dataset.queueItemId = queueItem?.id ?? '';
    row.dataset.queueStatus = status;
    row.dataset.turnType = message.turnType ?? '';
    row.textContent = message.content;
    for (const att of message.attachments ?? []) {
      const chip = document.createElement('span');
      chip.dataset.testid = 'attachment-chip';
      chip.textContent = att.fileName;
      row.append(chip);
    }
    root.append(row);
  }

  document.body.replaceChildren(root);
  return { view, root };
}

function rowIds(root: HTMLElement, testId: string): string[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].map(
    (row) => row.dataset.messageId ?? '',
  );
}

describe('agent chat lifecycle browser matrix', () => {
  it('shows a stopped first prompt and the follow-up as a new visible turn', () => {
    const { view, root } = renderTranscript(
      canonicalView([
        turn({
          id: 'turn-first',
          messageId: 'message-first',
          content: 'First prompt',
          status: 'stopped',
          queue: { id: 'queue-first', status: 'cancelled', errorMessage: 'Killed by user' },
          actions: ['edit_user_message', 'retry'],
        }),
        turn({
          id: 'turn-follow-up',
          parentTurnId: 'turn-first',
          messageId: 'message-follow-up',
          content: 'Follow-up after stop',
          status: 'processing',
          queue: { id: 'queue-follow-up', status: 'processing', runId: 'run-follow-up' },
          run: { id: 'run-follow-up', status: 'running' },
          actions: ['edit_user_message', 'stop'],
        }),
      ]),
    );

    expect(rowIds(root, 'message-row')).toEqual(['message-first', 'message-follow-up']);
    expect(rowIds(root, 'queued-message-row')).toEqual([]);
    expect(root.querySelector('[data-message-id="message-first"]')?.textContent).toContain(
      'Stopped',
    );
    expect(view.activeProcessingTargetMessageId).toBe('message-follow-up');
  });

  it('shows an edited first prompt as a replacement row instead of a follow-up row', () => {
    const { root } = renderTranscript(
      canonicalView([
        turn({
          id: 'turn-edit',
          messageId: 'message-edit',
          content: 'Edited first prompt',
          status: 'queued',
          turnType: 'edit',
          supersedesTurnId: 'turn-original',
          siblingIds: ['turn-original', 'turn-edit'],
          siblingUserMessageIds: ['message-original', 'message-edit'],
          siblingStatuses: ['superseded', 'queued'],
          queue: { id: 'queue-edit', status: 'queued' },
          actions: ['edit_queue_item', 'delete_queue_item', 'switch_branch'],
        }),
      ]),
    );

    expect(rowIds(root, 'message-row')).toEqual([]);
    expect(rowIds(root, 'queued-message-row')).toEqual(['message-edit']);
    expect(
      root.querySelector('[data-message-id="message-edit"]')?.getAttribute('data-turn-type'),
    ).toBe('edit');
  });

  it('keeps a follow-up on the edited branch after editing a prior prompt', () => {
    const { root } = renderTranscript(
      canonicalView([
        turn({
          id: 'turn-edit',
          messageId: 'message-edit',
          content: 'Edited prompt',
          status: 'completed',
          turnType: 'edit',
          supersedesTurnId: 'turn-original',
          siblingIds: ['turn-original', 'turn-edit'],
          siblingUserMessageIds: ['message-original', 'message-edit'],
          siblingStatuses: ['superseded', 'completed'],
          actions: ['edit_user_message', 'switch_branch'],
        }),
        turn({
          id: 'turn-follow-up',
          parentTurnId: 'turn-edit',
          messageId: 'message-follow-up',
          content: 'Follow-up on edited branch',
          status: 'processing',
          queue: { id: 'queue-follow-up', status: 'processing', runId: 'run-follow-up' },
          run: { id: 'run-follow-up', status: 'running' },
          actions: ['edit_user_message', 'stop'],
        }),
      ]),
    );

    expect(rowIds(root, 'message-row')).toEqual(['message-edit', 'message-follow-up']);
    expect(
      root.querySelector('[data-message-id="message-edit"] [data-testid="turn-badge"]'),
    ).toBeNull();
    expect(root.querySelector('[data-message-id="message-edit"]')?.textContent).toContain(
      'Edited prompt',
    );
    expect(
      root.querySelector('[data-message-id="message-follow-up"]')?.getAttribute('data-turn-type'),
    ).toBe('follow_up');
  });

  it('renders multiple prompts queued behind an active run as queued rows', () => {
    const { view, root } = renderTranscript(
      canonicalView([
        turn({
          id: 'turn-active',
          messageId: 'message-active',
          content: 'Active prompt',
          status: 'processing',
          queue: { id: 'queue-active', status: 'processing', runId: 'run-active' },
          run: { id: 'run-active', status: 'running' },
          actions: ['edit_user_message', 'stop'],
        }),
        turn({
          id: 'turn-queued-1',
          parentTurnId: 'turn-active',
          messageId: 'message-queued-1',
          content: 'Queued prompt one',
          status: 'queued',
          queue: { id: 'queue-queued-1', status: 'queued' },
          actions: ['edit_queue_item', 'delete_queue_item'],
        }),
        turn({
          id: 'turn-queued-2',
          parentTurnId: 'turn-queued-1',
          messageId: 'message-queued-2',
          content: 'Queued prompt two',
          status: 'queued',
          queue: { id: 'queue-queued-2', status: 'queued' },
          actions: ['edit_queue_item', 'delete_queue_item'],
        }),
      ]),
    );

    expect(rowIds(root, 'message-row')).toEqual(['message-active']);
    expect(rowIds(root, 'queued-message-row')).toEqual(['message-queued-1', 'message-queued-2']);
    expect(view.queuedQueueItems.map((item) => item.id)).toEqual([
      'queue-queued-1',
      'queue-queued-2',
    ]);
  });

  it('renders upload caption attachments and then the follow-up turn', () => {
    const { root } = renderTranscript(
      canonicalView([
        turn({
          id: 'turn-upload',
          messageId: 'message-upload',
          content: 'Caption with attachment',
          status: 'completed',
          attachments: [attachment()],
          actions: ['edit_user_message'],
        }),
        turn({
          id: 'turn-follow-up',
          parentTurnId: 'turn-upload',
          messageId: 'message-follow-up',
          content: 'Follow-up after upload',
          status: 'processing',
          queue: { id: 'queue-follow-up', status: 'processing', runId: 'run-follow-up' },
          run: { id: 'run-follow-up', status: 'running' },
          actions: ['edit_user_message', 'stop'],
        }),
      ]),
    );

    expect(rowIds(root, 'message-row')).toEqual(['message-upload', 'message-follow-up']);
    expect(root.querySelector('[data-message-id="message-upload"]')?.textContent).toContain(
      'Caption with attachment',
    );
    expect(root.querySelector('[data-message-id="message-upload"]')?.textContent).toContain(
      'brief.pdf',
    );
  });

  it('renders failed and cancelled items with retry/removal controls', () => {
    const { root } = renderTranscript(
      canonicalView([
        turn({
          id: 'turn-failed',
          messageId: 'message-failed',
          content: 'Prompt that failed',
          status: 'failed',
          queue: { id: 'queue-failed', status: 'failed', errorMessage: 'Model failed' },
          run: { id: 'run-failed', status: 'error', errorMessage: 'Model failed' },
          actions: ['edit_user_message', 'retry', 'delete_queue_item'],
        }),
        turn({
          id: 'turn-cancelled',
          parentTurnId: 'turn-failed',
          messageId: 'message-cancelled',
          content: 'Prompt removed from queue',
          status: 'stopped',
          queue: { id: 'queue-cancelled', status: 'cancelled', errorMessage: 'Removed' },
          actions: ['edit_user_message', 'retry', 'delete_queue_item'],
        }),
      ]),
    );

    const notices = [...root.querySelectorAll<HTMLElement>('[data-testid="execution-notice"]')];
    expect(notices.map((notice) => notice.textContent)).toEqual(['Run failed', 'Run stopped']);
    expect(root.querySelectorAll('button[aria-label="Retry"]')).toHaveLength(2);
    expect(root.querySelectorAll('button[aria-label="Remove from queue"]')).toHaveLength(2);
  });
});
