import { and, asc, count, desc, eq, or } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordsFromLegacyRows } from './native-repository-utils.js';

/** SQL store collection names for agent execution state. */
export const AGENT_RUNS_COLLECTION = 'agent_runs';
export const AGENT_CHAT_QUEUE_COLLECTION = 'agentChatQueue';
export const AGENT_BATCH_RUNS_COLLECTION = 'agentBatchRuns';
export const AGENT_BATCH_RUN_ITEMS_COLLECTION = 'agentBatchRunItems';

function parseIsoDateMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

// ---------------------------------------------------------------------------
// Agent runs — hot paths use native SQL when Postgres is available
// ---------------------------------------------------------------------------

export function countRunningAgentRunsWithLivePid(isPidAlive: (pid: number) => boolean): number {
  let count = 0;
  for (const r of store.getAll(AGENT_RUNS_COLLECTION)) {
    if (r.status !== 'running' || typeof r.pid !== 'number') continue;
    if (isPidAlive(r.pid as number)) count += 1;
  }
  return count;
}

export function findRunningAgentRuns(): StoreRecord[] {
  return store.getAll(AGENT_RUNS_COLLECTION).filter((r) => r.status === 'running');
}

export type AgentRunListFilter = {
  status?: string;
  agentId?: string;
  triggerType?: string;
  conversationId?: string;
};

export function findAgentRunsByListFilter(filter: AgentRunListFilter): StoreRecord[] {
  return store.getAll(AGENT_RUNS_COLLECTION).filter((r) => {
    if (filter.status && r.status !== filter.status) return false;
    if (filter.agentId && r.agentId !== filter.agentId) return false;
    if (filter.triggerType && r.triggerType !== filter.triggerType) return false;
    if (filter.conversationId && r.conversationId !== filter.conversationId) return false;
    return true;
  });
}

/** Running chat-triggered runs for an agent/conversation (optional responseParentId match). */
export function findLivePersistedChatRuns(options: {
  agentId: string;
  conversationId: string;
  /** When set (including `null`), narrows to runs whose responseParentId matches. Omit to skip this filter. */
  targetMessageId?: string | null;
}): StoreRecord[] {
  let rows = store.getAll(AGENT_RUNS_COLLECTION).filter((r: Record<string, unknown>) => {
    if (r.status !== 'running') return false;
    if (r.triggerType !== 'chat') return false;
    if (r.agentId !== options.agentId) return false;
    if (r.conversationId !== options.conversationId) return false;
    return true;
  });

  if ('targetMessageId' in options) {
    const want = options.targetMessageId ?? null;
    rows = rows.filter((run) => {
      const responseParentId =
        typeof run.responseParentId === 'string' ? (run.responseParentId as string) : null;
      return responseParentId === want;
    });
  }

  return rows;
}

/**
 * Non-running runs whose coalesce(finishedAt, startedAt) is before `cutoffTimestampMs`.
 */
export function findAgentRunIdsForRetentionCleanup(cutoffTimestampMs: number): string[] {
  return store
    .getAll(AGENT_RUNS_COLLECTION)
    .filter((r) => {
      if (r.status === 'running') return false;
      const finished = r.finishedAt ?? r.startedAt;
      return new Date(finished as string).getTime() < cutoffTimestampMs;
    })
    .map((r) => String(r.id));
}

export function findAgentRunsWithLegacyTriggerTypes(): StoreRecord[] {
  return store
    .getAll(AGENT_RUNS_COLLECTION)
    .filter((r) => r.triggerType === 'cron' || r.triggerType === 'card');
}

// ---------------------------------------------------------------------------
// Agent chat queue
// ---------------------------------------------------------------------------

export function findChatQueueItemProcessingForRunId(runId: string): StoreRecord | null {
  for (const r of store.getAll(AGENT_CHAT_QUEUE_COLLECTION)) {
    if (r.status === 'processing' && r.runId === runId) return r;
  }
  return null;
}

