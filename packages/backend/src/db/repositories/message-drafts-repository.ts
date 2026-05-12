import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

const COLLECTION = 'messageDrafts';

export type ListMessageDraftsOptions = {
  conversationId?: string;
  limit: number;
  offset: number;
};

/** One draft per inbox conversation in current data model. */
export function findMessageDraftByConversationId(conversationId: string): StoreRecord | null {
  for (const row of store.getAll(COLLECTION)) {
    if (row.conversationId === conversationId) return row;
  }
  return null;
}

export async function findMessageDraftByConversationIdNative(
  conversationId: string,
): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return findMessageDraftByConversationId(conversationId);

  const [row] = await db
    .select()
    .from(schema.messageDrafts)
    .where(eq(schema.messageDrafts.conversationId, conversationId))
    .orderBy(desc(schema.messageDrafts.updatedAt), asc(schema.messageDrafts.id))
    .limit(1);
  return row ? recordFromLegacyRow(row) : null;
}

export async function listMessageDraftsNative(
  options: ListMessageDraftsOptions,
): Promise<{ entries: StoreRecord[]; total: number }> {
  const db = await getFlushedNativeDb();
  if (!db) {
    let all = store.getAll(COLLECTION).filter((draft) => {
      const conversationId = draft.conversationId;
      if (typeof conversationId !== 'string') return false;
      const conversation = store.getById('conversations', conversationId);
      if (!conversation || conversation.channelType === 'agent') return false;
      if (options.conversationId && conversationId !== options.conversationId) return false;
      return true;
    });
    all.sort(
      (a, b) =>
        new Date(String(b.updatedAt)).getTime() - new Date(String(a.updatedAt)).getTime(),
    );
    return {
      entries: all.slice(options.offset, options.offset + options.limit),
      total: all.length,
    };
  }

  const filters = [];
  if (options.conversationId) filters.push(eq(schema.messageDrafts.conversationId, options.conversationId));
  filters.push(ne(schema.conversations.channelType, 'agent'));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRows, rows] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.messageDrafts)
      .innerJoin(schema.conversations, eq(schema.messageDrafts.conversationId, schema.conversations.id))
      .where(where),
    db
      .select()
      .from(schema.messageDrafts)
      .innerJoin(schema.conversations, eq(schema.messageDrafts.conversationId, schema.conversations.id))
      .where(where)
      .orderBy(desc(schema.messageDrafts.updatedAt), asc(schema.messageDrafts.id))
      .limit(options.limit)
      .offset(options.offset),
  ]);

  return {
    entries: recordsFromLegacyRows(rows.map((row) => row.message_drafts)),
    total: totalRows[0]?.count ?? 0,
  };
}

export function deleteAllMessageDraftsForConversation(conversationId: string): void {
  const ids = store
    .getAll(COLLECTION)
    .filter((r) => r.conversationId === conversationId)
    .map((r) => String(r.id));
  for (const id of ids) {
    store.delete(COLLECTION, id);
  }
}

export async function deleteAllMessageDraftsForConversationNative(
  conversationId: string,
): Promise<void> {
  const db = await getFlushedNativeDb();
  if (!db) {
    deleteAllMessageDraftsForConversation(conversationId);
    return;
  }

  await db.delete(schema.messageDrafts).where(eq(schema.messageDrafts.conversationId, conversationId));
  await store.reload();
}
