import { store } from '../db/index.js';
import type { StoreRecord } from '../db/store.js';
import {
  createAgentChatTurnRecord,
  findAgentChatTurnRecordByRunId,
  findAgentChatTurnRecordByUserMessage,
  getAgentChatTurnRecord,
  listAgentChatTurnRecordsForConversation,
  updateAgentChatTurnRecord,
  type AgentChatTurnStatus,
  type AgentChatTurnType,
} from '../db/repositories/agent-chat-turns-repository.js';

export type { AgentChatTurnStatus, AgentChatTurnType };

export interface CreateAgentChatTurnParams {
  id?: string;
  conversationId: string;
  agentId: string;
  parentTurnId?: string | null;
  parentUserMessageId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  status?: AgentChatTurnStatus;
  runId?: string | null;
  source?: string;
  createdById?: string | null;
  turnType?: AgentChatTurnType;
  supersedesTurnId?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LegacyAgentChatTurnBackfillResult {
  created: number;
  updatedQueueItems: number;
  updatedRuns: number;
  repairedParentLinks: number;
  updatedActiveBranches: number;
}

export interface BackfillLegacyAgentChatTurnsOptions {
  linkReferences?: boolean;
}

export function createAgentChatTurn(params: CreateAgentChatTurnParams): StoreRecord {
  const superseded = params.supersedesTurnId
    ? getAgentChatTurnRecord(params.supersedesTurnId)
    : null;
  const parentTurnId =
    params.parentTurnId ??
    (superseded
      ? asString(superseded.parentTurnId)
      : resolveParentTurnId({
          agentId: params.agentId,
          conversationId: params.conversationId,
          userMessageId: params.userMessageId ?? null,
          parentUserMessageId: params.parentUserMessageId ?? null,
        }));

  const turn = createAgentChatTurnRecord({
    ...params,
    parentTurnId,
    metadata: normalizeMetadata(params.metadata),
  });
  if (params.supersedesTurnId) {
    markAgentChatTurnSuperseded(params.supersedesTurnId);
  }
  return turn;
}

export function createReplacementAgentChatTurn(
  supersedesTurnId: string,
  params: Omit<CreateAgentChatTurnParams, 'supersedesTurnId' | 'turnType'>,
): StoreRecord {
  const superseded = getAgentChatTurnRecord(supersedesTurnId);
  const replacement = createAgentChatTurn({
    ...params,
    parentTurnId:
      params.parentTurnId ??
      (typeof superseded?.parentTurnId === 'string' ? (superseded.parentTurnId as string) : null),
    supersedesTurnId,
    turnType: 'edit',
  });
  return replacement;
}

export function updateAgentChatTurn(
  turnId: string | null | undefined,
  patch: Partial<CreateAgentChatTurnParams>,
): StoreRecord | null {
  if (!turnId) return null;
  const existing = getAgentChatTurnRecord(turnId);
  const existingMetadata =
    existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};
  const normalized = stripUndefined({
    ...patch,
    ...(patch.metadata
      ? { metadata: { ...existingMetadata, ...normalizeMetadata(patch.metadata) } }
      : {}),
  });
  return updateAgentChatTurnRecord(turnId, normalized);
}

function updateAgentChatTurnLifecycle(
  turnId: string | null | undefined,
  patch: Partial<CreateAgentChatTurnParams>,
): StoreRecord | null {
  if (!turnId) return null;
  const existing = getAgentChatTurnRecord(turnId);
  if (!existing) return null;
  const nextPatch = { ...patch };
  if (existing.status === 'superseded' && nextPatch.status !== 'superseded') {
    delete nextPatch.status;
  }
  return updateAgentChatTurn(turnId, nextPatch);
}

export function getAgentChatTurn(turnId: string): StoreRecord | null {
  return getAgentChatTurnRecord(turnId);
}

export function listAgentChatTurns(agentId: string, conversationId: string): StoreRecord[] {
  return listAgentChatTurnRecordsForConversation(agentId, conversationId);
}

export function findAgentChatTurnForUserMessage(
  agentId: string,
  conversationId: string,
  userMessageId: string,
): StoreRecord | null {
  return findAgentChatTurnRecordByUserMessage(agentId, conversationId, userMessageId);
}

