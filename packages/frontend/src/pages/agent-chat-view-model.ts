interface AgentChatAttachment {
  type: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storagePath: string;
}

export interface AgentChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  createdAt: string;
  type?: string;
  metadata?: string | null;
  attachments?: AgentChatAttachment[] | null;
  parentId?: string | null;
  previousUserMessageId?: string | null;
  siblingIndex?: number;
  siblingCount?: number;
  siblingIds?: string[];
}

export interface AgentChatQueueItem {
  id: string;
  agentId: string;
  conversationId: string;
  mode?: 'append_prompt' | 'respond_to_message';
  prompt: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  createdAt: string;
  targetMessageId?: string | null;
  queuedMessageId?: string | null;
  previousUserMessageId?: string | null;
  runId?: string | null;
  errorMessage?: string | null;
}

export interface AgentConversationRunSummary {
  id: string;
  responseParentId?: string | null;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
}

export type QueueExecutionMode = NonNullable<AgentChatQueueItem['mode']>;

export interface BuildAgentConversationViewModelOptions {
  messages: AgentChatMessage[];
  queueItems: AgentChatQueueItem[];
  activeConversationRuns: AgentConversationRunSummary[];
  activeAgentId: string | null;
  activeConvId: string | null;
  activeConversationKey: string | null;
  optimisticResponseParentIds: Record<string, string | null | undefined>;
}

export interface AgentConversationViewModel {
  visibleMessages: AgentChatMessage[];
  queuedQueueItems: AgentChatQueueItem[];
  queuedMessages: {
    message: AgentChatMessage;
    status: 'queued' | 'processing';
    queueItem: AgentChatQueueItem | null;
  }[];
  notifyQueueItems: AgentChatQueueItem[];
  effectivePendingBranchExecutionsByMessageId: Map<string, AgentChatQueueItem[]>;
  errorsByMessageId: Map<string, AgentChatQueueItem[]>;
  orphanErrorItems: AgentChatQueueItem[];
  activeProcessingTargetMessageId: string | null;
  showStreamingBubble: boolean;
}

export function toQueueCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export function queueItemsLabel(count: number): string {
  return `${count} message${count === 1 ? '' : 's'} queued`;
}

export function getQueueItemMode(item: Pick<AgentChatQueueItem, 'mode'>): QueueExecutionMode {
  return item.mode ?? 'append_prompt';
}

export function getBranchTargetIdByOffset(
  ids: string[] | undefined,
  index: number | undefined,
  offset: number,
): string | null {
  const idx = index ?? 0;
  const branchIds = ids ?? [];
  const targetIdx = idx + offset;
  if (targetIdx < 0 || targetIdx >= branchIds.length) return null;
  return branchIds[targetIdx] ?? null;
}

const ROOT_PREVIOUS_USER_MESSAGE_KEY = '__root__';

function compareByCreatedAt(
  a: Pick<AgentChatMessage, 'createdAt' | 'id'>,
  b: Pick<AgentChatMessage, 'createdAt' | 'id'>,
): number {
  const createdAtDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (createdAtDelta !== 0) return createdAtDelta;
  return a.id.localeCompare(b.id);
}

