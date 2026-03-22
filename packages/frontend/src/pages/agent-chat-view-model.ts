export interface AgentChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  createdAt: string;
  parentId?: string | null;
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
  activeConversationRun: AgentConversationRunSummary | null;
  activeAgentId: string | null;
  activeConvId: string | null;
  activeConversationKey: string | null;
  optimisticResponseParentIds: Record<string, string | null | undefined>;
  streaming: boolean;
}

export interface AgentConversationViewModel {
  queuedQueueItems: AgentChatQueueItem[];
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

export function buildAgentConversationViewModel(
  options: BuildAgentConversationViewModelOptions,
): AgentConversationViewModel {
  const {
    messages,
    queueItems,
    activeConversationRun,
    activeAgentId,
    activeConvId,
    activeConversationKey,
    optimisticResponseParentIds,
    streaming,
  } = options;

  const queuedQueueItems = queueItems.filter(
    (item) => item.status === 'queued' && getQueueItemMode(item) === 'append_prompt',
  );
  const notifyQueueItems = queueItems.filter(
    (item) => item.status === 'failed' || item.status === 'cancelled',
  );

  const activeMessageIds = new Set(messages.map((message) => message.id));
  const activeChildParentIds = new Set(
    messages
      .map((message) => message.parentId ?? null)
      .filter((parentId): parentId is string => Boolean(parentId)),
  );
  const pendingBranchExecutionsByMessageId = new Map<string, AgentChatQueueItem[]>();
  for (const item of queueItems) {
    if (getQueueItemMode(item) !== 'respond_to_message') continue;
    if (item.status !== 'queued' && item.status !== 'processing') continue;
    if (!item.targetMessageId) continue;
    const entries = pendingBranchExecutionsByMessageId.get(item.targetMessageId) ?? [];
    entries.push(item);
    pendingBranchExecutionsByMessageId.set(item.targetMessageId, entries);
  }

  const effectivePendingBranchExecutionsByMessageId = new Map<string, AgentChatQueueItem[]>();
  for (const [messageId, items] of pendingBranchExecutionsByMessageId.entries()) {
    effectivePendingBranchExecutionsByMessageId.set(messageId, [...items]);
  }

  if (
    activeConversationRun?.status === 'running' &&
    activeConversationRun.responseParentId &&
    activeMessageIds.has(activeConversationRun.responseParentId)
  ) {
    const messageId = activeConversationRun.responseParentId;
    const existingItems = effectivePendingBranchExecutionsByMessageId.get(messageId) ?? [];
    const hasProcessingExecution = existingItems.some((item) => item.status === 'processing');
    if (!hasProcessingExecution && activeAgentId && activeConvId) {
      existingItems.push({
        id: `run-${activeConversationRun.id}`,
        agentId: activeAgentId,
        conversationId: activeConvId,
        mode: 'respond_to_message',
        prompt: '',
        status: 'processing',
        attempts: 0,
        createdAt: activeConversationRun.startedAt,
        targetMessageId: messageId,
        runId: activeConversationRun.id,
      });
      effectivePendingBranchExecutionsByMessageId.set(messageId, existingItems);
    }
  }

  function shouldHideBranchError(item: AgentChatQueueItem): boolean {
    if (getQueueItemMode(item) !== 'respond_to_message' || !item.targetMessageId) {
      return false;
    }
    if (activeChildParentIds.has(item.targetMessageId)) {
      return true;
    }

    const pendingExecutions =
      effectivePendingBranchExecutionsByMessageId.get(item.targetMessageId) ?? [];
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
    // If the anchor exists but isn't on the active path, the error belongs
    // to a different branch and should be hidden — not shown as an orphan.
    return false;
  });

  let activeProcessingTargetMessageId: string | null = null;
  if (activeConversationRun?.status === 'running' && activeConversationRun.responseParentId) {
    activeProcessingTargetMessageId = activeConversationRun.responseParentId;
  } else {
    const processingQueueItem = queueItems.find(
      (item) =>
        item.status === 'processing' &&
        getQueueItemMode(item) === 'respond_to_message' &&
        item.targetMessageId,
    );
    if (processingQueueItem?.targetMessageId) {
      activeProcessingTargetMessageId = processingQueueItem.targetMessageId;
    } else {
      const queuedBranchItem = queueItems.find(
        (item) =>
          item.status === 'queued' &&
          getQueueItemMode(item) === 'respond_to_message' &&
          item.targetMessageId,
      );
      if (queuedBranchItem?.targetMessageId) {
        activeProcessingTargetMessageId = queuedBranchItem.targetMessageId;
      } else if (activeConversationKey) {
        activeProcessingTargetMessageId =
          optimisticResponseParentIds[activeConversationKey] ?? null;
      }
    }
  }

  const activeLeafMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  const showStreamingBubble =
    streaming &&
    (!activeProcessingTargetMessageId || activeProcessingTargetMessageId === activeLeafMessageId);

  return {
    queuedQueueItems,
    notifyQueueItems,
    effectivePendingBranchExecutionsByMessageId,
    errorsByMessageId,
    orphanErrorItems,
    activeProcessingTargetMessageId,
    showStreamingBubble,
  };
}