export function ensureLegacyAgentChatTurnForUserMessage(
  agentId: string,
  conversationId: string,
  userMessageId: string | null,
): StoreRecord | null {
  if (!userMessageId) return null;
  const existing = findAgentChatTurnRecordByUserMessage(agentId, conversationId, userMessageId);
  if (existing) return existing;

  const message = store.getById('messages', userMessageId);
  if (!message || message.conversationId !== conversationId || message.direction !== 'outbound') {
    return null;
  }

  const parentUserMessageId = resolvePreviousUserMessageId(userMessageId);
  const parentTurn = ensureLegacyAgentChatTurnForUserMessage(
    agentId,
    conversationId,
    parentUserMessageId,
  );
  const run = findRunForUserMessage(agentId, conversationId, userMessageId);
  const runId = asString(run?.id);
  const assistantMessageId = findAssistantMessageForRun(conversationId, runId, userMessageId);

  return createAgentChatTurn({
    agentId,
    conversationId,
    parentTurnId: asString(parentTurn?.id),
    parentUserMessageId,
    userMessageId,
    assistantMessageId,
    status: run ? runStatusToTurnStatus(run) : 'completed',
    runId,
    source: 'legacy_message',
    turnType: 'follow_up',
    metadata: { materializedFrom: 'legacy_message' },
    startedAt: asString(run?.startedAt),
    completedAt:
      asString(run?.finishedAt) ?? asString(message.updatedAt) ?? asString(message.createdAt),
    createdAt: asString(message.createdAt) ?? undefined,
    updatedAt: asString(message.updatedAt) ?? undefined,
  });
}

export function markAgentChatTurnRunning(
  turnId: string | null | undefined,
  params: { runId?: string | null; userMessageId?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'running',
    runId: params.runId ?? undefined,
    userMessageId: params.userMessageId ?? undefined,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });
}

export function markAgentChatTurnCompleted(
  turnId: string | null | undefined,
  params: { assistantMessageId?: string | null; runId?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'completed',
    assistantMessageId: params.assistantMessageId ?? undefined,
    runId: params.runId ?? undefined,
    completedAt: new Date().toISOString(),
  });
}

export function markAgentChatTurnFailed(
  turnId: string | null | undefined,
  params: { runId?: string | null; errorMessage?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'failed',
    runId: params.runId ?? undefined,
    completedAt: new Date().toISOString(),
    metadata: params.errorMessage ? { errorMessage: params.errorMessage } : undefined,
  });
}

export function markAgentChatTurnQueued(turnId: string | null | undefined): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'queued',
    completedAt: null,
  });
}

export function markAgentChatTurnStopped(
  turnId: string | null | undefined,
  params: { runId?: string | null; errorMessage?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'stopped',
    runId: params.runId ?? undefined,
    completedAt: new Date().toISOString(),
    metadata: params.errorMessage ? { errorMessage: params.errorMessage } : undefined,
  });
}

export function markAgentChatTurnSuperseded(turnId: string | null | undefined): StoreRecord | null {
  return updateAgentChatTurn(turnId, {
    status: 'superseded',
    completedAt: new Date().toISOString(),
  });
}

