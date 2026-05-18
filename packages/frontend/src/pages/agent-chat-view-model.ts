export interface AgentChatAttachment {
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
  siblingTurnIds?: string[];
  turnId?: string | null;
  turnStatus?: AgentConversationChatTurn['status'];
  turnType?: AgentConversationChatTurn['turnType'];
  availableActions?: AgentConversationChatTurn['availableActions'];
  supersedesTurnId?: string | null;
  supersededByTurnId?: string | null;
  isSupersededTurn?: boolean;
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
  updatedAt?: string;
  targetMessageId?: string | null;
  queuedMessageId?: string | null;
  previousUserMessageId?: string | null;
  attachments?: AgentChatAttachment[] | null;
  runId?: string | null;
  errorMessage?: string | null;
  turnId?: string | null;
  turnStatus?: AgentConversationChatTurn['status'];
  availableActions?: AgentConversationChatTurn['availableActions'];
}

export interface AgentConversationRunSummary {
  id: string;
  agentId?: string;
  conversationId?: string | null;
  responseParentId?: string | null;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
}

export type QueueExecutionMode = NonNullable<AgentChatQueueItem['mode']>;

export interface BuildAgentConversationViewModelOptions {
  canonicalView?: AgentConversationChatView | null;
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
  activeConversationRun: AgentConversationRunSummary | null;
  activeProcessingTargetMessageId: string | null;
  showStreamingBubble: boolean;
}

export type AgentConversationChatTurnStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'superseded';

export type AgentConversationChatTurnAction =
  | 'edit_user_message'
  | 'edit_queue_item'
  | 'delete_queue_item'
  | 'retry'
  | 'stop'
  | 'switch_branch';

export interface AgentConversationChatViewMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  content: string | null;
  status: string | null;
  metadata?: string | Record<string, unknown> | null;
  attachments: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentConversationChatViewQueue {
  id: string;
  status: string;
  runId: string | null;
  errorMessage: string | null;
  attempts: number | null;
  maxAttempts: number | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  usedFallback: boolean;
  fallbackModel: string | null;
}