export function listChatQueueItemsWithStatus(status: string): StoreRecord[] {
  return store.getAll(AGENT_CHAT_QUEUE_COLLECTION).filter((r) => r.status === status);
}

export function deleteTerminalChatQueueItemsBeyondRetention(options: {
  terminalStatuses: readonly string[];
  retentionMs: number;
  nowMs: number;
}): StoreRecord[] {
  const allowed = new Set(options.terminalStatuses);
  const candidates = store.getAll(AGENT_CHAT_QUEUE_COLLECTION).filter((r) => {
    if (!allowed.has(String(r.status))) return false;
    const completedAtMs = parseIsoDateMs(r.completedAt);
    if (!Number.isFinite(completedAtMs)) return false;
    return options.nowMs - completedAtMs > options.retentionMs;
  });

  const deleted: StoreRecord[] = [];
  for (const r of candidates) {
    const id = String(r.id);
    const removed = store.delete(AGENT_CHAT_QUEUE_COLLECTION, id);
    if (removed) deleted.push(removed);
  }
  return deleted;
}

export function deleteChatQueueItemsForConversation(conversationId: string): void {
  const ids = store
    .getAll(AGENT_CHAT_QUEUE_COLLECTION)
    .filter((r) => r.conversationId === conversationId)
    .map((r) => String(r.id));
  for (const id of ids) {
    store.delete(AGENT_CHAT_QUEUE_COLLECTION, id);
  }
}

export function listConversationChatQueueItems(
  agentId: string,
  conversationId: string,
): StoreRecord[] {
  return store
    .getAll(AGENT_CHAT_QUEUE_COLLECTION)
    .filter((r) => r.agentId === agentId && r.conversationId === conversationId)
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
}