export function backfillLegacyAgentChatTurns(
  options: BackfillLegacyAgentChatTurnsOptions = {},
): LegacyAgentChatTurnBackfillResult {
  const linkReferences = options.linkReferences ?? true;
  const result: LegacyAgentChatTurnBackfillResult = {
    created: 0,
    updatedQueueItems: 0,
    updatedRuns: 0,
    repairedParentLinks: 0,
    updatedActiveBranches: 0,
  };

  const queueItems = store
    .getAll('agentChatQueue')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  for (const item of queueItems) {
    const agentId = asString(item.agentId);
    const conversationId = asString(item.conversationId);
    if (!agentId || !conversationId) continue;
    if (!agentExists(agentId)) continue;

    const existingTurnId = asString(item.turnId);
    const existingTurn = existingTurnId ? getAgentChatTurnRecord(existingTurnId) : null;
    const mode = asString(item.mode) ?? 'append_prompt';
    const userMessageId =
      asString(item.queuedMessageId) ??
      (mode === 'respond_to_message' ? asString(item.targetMessageId) : null);
    if (userMessageId && !messageExists(userMessageId, conversationId)) continue;
    const runId = asString(item.lastRunId) ?? asString(item.runId);
    const assistantMessageId = asString(item.responseMessageId);
    const supersedesTurnId = inferSupersededTurnId({
      agentId,
      conversationId,
      mode,
      userMessageId,
    });
    const turnType = supersedesTurnId
      ? 'edit'
      : mode === 'respond_to_message'
        ? 'response'
        : 'follow_up';
    const legacyTurn = findExistingLegacyTurn({ agentId, conversationId, userMessageId, runId });
    const shouldCreate = !existingTurn && !legacyTurn;
    const turn =
      existingTurn ??
      legacyTurn ??
      createAgentChatTurn({
        conversationId,
        agentId,
        parentUserMessageId: asString(item.previousUserMessageId),
        userMessageId,
        assistantMessageId,
        status: queueStatusToTurnStatus(asString(item.status)),
        runId,
        source: 'legacy_queue',
        turnType,
        supersedesTurnId,
        metadata: {
          mode,
          queueItemId: item.id,
          targetMessageId: item.targetMessageId ?? null,
        },
        startedAt: asString(item.startedAt),
        completedAt: asString(item.completedAt),
        createdAt: asString(item.createdAt) ?? undefined,
        updatedAt: asString(item.updatedAt) ?? undefined,
      });

    if (shouldCreate) {
      result.created++;
    }

    const turnId = asString(turn.id);
    if (linkReferences && turnId && item.turnId !== turnId && typeof item.id === 'string') {
      store.update('agentChatQueue', item.id, { turnId });
      result.updatedQueueItems++;
    }
    if (linkReferences && turnId && runId) {
      const run = store.getById('agent_runs', runId);
      if (run && run.turnId !== turnId) {
        store.update('agent_runs', runId, { turnId });
        result.updatedRuns++;
      }
    }
  }

  const runs = store
    .getAll('agent_runs')
    .sort((a, b) => parseIsoDateMs(a.startedAt) - parseIsoDateMs(b.startedAt));
  for (const run of runs) {
    const runId = asString(run.id);
    const agentId = asString(run.agentId);
    const conversationId = asString(run.conversationId);
    if (!runId || !agentId || !conversationId || run.triggerType !== 'chat') continue;
    if (!agentExists(agentId)) continue;
    if (asString(run.turnId) && getAgentChatTurnRecord(asString(run.turnId)!)) continue;
    const existing = findAgentChatTurnRecordByRunId(runId);
    if (existing && typeof existing.id === 'string') {
      if (linkReferences) {
        store.update('agent_runs', runId, { turnId: existing.id });
        result.updatedRuns++;
      }
      continue;
    }

    const userMessageId = asString(run.responseParentId);
    if (userMessageId && !messageExists(userMessageId, conversationId)) continue;
    const assistantMessageId = findAssistantMessageForRun(conversationId, runId, userMessageId);
    const turn = createAgentChatTurn({
      conversationId,
      agentId,
      userMessageId,
      assistantMessageId,
      status: runStatusToTurnStatus(run),
      runId,
      source: 'legacy_run',
      turnType: 'follow_up',
      metadata: { triggerType: run.triggerType },
      startedAt: asString(run.startedAt),
      completedAt: asString(run.finishedAt),
      createdAt: asString(run.createdAt) ?? asString(run.startedAt) ?? undefined,
      updatedAt: asString(run.updatedAt) ?? asString(run.finishedAt) ?? undefined,
    });
    result.created++;
    if (linkReferences && typeof turn.id === 'string') {
      store.update('agent_runs', runId, { turnId: turn.id });
      result.updatedRuns++;
    }
  }

  const messages = store
    .getAll('messages')
    .filter((message) => message.direction === 'outbound')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  for (const message of messages) {
    const conversationId = asString(message.conversationId);
    const userMessageId = asString(message.id);
    if (!conversationId || !userMessageId) continue;
    const conversation = store.getById('conversations', conversationId);
    const agentId = asString(parseConversationMetadata(conversation?.metadata).agentId);
    if (!agentId) continue;
    if (!agentExists(agentId)) continue;
    if (findAgentChatTurnRecordByUserMessage(agentId, conversationId, userMessageId)) continue;
    const turn = ensureLegacyAgentChatTurnForUserMessage(agentId, conversationId, userMessageId);
    if (turn) result.created++;
  }

  const repairedConversationIds = repairExistingTurnParentLinks();
  result.repairedParentLinks = repairedConversationIds.repairedParentLinks;
  for (const conversationId of repairedConversationIds.conversationIds) {
    if (selectLatestTurnPath(conversationId) || selectLatestConversationPath(conversationId)) {
      result.updatedActiveBranches++;
    }
  }

  return result;
}