export function buildAgentConversationViewModel(
  options: BuildAgentConversationViewModelOptions,
): AgentConversationViewModel {
  const {
    messages,
    queueItems,
    activeConversationRuns,
    activeAgentId,
    activeConvId,
    activeConversationKey,
    optimisticResponseParentIds,
  } = options;

  const activeBranchMessages = [...messages].sort(compareByCreatedAt);
  const activeBranchMessageIds = new Set(activeBranchMessages.map((message) => message.id));
  const activeBranchUserMessages = activeBranchMessages.filter(
    (message) => message.direction === 'outbound',
  );
  const activeBranchUserMessageIds = new Set(activeBranchUserMessages.map((message) => message.id));
  const agentResponseParentIds = new Set(
    activeBranchMessages
      .filter((message) => message.direction === 'inbound')
      .map((message) => message.parentId ?? null)
      .filter((parentId): parentId is string => Boolean(parentId)),
  );
  const queuedStyleUserMessageIds = new Set(
    activeBranchUserMessages
      .filter((message) => {
        const previousUserMessageId = message.previousUserMessageId ?? null;
        if (!previousUserMessageId) return false;
        if (!activeBranchUserMessageIds.has(previousUserMessageId)) return false;
        return !agentResponseParentIds.has(previousUserMessageId);
      })
      .map((message) => message.id),
  );
  const visibleMessages = activeBranchMessages.filter((message) => {
    if (message.direction !== 'outbound') return true;
    return !queuedStyleUserMessageIds.has(message.id);
  });
  const activeMessageIds = new Set(visibleMessages.map((message) => message.id));
  const hiddenPendingMessageIds = new Set(
    queueItems
      .filter(
        (item) =>
          getQueueItemMode(item) === 'append_prompt' &&
          (item.status === 'queued' || item.status === 'processing') &&
          Boolean(item.queuedMessageId),
      )
      .map((item) => item.queuedMessageId!),
  );
  const selectedUserMessageIdByPreviousMessageId = new Map<string, string>();
  for (const message of activeBranchMessages) {
    if (message.direction !== 'outbound') continue;
    const key = message.previousUserMessageId ?? ROOT_PREVIOUS_USER_MESSAGE_KEY;
    selectedUserMessageIdByPreviousMessageId.set(key, message.id);
  }

  const queuedQueueItems = queueItems
    .filter((item) => {
      if (getQueueItemMode(item) !== 'append_prompt') {
        return false;
      }
      if (item.status !== 'queued' && item.status !== 'processing') return false;

      const previousUserMessageId = item.previousUserMessageId ?? null;
      const queuedMessageId = item.queuedMessageId ?? null;
      const selectionKey = previousUserMessageId ?? ROOT_PREVIOUS_USER_MESSAGE_KEY;
      const selectedMessageId = selectedUserMessageIdByPreviousMessageId.get(selectionKey) ?? null;

      if (selectedMessageId && queuedMessageId && selectedMessageId !== queuedMessageId) {
        return false;
      }

      return (
        previousUserMessageId === null || activeBranchUserMessageIds.has(previousUserMessageId)
      );
    })
    .sort(compareByCreatedAt);
  const notifyQueueItems = queueItems.filter(
    (item) => item.status === 'failed' || item.status === 'cancelled',
  );

  const activeChildParentIds = new Set(
    visibleMessages
      .map((message) => message.parentId ?? null)
      .filter((parentId): parentId is string => Boolean(parentId)),
  );
  const pendingBranchExecutionsByMessageId = new Map<string, AgentChatQueueItem[]>();
  for (const item of queueItems) {
    if (item.status !== 'queued' && item.status !== 'processing') continue;
    if (getQueueItemMode(item) !== 'respond_to_message') continue;
    const anchorId = item.targetMessageId;
    if (!anchorId) continue;
    const entries = pendingBranchExecutionsByMessageId.get(anchorId) ?? [];
    entries.push(item);
    pendingBranchExecutionsByMessageId.set(anchorId, entries);
  }

  const effectivePendingBranchExecutionsByMessageId = new Map<string, AgentChatQueueItem[]>();
  for (const [messageId, items] of pendingBranchExecutionsByMessageId.entries()) {
    effectivePendingBranchExecutionsByMessageId.set(messageId, [...items]);
  }

  const liveAppendQueueItemByMessageId = new Map<string, AgentChatQueueItem>();
  for (const item of queueItems) {
    if (getQueueItemMode(item) !== 'append_prompt') continue;
    if (item.status !== 'queued' && item.status !== 'processing') continue;
    const queuedMessageId = item.queuedMessageId ?? null;
    if (!queuedMessageId) continue;
    const existingItem = liveAppendQueueItemByMessageId.get(queuedMessageId);
    if (!existingItem || existingItem.status !== 'processing') {
      liveAppendQueueItemByMessageId.set(queuedMessageId, item);
    }
  }

  const visibleConversationRuns = activeConversationRuns.filter(
    (run) => run.status === 'running' && Boolean(run.responseParentId) && activeMessageIds.has(run.responseParentId!),
  );

  for (const run of visibleConversationRuns) {
    const messageId = run.responseParentId!;
    const existingItems = effectivePendingBranchExecutionsByMessageId.get(messageId) ?? [];
    const hasProcessingExecution = existingItems.some((item) => item.status === 'processing');
    if (!hasProcessingExecution && activeAgentId && activeConvId) {
      existingItems.push({
        id: `run-${run.id}`,
        agentId: activeAgentId,
        conversationId: activeConvId,
        mode: 'respond_to_message',
        prompt: '',
        status: 'processing',
        attempts: 0,
        createdAt: run.startedAt,
        targetMessageId: messageId,
        runId: run.id,
      });
      effectivePendingBranchExecutionsByMessageId.set(messageId, existingItems);
    }
  }

  const queuedMessages = activeBranchUserMessages
    .filter((message) => queuedStyleUserMessageIds.has(message.id))
    .map((message) => {
      const appendQueueItem = liveAppendQueueItemByMessageId.get(message.id) ?? null;
      const pendingExecutions = effectivePendingBranchExecutionsByMessageId.get(message.id) ?? [];
      const hasProcessingExecution =
        appendQueueItem?.status === 'processing' ||
        pendingExecutions.some((item) => item.status === 'processing');
      const status: 'queued' | 'processing' = hasProcessingExecution
        ? 'processing'
        : 'queued';
      return {
        message,
        status,
        queueItem: appendQueueItem,
      };
    });

  function shouldHideBranchError(item: AgentChatQueueItem): boolean {
    const anchorId = item.targetMessageId ?? item.queuedMessageId;
    if (!anchorId) {
      return false;
    }
    if (item.targetMessageId && activeChildParentIds.has(item.targetMessageId)) {
      return true;
    }

    const pendingExecutions = effectivePendingBranchExecutionsByMessageId.get(anchorId) ?? [];
    return pendingExecutions.some((pendingItem) => pendingItem.id !== item.id);
  }

  const errorsByMessageId = new Map<string, AgentChatQueueItem[]>();
  for (const item of notifyQueueItems) {
    if (shouldHideBranchError(item)) {
      continue;
    }
    const anchorId = item.targetMessageId ?? item.queuedMessageId;
    if (!anchorId || !activeMessageIds.has(anchorId)) continue;
    const entries = errorsByMessageId.get(anchorId) ?? [];
    entries.push(item);
    errorsByMessageId.set(anchorId, entries);
  }

  const orphanErrorItems = notifyQueueItems.filter((item) => {
    if (shouldHideBranchError(item)) {
      return false;
    }
    const anchorId = item.targetMessageId ?? item.queuedMessageId;
    if (!anchorId) return true;
    if (hiddenPendingMessageIds.has(anchorId)) return true;
    // If the anchor exists but isn't on the active path, the error belongs
    // to a different branch and should be hidden — not shown as an orphan.
    return false;
  });

  let activeProcessingTargetMessageId: string | null = null;
  if (visibleConversationRuns.length > 0) {
    activeProcessingTargetMessageId = visibleConversationRuns[0].responseParentId ?? null;
  } else {
    const processingQueueItem = queueItems.find((item) => {
        if (item.status !== 'processing') return false;
        if (getQueueItemMode(item) !== 'respond_to_message') return false;
        const anchorId = item.targetMessageId;
        return Boolean(anchorId && activeMessageIds.has(anchorId));
      });
    if (processingQueueItem) {
      activeProcessingTargetMessageId = processingQueueItem.targetMessageId ?? null;
    } else {
      const queuedBranchItem = queueItems.find((item) => {
          if (item.status !== 'queued') return false;
          const anchorId =
            getQueueItemMode(item) === 'respond_to_message'
              ? item.targetMessageId
              : item.queuedMessageId;
          return Boolean(anchorId && activeMessageIds.has(anchorId));
        });
      if (queuedBranchItem) {
        activeProcessingTargetMessageId =
          (getQueueItemMode(queuedBranchItem) === 'respond_to_message'
            ? queuedBranchItem.targetMessageId
            : queuedBranchItem.queuedMessageId) ?? null;
      } else if (activeConversationKey) {
        const optimisticTargetId = optimisticResponseParentIds[activeConversationKey] ?? null;
        activeProcessingTargetMessageId =
          optimisticTargetId && activeMessageIds.has(optimisticTargetId) ? optimisticTargetId : null;
      }
    }
  }

  const hasQueuedAppendProcessing = queuedQueueItems.some((item) => item.status === 'processing');
  const hasVisibleRespondProcessing =
    visibleConversationRuns.length > 0 ||
    queueItems.some(
      (item) =>
        item.status === 'processing' &&
        getQueueItemMode(item) === 'respond_to_message' &&
        Boolean(item.targetMessageId && activeBranchMessageIds.has(item.targetMessageId)),
    );
  const showStreamingBubble = hasQueuedAppendProcessing || hasVisibleRespondProcessing;

  return {
    visibleMessages,
    queuedQueueItems,
    queuedMessages,
    notifyQueueItems,
    effectivePendingBranchExecutionsByMessageId,
    errorsByMessageId,
    orphanErrorItems,
    activeProcessingTargetMessageId,
    showStreamingBubble,
  };
}