export function countQueuedAppendPromptsForConversation(
  agentId: string,
  conversationId: string,
): number {
  let n = 0;
  for (const r of store.getAll(AGENT_CHAT_QUEUE_COLLECTION)) {
    if (r.agentId !== agentId || r.conversationId !== conversationId || r.status !== 'queued') {
      continue;
    }
    const mode = (r.mode as string | undefined) ?? 'append_prompt';
    if (mode === 'append_prompt') n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Agent batch runs / items
// ---------------------------------------------------------------------------

export function listOrderedBatchRunItemsForRun(runId: string): StoreRecord[] {
  return store
    .getAll(AGENT_BATCH_RUN_ITEMS_COLLECTION)
    .filter((r) => r.runId === runId)
    .sort((a, b) => {
      const orderA = Number(a.order ?? Number.MAX_SAFE_INTEGER);
      const orderB = Number(b.order ?? Number.MAX_SAFE_INTEGER);
      if (orderA !== orderB) return orderA - orderB;
      return parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt);
    });
}

export function findBatchRunItemsWithStatus(status: string): StoreRecord[] {
  return store.getAll(AGENT_BATCH_RUN_ITEMS_COLLECTION).filter((r) => r.status === status);
}

export function findBatchRunItemsQueuedOrProcessing(): StoreRecord[] {
  return store
    .getAll(AGENT_BATCH_RUN_ITEMS_COLLECTION)
    .filter((r) => r.status === 'queued' || r.status === 'processing');
}

export function findTerminalBatchRuns(): StoreRecord[] {
  return store
    .getAll(AGENT_BATCH_RUNS_COLLECTION)
    .filter(
      (r) =>
        r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled',
    );
}

export function findBatchRunsEligibleForHistoryPrune(options: {
  retentionMs: number;
  nowMs: number;
}): StoreRecord[] {
  return store.getAll(AGENT_BATCH_RUNS_COLLECTION).filter((r) => {
    if (r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled') return false;
    const finishedAtMs = parseIsoDateMs(r.finishedAt);
    if (!Number.isFinite(finishedAtMs)) return false;
    return options.nowMs - finishedAtMs > options.retentionMs;
  });
}

export function deleteBatchRunItemsForRun(runId: string): StoreRecord[] {
  const removed: StoreRecord[] = [];
  const ids = store
    .getAll(AGENT_BATCH_RUN_ITEMS_COLLECTION)
    .filter((item) => item.runId === runId)
    .map((item) => String(item.id));
  for (const id of ids) {
    const del = store.delete(AGENT_BATCH_RUN_ITEMS_COLLECTION, id);
    if (del) removed.push(del);
  }
  return removed;
}

export function listAgentBatchRunsMatching(options: {
  sourceType?: string;
  sourceId?: string;
  agentId?: string;
}): StoreRecord[] {
  const { sourceType, sourceId, agentId } = options;
  return store.getAll(AGENT_BATCH_RUNS_COLLECTION).filter((r: Record<string, unknown>) => {
    if (sourceType && r.sourceType !== sourceType) return false;
    if (sourceId && r.sourceId !== sourceId) return false;
    if (agentId && r.agentId !== agentId) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Native SQL (indexed WHERE clauses; falls back to in-memory store when no native DB)
// ---------------------------------------------------------------------------

export async function findAgentRunsByListFilterPaged(
  filter: AgentRunListFilter,
  limit: number,
  offset: number,
): Promise<{ rows: StoreRecord[]; total: number }> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const all = findAgentRunsByListFilter(filter);
    const sorted = [...all].sort(
      (a, b) =>
        new Date(String(b.startedAt)).getTime() - new Date(String(a.startedAt)).getTime(),
    );
    return { rows: sorted.slice(offset, offset + limit), total: sorted.length };
  }

  const conditions = [];
  if (filter.status) conditions.push(eq(schema.agentRuns.status, filter.status));
  if (filter.agentId) conditions.push(eq(schema.agentRuns.agentId, filter.agentId));
  if (filter.triggerType) conditions.push(eq(schema.agentRuns.triggerType, filter.triggerType));
  if (filter.conversationId) {
    conditions.push(eq(schema.agentRuns.conversationId, filter.conversationId));
  }

  const where =
    conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

  const [totalRows, rows] = await Promise.all([
    db.select({ count: count() }).from(schema.agentRuns).where(where),
    db
      .select()
      .from(schema.agentRuns)
      .where(where)
      .orderBy(desc(schema.agentRuns.startedAt))
      .limit(limit)
      .offset(offset),
  ]);

  return { rows: recordsFromLegacyRows(rows), total: totalRows[0]?.count ?? 0 };
}

export async function findRunningAgentRunsAsync(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return findRunningAgentRuns();

  const rows = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.status, 'running'))
    .orderBy(desc(schema.agentRuns.startedAt));
  return recordsFromLegacyRows(rows);
}

export async function listChatQueueItemsWithStatusNative(status: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return listChatQueueItemsWithStatus(status);

  const rows = await db
    .select()
    .from(schema.agentChatQueue)
    .where(eq(schema.agentChatQueue.status, status))
    .orderBy(asc(schema.agentChatQueue.createdAt));
  return recordsFromLegacyRows(rows);
}

export async function findBatchRunItemsWithStatusNative(status: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return findBatchRunItemsWithStatus(status);

  const rows = await db
    .select()
    .from(schema.agentBatchRunItems)
    .where(eq(schema.agentBatchRunItems.status, status))
    .orderBy(asc(schema.agentBatchRunItems.order), asc(schema.agentBatchRunItems.createdAt));
  return recordsFromLegacyRows(rows);
}

export async function findBatchRunItemsQueuedOrProcessingNative(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return findBatchRunItemsQueuedOrProcessing();

  const rows = await db
    .select()
    .from(schema.agentBatchRunItems)
    .where(
      or(
        eq(schema.agentBatchRunItems.status, 'queued'),
        eq(schema.agentBatchRunItems.status, 'processing'),
      ),
    )
    .orderBy(asc(schema.agentBatchRunItems.runId), asc(schema.agentBatchRunItems.order));
  return recordsFromLegacyRows(rows);
}