function repairExistingTurnParentLinks(): {
  repairedParentLinks: number;
  conversationIds: Set<string>;
} {
  let repairedParentLinks = 0;
  const repairedConversationIds = new Set<string>();
  const turns = store
    .getAll('agentChatTurns')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));

  for (const turn of turns) {
    const turnId = asString(turn.id);
    const agentId = asString(turn.agentId);
    const conversationId = asString(turn.conversationId);
    const userMessageId = asString(turn.userMessageId);
    if (!turnId || !agentId || !conversationId || !userMessageId) continue;
    if (!agentExists(agentId)) continue;

    const expectedParentTurnId = resolveExpectedParentTurnId({
      turn,
      agentId,
      conversationId,
      userMessageId,
    });
    if (expectedParentTurnId === turn.parentTurnId) continue;
    if (
      expectedParentTurnId &&
      (expectedParentTurnId === turnId || wouldCreateTurnCycle(turnId, expectedParentTurnId))
    ) {
      continue;
    }

    store.update('agentChatTurns', turnId, { parentTurnId: expectedParentTurnId });
    repairedParentLinks++;
    repairedConversationIds.add(conversationId);
  }

  return { repairedParentLinks, conversationIds: repairedConversationIds };
}

function resolveExpectedParentTurnId(options: {
  turn: StoreRecord;
  agentId: string;
  conversationId: string;
  userMessageId: string;
}): string | null {
  const supersedesTurnId = asString(options.turn.supersedesTurnId);
  if (supersedesTurnId) {
    const superseded = getAgentChatTurnRecord(supersedesTurnId);
    return asString(superseded?.parentTurnId);
  }

  return resolveParentTurnId({
    agentId: options.agentId,
    conversationId: options.conversationId,
    userMessageId: options.userMessageId,
    parentUserMessageId: null,
  });
}

function wouldCreateTurnCycle(turnId: string, parentTurnId: string): boolean {
  let currentId: string | null = parentTurnId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    if (currentId === turnId) return true;
    visited.add(currentId);
    const current = getAgentChatTurnRecord(currentId);
    currentId = asString(current?.parentTurnId);
  }
  return false;
}

function selectLatestConversationPath(conversationId: string): boolean {
  const messages = store
    .getAll('messages')
    .filter((message) => message.conversationId === conversationId && message.type !== 'system')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  const latest = messages[messages.length - 1];
  const latestId = asString(latest?.id);
  if (!latest || !latestId) return false;

  const messagesById = new Map(messages.map((message) => [String(message.id), message]));
  const targetUser =
    latest.direction === 'outbound'
      ? latest
      : findOutboundAncestorMessage(messagesById, asString(latest.parentId));
  const targetUserId = asString(targetUser?.id);
  if (!targetUser || !targetUserId) return false;

  const userLineage: StoreRecord[] = [];
  let currentUser: StoreRecord | null = targetUser;
  while (currentUser) {
    userLineage.push(currentUser);
    const previousUserMessageId = resolvePreviousUserMessageId(asString(currentUser.id));
    currentUser = previousUserMessageId ? (messagesById.get(previousUserMessageId) ?? null) : null;
  }

  const conversation = store.getById('conversations', conversationId);
  if (!conversation) return false;
  const metadata = parseConversationMetadata(conversation.metadata);
  const previousBranches =
    metadata.activeBranches &&
    typeof metadata.activeBranches === 'object' &&
    !Array.isArray(metadata.activeBranches)
      ? (metadata.activeBranches as Record<string, string>)
      : {};
  const nextBranches = { ...previousBranches };

  for (const userMessage of userLineage.reverse()) {
    const userMessageId = asString(userMessage.id);
    if (!userMessageId) continue;
    const previousUserMessageId = resolvePreviousUserMessageId(userMessageId);
    nextBranches[`user:${previousUserMessageId ?? '__root__'}`] = userMessageId;
  }
  if (latest.direction === 'inbound') {
    nextBranches[`reply:${targetUserId}`] = latestId;
  }

  if (shallowEqualRecord(previousBranches, nextBranches)) return false;
  store.update('conversations', conversationId, {
    metadata: { ...metadata, activeBranches: nextBranches },
  });
  return true;
}

