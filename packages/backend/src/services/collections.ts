import { store } from '../db/index.js';
import { createAuditLog } from './audit-log.js';

const GENERAL_COLLECTION_NAMES = new Set(['general']);

function normalizeName(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

let generalCollectionLock: Promise<void> = Promise.resolve();

async function runWithGeneralCollectionLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = generalCollectionLock;
  let release: (() => void) | undefined;
  generalCollectionLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

export function isGeneralCollection(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;

  const candidate = record as { isGeneral?: unknown; name?: unknown };
  if (candidate.isGeneral === true) return true;

  return GENERAL_COLLECTION_NAMES.has(normalizeName(candidate.name));
}

export async function countGeneralCollections(): Promise<number> {
  const all = store.getAll('collections') as any[];
  return all.filter((collection) => isGeneralCollection(collection)).length;
}

function parseCreatedAt(value: unknown): number {
  if (typeof value !== 'string') return Number.POSITIVE_INFINITY;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
}

function dedupeStringList(items: unknown[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const item of items) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }

  return deduped;
}

async function insertCollection(
  data: CreateCollectionData,
  isGeneral: boolean,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const collection = store.insert('collections', {
    name: data.name,
    description: data.description ?? null,
    isGeneral,
    createdById: audit?.userId,
  }) as any;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'collection',
      entityId: collection.id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return collection;
}

async function persistCollectionUpdate(
  id: string,
  setData: Record<string, unknown>,
  data: UpdateCollectionData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const updated = store.update('collections', id, setData);
  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'collection',
      entityId: id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return updated;
}

export async function consolidateGeneralCollections() {
  const all = store.getAll('collections') as any[];
  const generals = all.filter((collection) => isGeneralCollection(collection));
  if (generals.length === 0) return null;

  generals.sort((a, b) => {
    const createdDiff = parseCreatedAt(a.createdAt) - parseCreatedAt(b.createdAt);
    if (createdDiff !== 0) return createdDiff;

    return String(a.id).localeCompare(String(b.id));
  });

  const canonical = generals[0];
  const canonicalId = canonical.id as string;
  if (!canonicalId) return null;

  if (canonical.isGeneral !== true) {
    store.update('collections', canonicalId, { isGeneral: true });
  }

  const duplicateIds = generals
    .slice(1)
    .map((collection) => collection.id)
    .filter((id): id is string => typeof id === 'string' && id !== canonicalId);

  if (duplicateIds.length === 0) {
    return (store.getById('collections', canonicalId) as any) ?? canonical;
  }

  const duplicateIdSet = new Set(duplicateIds);

  const cards = store.find(
    'cards',
    (card: any) =>
      typeof card.collectionId === 'string' && duplicateIdSet.has(card.collectionId),
  ) as any[];
  for (const card of cards) {
    if (typeof card.id !== 'string') continue;
    store.update('cards', card.id, { collectionId: canonicalId });
  }

  const boards = store.find(
    'boards',
    (board: any) =>
      (typeof board.collectionId === 'string' && duplicateIdSet.has(board.collectionId)) ||
      (typeof board.defaultCollectionId === 'string' &&
        duplicateIdSet.has(board.defaultCollectionId)),
  ) as any[];
  for (const board of boards) {
    if (typeof board.id !== 'string') continue;

    const setData: Record<string, unknown> = {};
    if (typeof board.collectionId === 'string' && duplicateIdSet.has(board.collectionId)) {
      setData.collectionId = canonicalId;
    }
    if (
      typeof board.defaultCollectionId === 'string' &&
      duplicateIdSet.has(board.defaultCollectionId)
    ) {
      setData.defaultCollectionId = canonicalId;
    }

    if (Object.keys(setData).length > 0) {
      store.update('boards', board.id, setData);
    }
  }

  const workspaces = store.find(
    'workspaces',
    (workspace: any) =>
      Array.isArray(workspace.collectionIds) &&
      workspace.collectionIds.some(
        (collectionId: unknown) =>
          typeof collectionId === 'string' && duplicateIdSet.has(collectionId),
      ),
  ) as any[];
  for (const workspace of workspaces) {
    if (typeof workspace.id !== 'string') continue;

    const currentIds = Array.isArray(workspace.collectionIds) ? workspace.collectionIds : [];
    const nextIds = dedupeStringList(
      currentIds.map((collectionId: unknown) =>
        typeof collectionId === 'string' && duplicateIdSet.has(collectionId)
          ? canonicalId
          : collectionId,
      ),
    );

    store.update('workspaces', workspace.id, { collectionIds: nextIds });
  }

  for (const duplicateId of duplicateIds) {
    store.delete('collections', duplicateId);
  }

  return (store.getById('collections', canonicalId) as any) ?? canonical;
}

export interface CollectionListQuery {
  ids?: string[];
  search?: string;
  limit?: number;
  offset?: number;
  withCardCounts?: boolean;
}

