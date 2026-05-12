import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

const COLLECTION = 'messages';

export function compareMessagesChronologically(a: StoreRecord, b: StoreRecord): number {
  const createdAtDelta =
    new Date(String(a.createdAt)).getTime() - new Date(String(b.createdAt)).getTime();
  if (createdAtDelta !== 0) return createdAtDelta;
  return String(a.id).localeCompare(String(b.id));
}

export type ListMessagesByConversationOptions = {
  order: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Applied after matching `conversationId`. */
  where?: (row: StoreRecord) => boolean;
};

export type ListMessagesByConversationNativeOptions = {
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
};

/**
 * List messages for a single conversation with stable ordering (createdAt, then id).
 */
export function listMessagesByConversationId(
  conversationId: string,
  options: ListMessagesByConversationOptions = { order: 'desc' },
): StoreRecord[] {
  const order = options.order ?? 'desc';
  const offset = options.offset ?? 0;
  const limit = options.limit;
  const where = options.where;

  let matches = store.getAll(COLLECTION).filter((row) => row.conversationId === conversationId);
  if (where) {
    matches = matches.filter(where);
  }

  const sorted = matches.sort((a, b) => {
    const cmp = compareMessagesChronologically(a, b);
    return order === 'asc' ? cmp : -cmp;
  });

  if (limit === undefined) return sorted;
  return sorted.slice(offset, offset + limit);
}

export async function listMessagesByConversationIdNative(
  conversationId: string,
  options: ListMessagesByConversationNativeOptions,
): Promise<{ entries: StoreRecord[]; total: number }> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const rows = listMessagesByConversationId(conversationId, {
      order: options.order ?? 'desc',
      limit: options.limit,
      offset: options.offset,
    });
    const total = listMessagesByConversationId(conversationId, {
      order: options.order ?? 'desc',
    }).length;
    return { entries: rows, total };
  }

  const where = eq(schema.messages.conversationId, conversationId);
  const orderBy =
    options.order === 'asc'
      ? [asc(schema.messages.createdAt), asc(schema.messages.id)]
      : [desc(schema.messages.createdAt), desc(schema.messages.id)];
  const [totalRows, rows] = await Promise.all([
    db.select({ count: count() }).from(schema.messages).where(where),
    db
      .select()
      .from(schema.messages)
      .where(where)
      .orderBy(...orderBy)
      .limit(options.limit)
      .offset(options.offset),
  ]);

  return { entries: recordsFromLegacyRows(rows), total: totalRows[0]?.count ?? 0 };
}

/** Latest non-system message for previews (conversation list, etc.). */
export function getLatestNonSystemMessageForConversation(conversationId: string): StoreRecord | null {
  const rows = listMessagesByConversationId(conversationId, {
    order: 'desc',
    limit: 1,
    where: (row) => row.type !== 'system',
  });
  return rows[0] ?? null;
}

export async function getLatestNonSystemMessageForConversationNative(
  conversationId: string,
): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return getLatestNonSystemMessageForConversation(conversationId);

  const [row] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), ne(schema.messages.type, 'system')))
    .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
    .limit(1);
  return row ? recordFromLegacyRow(row) : null;
}

export function deleteAllMessagesForConversation(conversationId: string): void {
  const ids = store
    .getAll(COLLECTION)
    .filter((r) => r.conversationId === conversationId)
    .map((r) => String(r.id));
  for (const id of ids) {
    store.delete(COLLECTION, id);
  }
}

export async function deleteAllMessagesForConversationNative(conversationId: string): Promise<void> {
  const db = await getFlushedNativeDb();
  if (!db) {
    deleteAllMessagesForConversation(conversationId);
    return;
  }

  await db.delete(schema.messages).where(eq(schema.messages.conversationId, conversationId));
  await store.reload();
}