function selectLatestTurnPath(conversationId: string): boolean {
  const conversation = store.getById('conversations', conversationId);
  if (!conversation) return false;
  const metadata = parseConversationMetadata(conversation.metadata);
  const agentId = asString(metadata.agentId);
  if (!agentId) return false;

  const turns = listAgentChatTurnRecordsForConversation(agentId, conversationId);
  const latest =
    [...turns].reverse().find((turn) => turn.status !== 'superseded') ??
    turns[turns.length - 1] ??
    null;
  const latestTurnId = asString(latest?.id);
  if (!latest || !latestTurnId) return false;

  const turnsById = new Map(turns.map((turn) => [String(turn.id), turn]));
  const turnLineage: StoreRecord[] = [];
  let current: StoreRecord | null = latest;
  const visited = new Set<string>();
  while (current) {
    const currentId = asString(current.id);
    if (!currentId || visited.has(currentId)) break;
    visited.add(currentId);
    turnLineage.push(current);
    const parentTurnId = asString(current.parentTurnId);
    current = parentTurnId ? (turnsById.get(parentTurnId) ?? null) : null;
  }

  const previousBranches =
    metadata.activeBranches &&
    typeof metadata.activeBranches === 'object' &&
    !Array.isArray(metadata.activeBranches)
      ? (metadata.activeBranches as Record<string, string>)
      : {};
  const nextBranches = { ...previousBranches };

  for (const turn of turnLineage.reverse()) {
    const turnId = asString(turn.id);
    const userMessageId = asString(turn.userMessageId);
    if (!turnId) continue;
    const parentTurnId = asString(turn.parentTurnId);
    const parentUserMessageId = parentTurnId
      ? asString(turnsById.get(parentTurnId)?.userMessageId)
      : null;
    nextBranches[`turn:${parentTurnId ?? '__root__'}`] = turnId;
    if (userMessageId) {
      nextBranches[`user:${parentUserMessageId ?? '__root__'}`] = userMessageId;
    }
  }

  if (shallowEqualRecord(previousBranches, nextBranches)) return false;
  store.update('conversations', conversationId, {
    metadata: { ...metadata, activeBranches: nextBranches },
  });
  return true;
}

function findOutboundAncestorMessage(
  messagesById: Map<string, StoreRecord>,
  parentId: string | null,
): StoreRecord | null {
  let currentId = parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messagesById.get(currentId);
    if (!message) return null;
    if (message.direction === 'outbound') return message;
    currentId = asString(message.parentId);
  }
  return null;
}

function shallowEqualRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function agentExists(agentId: string): boolean {
  return store.getById('agents', agentId) !== null;
}

function messageExists(messageId: string, conversationId: string): boolean {
  const message = store.getById('messages', messageId);
  return message?.conversationId === conversationId;
}

function findExistingLegacyTurn(options: {
  agentId: string;
  conversationId: string;
  userMessageId: string | null;
  runId: string | null;
}): StoreRecord | null {
  if (options.runId) {
    const runTurn = findAgentChatTurnRecordByRunId(options.runId);
    if (runTurn) return runTurn;
  }
  if (options.userMessageId) {
    return findAgentChatTurnRecordByUserMessage(
      options.agentId,
      options.conversationId,
      options.userMessageId,
    );
  }
  return null;
}

