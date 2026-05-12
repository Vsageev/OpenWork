import { and, asc, count, desc, eq, ilike, ne } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordsFromLegacyRows } from './native-repository-utils.js';

export type ListConversationsOptions = {
  contactId?: string;
  assigneeId?: string;
  channelType?: string;
  status?: string;
  isUnread?: boolean;
  search?: string;
  limit: number;
  offset: number;
};

export async function listConversationsNative(
  options: ListConversationsOptions,
  isAgentConversationRecord: (conversation: Record<string, unknown>) => boolean,
): Promise<{ entries: StoreRecord[]; total: number }> {
  const db = await getFlushedNativeDb();
  if (!db) {
    let all = store
      .getAll('conversations')
      .filter((row) => !isAgentConversationRecord(row));
    if (options.contactId) all = all.filter((row) => row.contactId === options.contactId);
    if (options.assigneeId) all = all.filter((row) => row.assigneeId === options.assigneeId);
    if (options.channelType) all = all.filter((row) => row.channelType === options.channelType);
    if (options.status) all = all.filter((row) => row.status === options.status);
    if (options.isUnread !== undefined) {
      all = all.filter((row) => row.isUnread === options.isUnread);
    }
    if (options.search) {
      const needle = options.search.toLowerCase();
      all = all.filter((row) => {
        const subject = typeof row.subject === 'string' ? row.subject.toLowerCase() : '';
        if (subject.includes(needle)) return true;
        const contact = row.contactId ? store.getById('contacts', String(row.contactId)) : null;
        const fullName = contact
          ? [contact.firstName, contact.lastName].filter(Boolean).join(' ').toLowerCase()
          : '';
        return fullName.includes(needle);
      });
    }
    all.sort((a, b) => {
      const aLast = new Date(String(a.lastMessageAt)).getTime() || 0;
      const bLast = new Date(String(b.lastMessageAt)).getTime() || 0;
      if (bLast !== aLast) return bLast - aLast;
      return new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime();
    });
    return {
      entries: options.limit === 0 ? [] : all.slice(options.offset, options.offset + options.limit),
      total: all.length,
    };
  }

  const filters = [ne(schema.conversations.channelType, 'agent')];
  if (options.contactId) filters.push(eq(schema.conversations.contactId, options.contactId));
  if (options.assigneeId) filters.push(eq(schema.conversations.assigneeId, options.assigneeId));
  if (options.channelType) filters.push(eq(schema.conversations.channelType, options.channelType));
  if (options.status) filters.push(eq(schema.conversations.status, options.status));
  if (options.isUnread !== undefined) filters.push(eq(schema.conversations.isUnread, options.isUnread));
  if (options.search) {
    const pattern = `%${options.search}%`;
    filters.push(ilike(schema.conversations.subject, pattern));
  }
  const where = and(...filters);

  const totalQuery = db
    .select({ count: count() })
    .from(schema.conversations)
    .where(where);

  const rowsQuery = db
    .select()
    .from(schema.conversations)
    .where(where)
    .orderBy(
      desc(schema.conversations.lastMessageAt),
      desc(schema.conversations.createdAt),
      asc(schema.conversations.id),
    )
    .limit(options.limit)
    .offset(options.offset);

  const [totalRows, rows] = await Promise.all([totalQuery, options.limit === 0 ? [] : rowsQuery]);

  return {
    entries: recordsFromLegacyRows(rows),
    total: totalRows[0]?.count ?? 0,
  };
}

export async function markAllConversationsReadNative(): Promise<number> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const unread = store
      .getAll('conversations')
      .filter((row) => row.isUnread === true && row.channelType !== 'agent');
    for (const conversation of unread) {
      store.update('conversations', String(conversation.id), { isUnread: false });
    }
    return unread.length;
  }

  const rows = await db
    .update(schema.conversations)
    .set({ isUnread: false, updatedAt: new Date() })
    .where(and(eq(schema.conversations.isUnread, true), ne(schema.conversations.channelType, 'agent')))
    .returning({ id: schema.conversations.id });
  await store.reload();
  return rows.length;
}