export interface AgentConversationChatViewRun {
  id: string;
  status: string;
  errorMessage: string | null;
  responseText: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface AgentConversationChatTurnSibling {
  turnId: string;
  userMessageId: string | null;
  status: AgentConversationChatTurnStatus;
  turnType: string;
  supersedesTurnId: string | null;
  isSelected: boolean;
  createdAt: string | null;
}

export interface AgentConversationChatTurn {
  id: string;
  parentTurnId: string | null;
  status: AgentConversationChatTurnStatus;
  turnType: string;
  userMessage: AgentConversationChatViewMessage | null;
  assistantMessage: AgentConversationChatViewMessage | null;
  execution: {
    queue: AgentConversationChatViewQueue | null;
    run: AgentConversationChatViewRun | null;
  };
  branch: {
    parentTurnId: string | null;
    isSelected: boolean;
    siblingIndex: number;
    siblingCount: number;
    siblingIds: string[];
    siblings: AgentConversationChatTurnSibling[];
  };
  edit: {
    supersedesTurnId: string | null;
    supersededByTurnId: string | null;
    isSuperseded: boolean;
  };
  availableActions: AgentConversationChatTurnAction[];
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentConversationChatView {
  conversationId: string;
  agentId: string;
  total: number;
  entries: AgentConversationChatTurn[];
  branches: Array<{
    parentTurnId: string | null;
    selectedTurnId: string | null;
    turnIds: string[];
  }>;
}

export function toQueueCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAttachmentRecords(raw: unknown): Record<string, unknown>[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (typeof raw === 'string') {
    try {
      return parseAttachmentRecords(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  if (!isRecord(raw)) return [];
  if (Array.isArray(raw.attachments)) return parseAttachmentRecords(raw.attachments);
  if (typeof raw.storagePath === 'string' || typeof raw.fileName === 'string') return [raw];
  return Object.values(raw).filter(isRecord);
}

function getAttachmentFileSize(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getAttachmentFileName(record: Record<string, unknown>, storagePath: string): string {
  if (typeof record.fileName === 'string' && record.fileName.trim()) return record.fileName;
  const pathName = storagePath.split('/').filter(Boolean).pop();
  return pathName || 'Attachment';
}

export function normalizeAgentChatAttachments(raw: unknown): AgentChatAttachment[] | null {
  const attachments = parseAttachmentRecords(raw)
    .map((record): AgentChatAttachment | null => {
      const storagePath =
        typeof record.storagePath === 'string'
          ? record.storagePath
          : typeof record.path === 'string'
            ? record.path
            : '';
      if (!storagePath) return null;
      const type = record.type === 'image' ? 'image' : 'file';
      return {
        type,
        fileName: getAttachmentFileName(record, storagePath),
        mimeType:
          typeof record.mimeType === 'string' && record.mimeType
            ? record.mimeType
            : type === 'image'
              ? 'image/*'
              : 'application/octet-stream',
        fileSize: getAttachmentFileSize(record.fileSize),
        storagePath,
      };
    })
    .filter((attachment): attachment is AgentChatAttachment => attachment !== null);
  return attachments.length > 0 ? attachments : null;
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
  if (options.canonicalView) {
    return buildCanonicalAgentConversationViewModel(options);
  }

  return buildLegacyAgentConversationViewModel(options);
}

function buildCanonicalAgentConversationViewModel(
  options: BuildAgentConversationViewModelOptions,
): AgentConversationViewModel {
  const { canonicalView } = options;
  if (!canonicalView) return buildLegacyAgentConversationViewModel(options);
  if (
    (options.activeAgentId && canonicalView.agentId !== options.activeAgentId) ||
    (options.activeConvId && canonicalView.conversationId !== options.activeConvId)
  ) {
    return emptyAgentConversationViewModel();
  }

  const visibleMessages: AgentChatMessage[] = [];
  const queuedQueueItems: AgentChatQueueItem[] = [];
  const queuedMessages: AgentConversationViewModel['queuedMessages'] = [];
  const notifyQueueItems: AgentChatQueueItem[] = [];
  const errorsByMessageId = new Map<string, AgentChatQueueItem[]>();
  const orphanErrorItems: AgentChatQueueItem[] = [];
  const effectivePendingBranchExecutionsByMessageId = new Map<string, AgentChatQueueItem[]>();
  const canonicalMessageIds = new Set<string>();
  let activeConversationRun: AgentConversationRunSummary | null = null;
  let activeProcessingTargetMessageId: string | null = null;

  for (const turn of canonicalView.entries) {
    const queueItem = mapCanonicalQueueItem(canonicalView, turn);
    const userMessage = mapCanonicalMessage(turn.userMessage, turn);
    const assistantMessage = mapCanonicalMessage(turn.assistantMessage, turn);

    if (userMessage) canonicalMessageIds.add(userMessage.id);
    if (assistantMessage) canonicalMessageIds.add(assistantMessage.id);

    if (turn.status === 'queued' && userMessage) {
      if (queueItem) queuedQueueItems.push(queueItem);
      queuedMessages.push({
        message: userMessage,
        status: 'queued',
        queueItem,
      });
      continue;
    }

    if (userMessage) {
      visibleMessages.push(userMessage);
    }

    if (turn.status === 'processing') {
      activeProcessingTargetMessageId = activeProcessingTargetMessageId ?? userMessage?.id ?? null;
      if (queueItem) {
        effectivePendingBranchExecutionsByMessageId.set(userMessage?.id ?? turn.id, [queueItem]);
      }
      const run = mapCanonicalRun(turn);
      if (run && !activeConversationRun) {
        activeConversationRun = run;
        activeProcessingTargetMessageId = userMessage?.id ?? null;
      }
    }

    if (assistantMessage) {
      visibleMessages.push(assistantMessage);
    }

    if (turn.status === 'failed' || turn.status === 'stopped') {
      const noticeItem = queueItem ?? mapCanonicalNoticeItem(canonicalView, turn);
      notifyQueueItems.push(noticeItem);
      if (userMessage) {
        errorsByMessageId.set(userMessage.id, [
          ...(errorsByMessageId.get(userMessage.id) ?? []),
          noticeItem,
        ]);
      } else {
        orphanErrorItems.push(noticeItem);
      }
    }
  }

  const optimisticQueuedMessages = mapPendingNetworkOptimisticMessages({
    messages: options.messages,
    queueItems: options.queueItems,
    canonicalMessageIds,
  });
  for (const row of optimisticQueuedMessages) {
    queuedMessages.push(row);
    if (row.queueItem) queuedQueueItems.push(row.queueItem);
  }

  queuedQueueItems.sort((a, b) =>
    compareByCreatedAt(queueItemToComparable(a), queueItemToComparable(b)),
  );
  queuedMessages.sort((a, b) => compareByCreatedAt(a.message, b.message));

  return {
    visibleMessages,
    queuedQueueItems,
    queuedMessages,
    notifyQueueItems,
    effectivePendingBranchExecutionsByMessageId,
    errorsByMessageId,
    orphanErrorItems,
    activeConversationRun,
    activeProcessingTargetMessageId,
    showStreamingBubble: activeProcessingTargetMessageId !== null,
  };
}

function emptyAgentConversationViewModel(): AgentConversationViewModel {
  return {
    visibleMessages: [],
    queuedQueueItems: [],
    queuedMessages: [],
    notifyQueueItems: [],
    effectivePendingBranchExecutionsByMessageId: new Map(),
    errorsByMessageId: new Map(),
    orphanErrorItems: [],
    activeConversationRun: null,
    activeProcessingTargetMessageId: null,
    showStreamingBubble: false,
  };
}

function mapCanonicalMessage(
  message: AgentConversationChatViewMessage | null,
  turn: AgentConversationChatTurn,
): AgentChatMessage | null {
  if (!message) return null;
  const navigableSiblings = turn.branch.siblings.filter(
    (sibling) => typeof sibling.userMessageId === 'string' && sibling.userMessageId.length > 0,
  );
  const siblingUserMessageIds = navigableSiblings.map((sibling) => sibling.userMessageId!);
  const siblingTurnIds = navigableSiblings.map((sibling) => sibling.turnId);
  const siblingIndex = Math.max(
    0,
    navigableSiblings.findIndex((sibling) => sibling.turnId === turn.id),
  );
  const branchFields =
    message.direction === 'outbound' && siblingUserMessageIds.length > 1
      ? {
          siblingIndex,
          siblingCount: siblingUserMessageIds.length,
          siblingIds: siblingUserMessageIds,
          siblingTurnIds,
        }
      : {};

  return {
    id: message.id,
    direction: message.direction,
    content: message.content ?? '',
    createdAt: message.createdAt ?? turn.createdAt ?? new Date(0).toISOString(),
    type: message.type,
    metadata: serializeCanonicalMessageMetadata(message.metadata),
    attachments: normalizeAgentChatAttachments(message.attachments),
    parentId:
      message.direction === 'inbound'
        ? (turn.userMessage?.id ?? turn.parentTurnId)
        : turn.parentTurnId,
    previousUserMessageId: null,
    turnId: turn.id,
    turnStatus: turn.status,
    turnType: turn.turnType,
    availableActions: turn.availableActions,
    supersedesTurnId: turn.edit.supersedesTurnId,
    supersededByTurnId: turn.edit.supersededByTurnId,
    isSupersededTurn: turn.edit.isSuperseded,
    ...branchFields,
  };
}

function serializeCanonicalMessageMetadata(
  metadata: string | Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata) return null;
  if (typeof metadata === 'string') return metadata;
  return JSON.stringify(metadata);
}

function mapCanonicalQueueItem(
  view: AgentConversationChatView,
  turn: AgentConversationChatTurn,
): AgentChatQueueItem | null {
  const queue = turn.execution.queue;
  if (!queue) return null;
  return {
    id: queue.id,
    agentId: view.agentId,
    conversationId: view.conversationId,
    mode:
      turn.turnType === 'response' || turn.turnType === 'edit'
        ? 'respond_to_message'
        : 'append_prompt',
    prompt: turn.userMessage?.content ?? '',
    status: canonicalStatusToQueueStatus(turn.status, queue.status),
    attempts: queue.attempts ?? 0,
    createdAt: turn.createdAt ?? queue.startedAt ?? new Date(0).toISOString(),
    updatedAt: turn.updatedAt ?? undefined,
    targetMessageId:
      turn.turnType === 'response' || turn.turnType === 'edit'
        ? (turn.userMessage?.id ?? null)
        : null,
    queuedMessageId: turn.userMessage?.id ?? null,
    previousUserMessageId: null,
    attachments: normalizeAgentChatAttachments(turn.userMessage?.attachments),
    runId: queue.runId ?? turn.execution.run?.id ?? null,
    errorMessage: queue.errorMessage ?? turn.execution.run?.errorMessage ?? null,
    turnId: turn.id,
    turnStatus: turn.status,
    availableActions: turn.availableActions,
  };
}

function mapCanonicalNoticeItem(
  view: AgentConversationChatView,
  turn: AgentConversationChatTurn,
): AgentChatQueueItem {
  return {
    id: `turn-notice:${turn.id}`,
    agentId: view.agentId,
    conversationId: view.conversationId,
    mode:
      turn.turnType === 'response' || turn.turnType === 'edit'
        ? 'respond_to_message'
        : 'append_prompt',
    prompt: turn.userMessage?.content ?? '',
    status: canonicalStatusToQueueStatus(turn.status, null),
    attempts: 0,
    createdAt: turn.createdAt ?? new Date(0).toISOString(),
    targetMessageId: turn.userMessage?.id ?? null,
    queuedMessageId: turn.userMessage?.id ?? null,
    previousUserMessageId: null,
    attachments: normalizeAgentChatAttachments(turn.userMessage?.attachments),
    runId: turn.execution.run?.id ?? null,
    errorMessage: turn.execution.run?.errorMessage ?? null,
    turnId: turn.id,
    turnStatus: turn.status,
    availableActions: turn.availableActions.filter(
      (action) =>
        action !== 'retry' && action !== 'delete_queue_item' && action !== 'edit_queue_item',
    ),
  };
}

function mapCanonicalRun(turn: AgentConversationChatTurn): AgentConversationRunSummary | null {
  const run = turn.execution.run;
  if (!run || run.status !== 'running') return null;
  return {
    id: run.id,
    responseParentId: turn.userMessage?.id ?? null,
    status: 'running',
    startedAt: run.startedAt ?? turn.startedAt ?? turn.createdAt ?? new Date(0).toISOString(),
  };
}

function canonicalStatusToQueueStatus(
  turnStatus: AgentConversationChatTurnStatus,
  queueStatus: string | null,
): AgentChatQueueItem['status'] {
  if (queueStatus === 'queued' || queueStatus === 'processing' || queueStatus === 'completed') {
    return queueStatus;
  }
  if (queueStatus === 'failed' || queueStatus === 'cancelled') return queueStatus;
  if (turnStatus === 'processing') return 'processing';
  if (turnStatus === 'failed') return 'failed';
  if (turnStatus === 'stopped') return 'cancelled';
  if (turnStatus === 'completed' || turnStatus === 'superseded') return 'completed';
  return 'queued';
}

function mapPendingNetworkOptimisticMessages(options: {
  messages: AgentChatMessage[];
  queueItems: AgentChatQueueItem[];
  canonicalMessageIds: Set<string>;
}): AgentConversationViewModel['queuedMessages'] {
  const queueByMessageId = new Map<string, AgentChatQueueItem>();
  for (const item of options.queueItems) {
    if (!item.id.startsWith('temp-')) continue;
    const messageId = item.queuedMessageId ?? item.targetMessageId ?? null;
    if (messageId) queueByMessageId.set(messageId, item);
  }

  return options.messages
    .filter(
      (message) =>
        message.direction === 'outbound' &&
        !options.canonicalMessageIds.has(message.id) &&
        queueByMessageId.has(message.id),
    )
    .map((message) => ({
      message,
      status: queueByMessageId.get(message.id)?.status === 'processing' ? 'processing' : 'queued',
      queueItem: queueByMessageId.get(message.id) ?? null,
    }));
}

function queueItemToComparable(
  item: AgentChatQueueItem,
): Pick<AgentChatMessage, 'createdAt' | 'id'> {
  return { id: item.id, createdAt: item.createdAt };
}

// Compatibility fallback for callers still passing legacy messages, queue rows,
// active runs, and branch metadata. Scheduled for removal after all chat UI reads
// come exclusively from the canonical turn view endpoint.
function buildLegacyAgentConversationViewModel(
  options: BuildAgentConversationViewModelOptions,
): AgentConversationViewModel {
  const {
    messages,
    activeAgentId,
    activeConvId,
    activeConversationKey,
    optimisticResponseParentIds,
  } = options;
  const queueItems = options.queueItems.filter((item) => {
    if (!activeAgentId || !activeConvId) return false;
    return item.agentId === activeAgentId && item.conversationId === activeConvId;
  });
  const activeConversationRuns = options.activeConversationRuns.filter((run) => {
    if (run.status !== 'running') return false;
    if (activeAgentId && run.agentId && run.agentId !== activeAgentId) return false;
    if (activeConvId && run.conversationId && run.conversationId !== activeConvId) return false;
    return true;
  });

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
  const terminalAppendQueueMessageIds = new Set(
    queueItems
      .filter((item) => {
        if (getQueueItemMode(item) !== 'append_prompt') return false;
        return (
          item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled'
        );
      })
      .map((item) => item.queuedMessageId ?? null)
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  const settledUserMessageIds = new Set([
    ...agentResponseParentIds,
    ...terminalAppendQueueMessageIds,
  ]);
  const queuedStyleUserMessageIds = new Set(
    activeBranchUserMessages
      .filter((message) => {
        const previousUserMessageId = message.previousUserMessageId ?? null;
        if (!previousUserMessageId) return false;
        if (!activeBranchUserMessageIds.has(previousUserMessageId)) return false;
        return !settledUserMessageIds.has(previousUserMessageId);
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
  const selectedUserMessageByPreviousMessageId = new Map<string, AgentChatMessage>();
  for (const message of activeBranchMessages) {
    if (message.direction !== 'outbound') continue;
    const key = message.previousUserMessageId ?? ROOT_PREVIOUS_USER_MESSAGE_KEY;
    selectedUserMessageByPreviousMessageId.set(key, message);
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
      const selectedMessage = selectedUserMessageByPreviousMessageId.get(selectionKey) ?? null;
      const selectedMessageId = selectedMessage?.id ?? null;

      if (
        previousUserMessageId !== null &&
        selectedMessageId &&
        queuedMessageId &&
        selectedMessageId !== queuedMessageId
      ) {
        return false;
      }

      if (
        previousUserMessageId === null &&
        selectedMessageId &&
        queuedMessageId &&
        selectedMessageId !== queuedMessageId
      ) {
        const siblingIds = selectedMessage?.siblingIds ?? [];
        if (siblingIds.includes(queuedMessageId)) {
          return false;
        }
        // Active path sometimes omits `siblingIds` (partial payloads); `siblingCount`
        // still proves multiple root variants — hide other variants' append queue.
        if (typeof selectedMessage?.siblingCount === 'number' && selectedMessage.siblingCount > 1) {
          return false;
        }
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
    (run) =>
      run.status === 'running' &&
      Boolean(run.responseParentId) &&
      activeMessageIds.has(run.responseParentId!),
  );
  const activeConversationRun = visibleConversationRuns[0] ?? null;

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
      const status: 'queued' | 'processing' = hasProcessingExecution ? 'processing' : 'queued';
      return {
        message,
        status,
        queueItem: appendQueueItem,
      };
    });

  const queuedMessageIds = new Set(queuedMessages.map(({ message }) => message.id));
  for (const item of queuedQueueItems) {
    const queuedMessageId = item.queuedMessageId ?? null;
    if (!queuedMessageId) continue;
    if (activeBranchMessageIds.has(queuedMessageId)) continue;
    if (queuedMessageIds.has(queuedMessageId)) continue;
    const attachments = normalizeAgentChatAttachments(item.attachments);

    queuedMessages.push({
      message: {
        id: queuedMessageId,
        direction: 'outbound',
        content: item.prompt,
        createdAt: item.createdAt,
        type: attachments?.length
          ? attachments.every((attachment) => attachment.type === 'image')
            ? 'image'
            : 'file'
          : 'text',
        metadata: null,
        attachments,
        parentId: null,
        previousUserMessageId: item.previousUserMessageId ?? null,
      },
      status: item.status === 'processing' ? 'processing' : 'queued',
      queueItem: item,
    });
    queuedMessageIds.add(queuedMessageId);
  }
  queuedMessages.sort((a, b) => compareByCreatedAt(a.message, b.message));

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
          optimisticTargetId && activeMessageIds.has(optimisticTargetId)
            ? optimisticTargetId
            : null;
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
    activeConversationRun,
    activeProcessingTargetMessageId,
    showStreamingBubble,
  };
}

export function buildAgentChatMarkdownExport(options: {
  agentName: string;
  conversationSubject: string | null;
  messages: AgentChatMessage[];
  /** When true, note sibling branch variants (export includes all branches). */
  includeAllBranches?: boolean;
}): string {
  const { agentName, conversationSubject, messages, includeAllBranches } = options;
  const title = conversationSubject?.trim() || 'Conversation';
  const exportedAt = new Date().toISOString();
  const lines: string[] = [
    `# ${title}`,
    '',
    `**Agent:** ${agentName}`,
    `**Exported:** ${exportedAt}`,
  ];
  if (includeAllBranches) {
    lines.push(
      '_This export lists every message from every branch (not only the branch visible in the UI). Chronological order may interleave parallel branches._',
    );
  }
  lines.push('', '---', '');

  for (const msg of messages) {
    const role = msg.direction === 'outbound' ? 'You' : 'Assistant';
    const when = new Date(msg.createdAt).toISOString();
    lines.push(`## ${role}`);
    lines.push(`_${when}_`);
    if (
      includeAllBranches &&
      typeof msg.siblingCount === 'number' &&
      msg.siblingCount > 1 &&
      typeof msg.siblingIndex === 'number'
    ) {
      lines.push(
        `_Branch variant ${msg.siblingIndex + 1} of ${msg.siblingCount} at this tree step._`,
      );
    }
    lines.push('');
    const attachments = normalizeAgentChatAttachments(msg.attachments);
    if (attachments?.length) {
      for (const att of attachments) {
        lines.push(`- _Attachment (${att.type}):_ \`${att.fileName}\` (${att.mimeType})`);
      }
      lines.push('');
    }
    const body = msg.content?.trim();
    if (body) {
      lines.push(body);
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