function resolveParentTurnId(options: {
  agentId: string;
  conversationId: string;
  userMessageId: string | null;
  parentUserMessageId: string | null;
}): string | null {
  const parentUserMessageId =
    options.parentUserMessageId ?? resolvePreviousUserMessageId(options.userMessageId);
  if (!parentUserMessageId) return null;
  const parent =
    findAgentChatTurnRecordByUserMessage(
      options.agentId,
      options.conversationId,
      parentUserMessageId,
    ) ??
    ensureLegacyAgentChatTurnForUserMessage(
      options.agentId,
      options.conversationId,
      parentUserMessageId,
    );
  return typeof parent?.id === 'string' ? (parent.id as string) : null;
}

function findRunForUserMessage(
  agentId: string,
  conversationId: string,
  userMessageId: string,
): StoreRecord | null {
  const runs = store
    .getAll('agent_runs')
    .filter(
      (run) =>
        run.agentId === agentId &&
        run.conversationId === conversationId &&
        run.triggerType === 'chat' &&
        run.responseParentId === userMessageId,
    )
    .sort((a, b) => parseIsoDateMs(a.startedAt) - parseIsoDateMs(b.startedAt));
  return runs[runs.length - 1] ?? null;
}

function resolvePreviousUserMessageId(userMessageId: string | null): string | null {
  if (!userMessageId) return null;
  const message = store.getById('messages', userMessageId);
  if (!message) return null;
  const stored = asString(message.previousUserMessageId);
  if (stored) return stored;
  return findPreviousOutboundAncestor(asString(message.conversationId), asString(message.parentId));
}

function findPreviousOutboundAncestor(
  conversationId: string | null,
  parentId: string | null,
): string | null {
  if (!conversationId || !parentId) return null;
  let currentId: string | null = parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = store.getById('messages', currentId);
    if (!message || message.conversationId !== conversationId) return null;
    if (message.direction === 'outbound' && typeof message.id === 'string') {
      return message.id as string;
    }
    currentId = asString(message.parentId);
  }
  return null;
}

function parseConversationMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function inferSupersededTurnId(options: {
  agentId: string;
  conversationId: string;
  mode: string;
  userMessageId: string | null;
}): string | null {
  if (options.mode !== 'respond_to_message' || !options.userMessageId) return null;
  const message = store.getById('messages', options.userMessageId);
  if (!message || message.direction !== 'outbound') return null;
  const siblings = store
    .getAll('messages')
    .filter(
      (candidate) =>
        candidate.id !== options.userMessageId &&
        candidate.conversationId === options.conversationId &&
        candidate.direction === 'outbound' &&
        ((candidate.parentId as string | null | undefined) ?? null) ===
          ((message.parentId as string | null | undefined) ?? null) &&
        ((candidate.previousUserMessageId as string | null | undefined) ?? null) ===
          ((message.previousUserMessageId as string | null | undefined) ?? null),
    )
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  for (const sibling of siblings.reverse()) {
    const siblingMessageId = asString(sibling.id);
    if (!siblingMessageId) continue;
    const turn = findAgentChatTurnRecordByUserMessage(
      options.agentId,
      options.conversationId,
      siblingMessageId,
    );
    if (typeof turn?.id === 'string') return turn.id as string;
  }
  return null;
}

function findAssistantMessageForRun(
  conversationId: string,
  runId: string | null,
  userMessageId: string | null,
): string | null {
  const messages = store
    .getAll('messages')
    .filter(
      (message) => message.conversationId === conversationId && message.direction === 'inbound',
    )
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  if (runId) {
    const byRun = messages.find(
      (message) => parseMessageMetadata(message.metadata).runId === runId,
    );
    if (typeof byRun?.id === 'string') return byRun.id as string;
  }
  if (!userMessageId) return null;
  const byParent = messages.find((message) => message.parentId === userMessageId);
  return typeof byParent?.id === 'string' ? (byParent.id as string) : null;
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

function normalizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || Array.isArray(value)) return {};
  return value;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function parseMessageMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function parseIsoDateMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}