export interface CreateCollectionData {
  name: string;
  description?: string | null;
}

export interface AgentBatchCardFilters {
  search?: string;
  assigneeId?: string;
  completed?: boolean;
  priority?: 'high' | 'medium' | 'low';
  tagId?: string;
}

export interface AgentBatchConfig {
  agentId?: string | null;
  prompt?: string | null;
  maxParallel?: number;
  cardFilters?: AgentBatchCardFilters;
}

export interface UpdateCollectionData {
  name?: string;
  description?: string | null;
  agentBatchConfig?: AgentBatchConfig | null;
}

export async function listCollections(query: CollectionListQuery) {
  await runWithGeneralCollectionLock(() => consolidateGeneralCollections());

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  let all = store.getAll('collections') as any[];

  if (query.ids) {
    const idSet = new Set(query.ids);
    all = all.filter((f: any) => idSet.has(f.id));
  }

  if (query.search) {
    const term = query.search.toLowerCase();
    all = all.filter(
      (f: any) =>
        f.name?.toLowerCase().includes(term) ||
        f.description?.toLowerCase().includes(term),
    );
  }

  all.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const total = all.length;
  const entries = all.slice(offset, offset + limit);

  if (query.withCardCounts) {
    const allCards = store.getAll('cards') as any[];
    const countByCollection = new Map<string, number>();
    const completedByCollection = new Map<string, number>();
    const overdueByCollection = new Map<string, number>();
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (const card of allCards) {
      if (typeof card.collectionId === 'string') {
        countByCollection.set(card.collectionId, (countByCollection.get(card.collectionId) ?? 0) + 1);
        if (card.customFields?.completed === true) {
          completedByCollection.set(card.collectionId, (completedByCollection.get(card.collectionId) ?? 0) + 1);
        }
        const dueDate = card.customFields?.dueDate as string | undefined;
        if (dueDate && card.customFields?.completed !== true) {
          const due = new Date(dueDate);
          if (due < now) {
            overdueByCollection.set(card.collectionId, (overdueByCollection.get(card.collectionId) ?? 0) + 1);
          }
        }
      }
    }
    const entriesWithCounts = entries.map((c: any) => ({
      ...c,
      cardCount: countByCollection.get(c.id) ?? 0,
      completedCardCount: completedByCollection.get(c.id) ?? 0,
      overdueCardCount: overdueByCollection.get(c.id) ?? 0,
    }));
    return { entries: entriesWithCounts, total };
  }

  return { entries, total };
}

export async function getCollectionById(id: string) {
  return store.getById('collections', id) ?? null;
}

export async function createCollection(
  data: CreateCollectionData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const isGeneral = GENERAL_COLLECTION_NAMES.has(normalizeName(data.name));

  if (!isGeneral) {
    return insertCollection(data, false, audit);
  }

  // Serialize "General" creation/check to avoid duplicate inserts under concurrent requests.
  return runWithGeneralCollectionLock(async () => {
    const existingGeneral = await consolidateGeneralCollections();
    if (existingGeneral) return existingGeneral;

    return insertCollection(data, true, audit);
  });
}

export async function updateCollection(
  id: string,
  data: UpdateCollectionData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const existing = store.getById('collections', id) as any;
  if (!existing) return null;

  const setData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setData[key] = value;
    }
  }

  const nextIsGeneral =
    data.name === undefined
      ? isGeneralCollection(existing)
      : GENERAL_COLLECTION_NAMES.has(normalizeName(data.name));
  setData.isGeneral = nextIsGeneral;

  if (nextIsGeneral) {
    return runWithGeneralCollectionLock(async () => {
      const current = store.getById('collections', id) as any;
      if (!current) return null;

      const currentSetData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          currentSetData[key] = value;
        }
      }

      const currentNextIsGeneral =
        data.name === undefined
          ? isGeneralCollection(current)
          : GENERAL_COLLECTION_NAMES.has(normalizeName(data.name));
      currentSetData.isGeneral = currentNextIsGeneral;

      if (currentNextIsGeneral) {
        const canonicalGeneral = await consolidateGeneralCollections();
        if (canonicalGeneral && canonicalGeneral.id !== id) {
          return canonicalGeneral;
        }
      }

      currentSetData.updatedAt = new Date().toISOString();
      return persistCollectionUpdate(id, currentSetData, data, audit);
    });
  }

  setData.updatedAt = new Date().toISOString();
  return persistCollectionUpdate(id, setData, data, audit);
}

export async function getOrCreateGeneralCollection(
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  return runWithGeneralCollectionLock(async () => {
    const general = await consolidateGeneralCollections();
    if (general) return general;

    return insertCollection({ name: 'General' }, true, audit);
  });
}

export async function deleteCollection(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const deleted = store.delete('collections', id);

  if (deleted && audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'collection',
      entityId: id,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return deleted ?? null;
}
