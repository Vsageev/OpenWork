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
  queuePosition?: number | null;
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
  activeAgentId: string | null;
  activeConvId: string | null;
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
  turnId?: string;
  status: string;
  position?: number | null;
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
  turnId?: string | null;
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
  return buildCanonicalAgentConversationViewModel(options);
}

function buildCanonicalAgentConversationViewModel(
  options: BuildAgentConversationViewModelOptions,
): AgentConversationViewModel {
  const { canonicalView } = options;
  if (!canonicalView) return emptyAgentConversationViewModel();
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
  let activeConversationRun: AgentConversationRunSummary | null = null;
  let activeProcessingTargetMessageId: string | null = null;

  for (const turn of canonicalView.entries) {
    const queueItem = mapCanonicalQueueItem(canonicalView, turn);
    const userMessage = mapCanonicalMessage(turn.userMessage, turn);
    const assistantMessage = mapCanonicalMessage(turn.assistantMessage, turn);

    if (turn.status === 'queued' && userMessage) {
      if (queueItem) queuedQueueItems.push(queueItem);
      queuedMessages.push({
        message: userMessage,
        status: queueItem?.status === 'processing' ? 'processing' : 'queued',
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
    queuePosition: queue.position ?? null,
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

function queueItemToComparable(
  item: AgentChatQueueItem,
): Pick<AgentChatMessage, 'createdAt' | 'id'> {
  return { id: item.id, createdAt: item.createdAt };
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
