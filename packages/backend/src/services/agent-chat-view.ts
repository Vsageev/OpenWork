import { store } from '../db/index.js';
import type { StoreRecord } from '../db/store.js';
import { listAgentChatTurns, type AgentChatTurnStatus } from './agent-chat-turns.js';

const ROOT_BRANCH_KEY = '__root__';

type ChatViewStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'stopped' | 'superseded';

type ChatViewAction =
  | 'edit_user_message'
  | 'edit_queue_item'
  | 'delete_queue_item'
  | 'retry'
  | 'stop'
  | 'switch_branch';

interface ChatViewMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  content: string | null;
  status: string | null;
  metadata: unknown;
  attachments: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ChatViewExecutionQueue {
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

interface ChatViewExecutionRun {
  id: string;
  status: string;
  errorMessage: string | null;
  responseText: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

interface ChatViewSibling {
  turnId: string;
  userMessageId: string | null;
  status: ChatViewStatus;
  turnType: string;
  supersedesTurnId: string | null;
  isSelected: boolean;
  createdAt: string | null;
}

interface ChatViewTurn {
  id: string;
  parentTurnId: string | null;
  status: ChatViewStatus;
  turnType: string;
  userMessage: ChatViewMessage | null;
  assistantMessage: ChatViewMessage | null;
  execution: {
    queue: ChatViewExecutionQueue | null;
    run: ChatViewExecutionRun | null;
  };
  branch: {
    parentTurnId: string | null;
    isSelected: boolean;
    siblingIndex: number;
    siblingCount: number;
    siblingIds: string[];
    siblings: ChatViewSibling[];
  };
  edit: {
    supersedesTurnId: string | null;
    supersededByTurnId: string | null;
    isSuperseded: boolean;
  };
  availableActions: ChatViewAction[];
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentConversationChatView {
  conversationId: string;
  agentId: string;
  total: number;
  entries: ChatViewTurn[];
  branches: Array<{
    parentTurnId: string | null;
    selectedTurnId: string | null;
    turnIds: string[];
  }>;
}

export function getAgentConversationChatView(
  agentId: string,
  conversationId: string,
): AgentConversationChatView {
  const messagesById = new Map(
    store
      .getAll('messages')
      .filter((message) => message.conversationId === conversationId)
      .map((message) => [String(message.id), message]),
  );
  const queueItems = store
    .getAll('agentChatQueue')
    .filter((item) => item.agentId === agentId && item.conversationId === conversationId)
    .sort(compareCreated);
  const runs = store
    .getAll('agent_runs')
    .filter(
      (run) =>
        run.agentId === agentId &&
        run.conversationId === conversationId &&
        run.triggerType === 'chat',
    )
    .sort(compareRunStarted);
  const turns = getTurnsForView(agentId, conversationId, messagesById, queueItems, runs);
  const activeBranches = getActiveBranches(conversationId);
  const turnsById = new Map(turns.map((turn) => [String(turn.id), turn]));
  const supersededByTurnId = new Map<string, string>();
  for (const turn of turns) {
    const supersedesTurnId = asString(turn.supersedesTurnId);
    if (supersedesTurnId) supersededByTurnId.set(supersedesTurnId, String(turn.id));
  }

  const groups = groupTurnsByParent(turns);
  const selectedTurnIds = new Set<string>();
  const entries: ChatViewTurn[] = [];
  let parentTurnId: string | null = null;

  while (true) {
    const siblings = groups.get(branchGroupKey(parentTurnId)) ?? [];
    if (siblings.length === 0) break;

    const selected = selectTurnForParent({
      parentTurnId,
      siblings,
      activeBranches,
      turnsById,
    });
    if (!selected || typeof selected.id !== 'string') break;
    if (selectedTurnIds.has(selected.id)) break;
    selectedTurnIds.add(selected.id);

    entries.push(
      buildChatViewTurn({
        turn: selected,
        siblings,
        messagesById,
        queueItems,
        runs,
        supersededByTurnId,
      }),
    );
    parentTurnId = selected.id;
  }

  const branches = [...groups.entries()].map(([key, siblings]) => {
    const parentId = key === ROOT_BRANCH_KEY ? null : key;
    const selected = selectTurnForParent({
      parentTurnId: parentId,
      siblings,
      activeBranches,
      turnsById,
    });
    return {
      parentTurnId: parentId,
      selectedTurnId: typeof selected?.id === 'string' ? selected.id : null,
      turnIds: siblings.map((turn) => String(turn.id)),
    };
  });

  return {
    conversationId,
    agentId,
    total: entries.length,
    entries,
    branches,
  };
}

function getTurnsForView(
  agentId: string,
  conversationId: string,
  messagesById: Map<string, StoreRecord>,
  queueItems: StoreRecord[],
  runs: StoreRecord[],
): StoreRecord[] {
  const turns = [...listAgentChatTurns(agentId, conversationId)];
  const userMessageToTurnId = new Map<string, string>();
  const runIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const turn of turns) {
    const turnId = asString(turn.id);
    if (turnId) turnIds.add(turnId);
    const userMessageId = asString(turn.userMessageId);
    if (turnId && userMessageId) userMessageToTurnId.set(userMessageId, turnId);
    const runId = asString(turn.runId);
    if (runId) runIds.add(runId);
  }

  const syntheticByUserMessageId = new Map<string, string>();
  const findParentTurnId = (userMessageId: string | null): string | null => {
    if (!userMessageId) return null;
    const message = messagesById.get(userMessageId);
    const previousUserMessageId =
      asString(message?.previousUserMessageId) ??
      findPreviousOutboundAncestor(messagesById, asString(message?.parentId));
    if (!previousUserMessageId) return null;
    return (
      userMessageToTurnId.get(previousUserMessageId) ??
      syntheticByUserMessageId.get(previousUserMessageId) ??
      null
    );
  };
  const registerSynthetic = (turn: StoreRecord) => {
    turns.push(turn);
    const turnId = asString(turn.id);
    const userMessageId = asString(turn.userMessageId);
    if (turnId) turnIds.add(turnId);
    if (turnId && userMessageId) {
      userMessageToTurnId.set(userMessageId, turnId);
      syntheticByUserMessageId.set(userMessageId, turnId);
    }
    const runId = asString(turn.runId);
    if (runId) runIds.add(runId);
  };

  for (const queue of queueItems) {
    const turnId = asString(queue.turnId);
    if (turnId && turnIds.has(turnId)) continue;
    const userMessageId = asString(queue.queuedMessageId) ?? asString(queue.targetMessageId);
    const runId = asString(queue.lastRunId) ?? asString(queue.runId);
    if (userMessageId && userMessageToTurnId.has(userMessageId)) continue;
    if (!userMessageId && runId && runIds.has(runId)) continue;
    const queueId = asString(queue.id);
    if (!queueId) continue;
    registerSynthetic({
      id: `legacy-queue:${queueId}`,
      agentId,
      conversationId,
      parentTurnId: findParentTurnId(userMessageId),
      userMessageId,
      assistantMessageId: asString(queue.responseMessageId),
      status: queueStatusToTurnStatus(asString(queue.status)),
      runId,
      source: 'legacy_view_queue',
      createdById: null,
      turnType: queue.mode === 'respond_to_message' ? 'response' : 'follow_up',
      supersedesTurnId: null,
      metadata: {},
      startedAt: asString(queue.startedAt),
      completedAt: asString(queue.completedAt),
      createdAt: asString(queue.createdAt),
      updatedAt: asString(queue.updatedAt),
    });
  }

  for (const run of runs) {
    const runId = asString(run.id);
    if (!runId || runIds.has(runId)) continue;
    const userMessageId = asString(run.responseParentId);
    if (userMessageId && userMessageToTurnId.has(userMessageId)) continue;
    registerSynthetic({
      id: `legacy-run:${runId}`,
      agentId,
      conversationId,
      parentTurnId: findParentTurnId(userMessageId),
      userMessageId,
      assistantMessageId: findAssistantMessageIdForRun(runId, messagesById),
      status: runStatusToTurnStatus(run),
      runId,
      source: 'legacy_view_run',
      createdById: null,
      turnType: 'follow_up',
      supersedesTurnId: null,
      metadata: {},
      startedAt: asString(run.startedAt),
      completedAt: asString(run.finishedAt),
      createdAt: asString(run.createdAt) ?? asString(run.startedAt),
      updatedAt: asString(run.updatedAt) ?? asString(run.finishedAt),
    });
  }

  for (const message of [...messagesById.values()].sort(compareCreated)) {
    if (message.direction !== 'outbound') continue;
    const userMessageId = asString(message.id);
    if (!userMessageId || userMessageToTurnId.has(userMessageId)) continue;
    const assistantMessageId = findAssistantMessageIdForUserMessage(userMessageId, messagesById);
    registerSynthetic({
      id: `legacy-message:${userMessageId}`,
      agentId,
      conversationId,
      parentTurnId: findParentTurnId(userMessageId),
      userMessageId,
      assistantMessageId,
      status: 'completed',
      runId: assistantMessageId ? getMessageRunId(messagesById.get(assistantMessageId)!) : null,
      source: 'legacy_view_message',
      createdById: null,
      turnType: 'follow_up',
      supersedesTurnId: null,
      metadata: {},
      startedAt: null,
      completedAt: asString(messagesById.get(assistantMessageId ?? '')?.createdAt),
      createdAt: asString(message.createdAt),
      updatedAt: asString(message.updatedAt),
    });
  }

  return turns.sort(compareCreated);
}

function buildChatViewTurn(options: {
  turn: StoreRecord;
  siblings: StoreRecord[];
  messagesById: Map<string, StoreRecord>;
  queueItems: StoreRecord[];
  runs: StoreRecord[];
  supersededByTurnId: Map<string, string>;
}): ChatViewTurn {
  const { turn, siblings, messagesById, queueItems, runs, supersededByTurnId } = options;
  const userMessageId = asString(turn.userMessageId);
  const assistantMessageId =
    asString(turn.assistantMessageId) ?? findAssistantMessageIdForTurn(turn, messagesById, runs);
  const userMessage = userMessageId ? (messagesById.get(userMessageId) ?? null) : null;
  const assistantMessage = assistantMessageId
    ? (messagesById.get(assistantMessageId) ?? null)
    : null;
  const queue = findQueueForTurn(turn, queueItems);
  const run = findRunForTurn(turn, queue, runs);
  const status = resolveChatViewStatus(turn, queue, run);
  const siblingIndex = Math.max(
    0,
    siblings.findIndex((sibling) => sibling.id === turn.id),
  );
  const siblingIds = siblings.map((sibling) => String(sibling.id));
  const supersededById = supersededByTurnId.get(String(turn.id)) ?? null;

  return {
    id: String(turn.id),
    parentTurnId: asString(turn.parentTurnId),
    status,
    turnType: asString(turn.turnType) ?? 'follow_up',
    userMessage: serializeMessage(userMessage),
    assistantMessage: serializeMessage(assistantMessage),
    execution: {
      queue: serializeQueue(queue),
      run: serializeRun(run),
    },
    branch: {
      parentTurnId: asString(turn.parentTurnId),
      isSelected: true,
      siblingIndex,
      siblingCount: siblings.length,
      siblingIds,
      siblings: siblings.map((sibling) =>
        serializeSibling(sibling, sibling.id === turn.id, queueItems, runs),
      ),
    },
    edit: {
      supersedesTurnId: asString(turn.supersedesTurnId),
      supersededByTurnId: supersededById,
      isSuperseded: status === 'superseded' || supersededById !== null,
    },
    availableActions: getAvailableActions({
      status,
      turn,
      queue,
      run,
      siblingCount: siblings.length,
    }),
    createdAt: asString(turn.createdAt),
    updatedAt: asString(turn.updatedAt),
    startedAt: asString(turn.startedAt),
    completedAt: asString(turn.completedAt),
  };
}

function serializeMessage(message: StoreRecord | null): ChatViewMessage | null {
  if (!message || typeof message.id !== 'string') return null;
  return {
    id: message.id,
    direction: message.direction === 'inbound' ? 'inbound' : 'outbound',
    type: asString(message.type) ?? 'text',
    content: typeof message.content === 'string' ? message.content : null,
    status: asString(message.status),
    metadata: message.metadata ?? null,
    attachments: message.attachments ?? null,
    createdAt: asString(message.createdAt),
    updatedAt: asString(message.updatedAt),
  };
}

function serializeQueue(queue: StoreRecord | null): ChatViewExecutionQueue | null {
  if (!queue || typeof queue.id !== 'string') return null;
  return {
    id: queue.id,
    status: asString(queue.status) ?? 'queued',
    runId: asString(queue.runId) ?? asString(queue.lastRunId),
    errorMessage: asString(queue.errorMessage),
    attempts: typeof queue.attempts === 'number' ? queue.attempts : null,
    maxAttempts: typeof queue.maxAttempts === 'number' ? queue.maxAttempts : null,
    nextAttemptAt: asString(queue.nextAttemptAt),
    startedAt: asString(queue.startedAt),
    completedAt: asString(queue.completedAt),
    usedFallback: queue.usedFallback === true,
    fallbackModel: asString(queue.fallbackModel),
  };
}

function serializeRun(run: StoreRecord | null): ChatViewExecutionRun | null {
  if (!run || typeof run.id !== 'string') return null;
  return {
    id: run.id,
    status: asString(run.status) ?? 'running',
    errorMessage: asString(run.errorMessage),
    responseText: asString(run.responseText),
    startedAt: asString(run.startedAt),
    finishedAt: asString(run.finishedAt),
    durationMs: typeof run.durationMs === 'number' ? run.durationMs : null,
  };
}

function serializeSibling(
  turn: StoreRecord,
  isSelected: boolean,
  queueItems: StoreRecord[],
  runs: StoreRecord[],
): ChatViewSibling {
  const queue = findQueueForTurn(turn, queueItems);
  const run = findRunForTurn(turn, queue, runs);
  return {
    turnId: String(turn.id),
    userMessageId: asString(turn.userMessageId),
    status: resolveChatViewStatus(turn, queue, run),
    turnType: asString(turn.turnType) ?? 'follow_up',
    supersedesTurnId: asString(turn.supersedesTurnId),
    isSelected,
    createdAt: asString(turn.createdAt),
  };
}

function getAvailableActions(options: {
  status: ChatViewStatus;
  turn: StoreRecord;
  queue: StoreRecord | null;
  run: StoreRecord | null;
  siblingCount: number;
}): ChatViewAction[] {
  const actions = new Set<ChatViewAction>();
  if (asString(options.turn.userMessageId) && options.status !== 'superseded') {
    actions.add('edit_user_message');
  }
  if (options.queue?.status === 'queued') {
    actions.add('edit_queue_item');
    actions.add('delete_queue_item');
  }
  if (options.queue?.status === 'failed' || options.queue?.status === 'cancelled') {
    actions.add('delete_queue_item');
  }
  if (options.status === 'failed' || options.status === 'stopped') {
    actions.add('retry');
  }
  if (options.status === 'processing' && asString(options.run?.id)) {
    actions.add('stop');
  }
  if (options.siblingCount > 1) {
    actions.add('switch_branch');
  }
  return [...actions];
}

function groupTurnsByParent(turns: StoreRecord[]): Map<string, StoreRecord[]> {
  const groups = new Map<string, StoreRecord[]>();
  for (const turn of turns) {
    const key = branchGroupKey(asString(turn.parentTurnId));
    const siblings = groups.get(key);
    if (siblings) siblings.push(turn);
    else groups.set(key, [turn]);
  }
  for (const siblings of groups.values()) {
    siblings.sort(compareCreated);
  }
  return groups;
}

function selectTurnForParent(options: {
  parentTurnId: string | null;
  siblings: StoreRecord[];
  activeBranches: Record<string, string>;
  turnsById: Map<string, StoreRecord>;
}): StoreRecord | null {
  const { parentTurnId, siblings, activeBranches, turnsById } = options;
  const parentUserMessageId = parentTurnId
    ? asString(turnsById.get(parentTurnId)?.userMessageId)
    : null;
  const selectedIds = [
    activeBranches[`turn:${parentTurnId ?? ROOT_BRANCH_KEY}`],
    activeBranches[`user:${parentUserMessageId ?? ROOT_BRANCH_KEY}`],
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const selectedId of selectedIds) {
    const selected = siblings.find(
      (turn) => turn.id === selectedId || turn.userMessageId === selectedId,
    );
    if (selected) return selected;
  }

  return (
    [...siblings].reverse().find((turn) => turn.status !== 'superseded') ??
    siblings[siblings.length - 1] ??
    null
  );
}

function findQueueForTurn(turn: StoreRecord, queueItems: StoreRecord[]): StoreRecord | null {
  const turnId = asString(turn.id);
  const userMessageId = asString(turn.userMessageId);
  const matches = queueItems.filter(
    (item) =>
      item.turnId === turnId ||
      (userMessageId &&
        (item.queuedMessageId === userMessageId || item.targetMessageId === userMessageId)),
  );
  return matches[matches.length - 1] ?? null;
}

function findRunForTurn(
  turn: StoreRecord,
  queue: StoreRecord | null,
  runs: StoreRecord[],
): StoreRecord | null {
  const ids = [asString(turn.runId), asString(queue?.runId), asString(queue?.lastRunId)].filter(
    (value): value is string => value !== null,
  );
  for (const id of ids) {
    const run = runs.find((candidate) => candidate.id === id);
    if (run) return run;
  }

  const turnId = asString(turn.id);
  const userMessageId = asString(turn.userMessageId);
  const matches = runs.filter(
    (run) =>
      (turnId && run.turnId === turnId) ||
      (userMessageId && run.responseParentId === userMessageId),
  );
  return matches[matches.length - 1] ?? null;
}

function findAssistantMessageIdForTurn(
  turn: StoreRecord,
  messagesById: Map<string, StoreRecord>,
  runs: StoreRecord[],
): string | null {
  const userMessageId = asString(turn.userMessageId);
  const runId = asString(turn.runId);
  const messages = [...messagesById.values()].sort(compareCreated);
  if (runId) {
    const byRun = messages.find((message) => getMessageRunId(message) === runId);
    if (typeof byRun?.id === 'string') return byRun.id;
  }
  if (userMessageId) {
    const byParent = messages.find(
      (message) => message.direction === 'inbound' && message.parentId === userMessageId,
    );
    if (typeof byParent?.id === 'string') return byParent.id;
    const run = runs.find((candidate) => candidate.responseParentId === userMessageId);
    const runResponse = run
      ? messages.find((message) => getMessageRunId(message) === run.id)
      : null;
    if (typeof runResponse?.id === 'string') return runResponse.id;
  }
  return null;
}

function findAssistantMessageIdForRun(
  runId: string,
  messagesById: Map<string, StoreRecord>,
): string | null {
  const message = [...messagesById.values()]
    .sort(compareCreated)
    .find((candidate) => getMessageRunId(candidate) === runId);
  return asString(message?.id);
}

function findAssistantMessageIdForUserMessage(
  userMessageId: string,
  messagesById: Map<string, StoreRecord>,
): string | null {
  const message = [...messagesById.values()]
    .sort(compareCreated)
    .find((candidate) => candidate.direction === 'inbound' && candidate.parentId === userMessageId);
  return asString(message?.id);
}

function findPreviousOutboundAncestor(
  messagesById: Map<string, StoreRecord>,
  parentId: string | null,
): string | null {
  let currentId = parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messagesById.get(currentId);
    if (!message) return null;
    if (message.direction === 'outbound' && typeof message.id === 'string') {
      return message.id as string;
    }
    currentId = asString(message.parentId);
  }
  return null;
}

function resolveChatViewStatus(
  turn: StoreRecord,
  queue: StoreRecord | null,
  run: StoreRecord | null,
): ChatViewStatus {
  if (queue?.status === 'processing' || run?.status === 'running') return 'processing';
  if (queue?.status === 'queued' || run?.status === 'queued') return 'queued';
  if (queue?.status === 'failed') return 'failed';
  if (queue?.status === 'cancelled') return 'stopped';
  if (run?.status === 'completed') return 'completed';
  if (run?.status === 'error') {
    return run.killedByUser === true || run.errorMessage === 'Killed by user'
      ? 'stopped'
      : 'failed';
  }

  const status = asString(turn.status) as AgentChatTurnStatus | null;
  if (status === 'running') return 'processing';
  if (status === 'stopped') return 'stopped';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  if (status === 'superseded') return 'superseded';
  return 'queued';
}

function queueStatusToTurnStatus(status: string | null): AgentChatTurnStatus {
  if (status === 'processing') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'stopped';
  return 'queued';
}

function runStatusToTurnStatus(run: StoreRecord): AgentChatTurnStatus {
  if (run.killedByUser === true || run.errorMessage === 'Killed by user') return 'stopped';
  if (run.status === 'queued') return 'queued';
  if (run.status === 'running') return 'running';
  if (run.status === 'completed') return 'completed';
  return 'failed';
}

function getMessageRunId(message: StoreRecord): string | null {
  const metadata = parseMetadata(message.metadata);
  return typeof metadata?.runId === 'string' ? metadata.runId : null;
}

function getActiveBranches(conversationId: string): Record<string, string> {
  const conversation = store.getById('conversations', conversationId);
  const metadata = parseMetadata(conversation?.metadata);
  const activeBranches = metadata?.activeBranches;
  return activeBranches && typeof activeBranches === 'object' && !Array.isArray(activeBranches)
    ? (activeBranches as Record<string, string>)
    : {};
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function branchGroupKey(parentTurnId: string | null): string {
  return parentTurnId ?? ROOT_BRANCH_KEY;
}

function compareCreated(a: StoreRecord, b: StoreRecord): number {
  return parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt);
}

function compareRunStarted(a: StoreRecord, b: StoreRecord): number {
  return parseIsoDateMs(a.startedAt) - parseIsoDateMs(b.startedAt);
}

function parseIsoDateMs(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
