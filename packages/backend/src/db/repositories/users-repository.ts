import { and, asc, count, eq, sql } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

/** Case-insensitive email lookup for auth (reads from Postgres when available). */
export async function findUserByEmailLower(emailLower: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return (
      store.getAll('users').find((u) => typeof u.email === 'string' && u.email.toLowerCase() === emailLower) ??
      null
    );
  }
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${emailLower}`)
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export async function getUserRecordById(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById('users', id);
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export type ListUsersDirectoryOptions = {
  includeAgents: boolean;
  limit: number;
  offset: number;
};

export async function listUsersDirectory(
  options: ListUsersDirectoryOptions,
): Promise<{ entries: StoreRecord[]; total: number }> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const all = store.getAll('users').filter(
      (u) => u.isActive !== false && (options.includeAgents || u.type !== 'agent'),
    );
    const total = all.length;
    const entries = all.slice(options.offset, options.offset + options.limit);
    return { entries, total };
  }

  const active = eq(schema.users.isActive, true);
  const notAgent = sql`${schema.users.type} is distinct from 'agent'`;
  const where = options.includeAgents ? active : and(active, notAgent);

  const [totalRows, rows] = await Promise.all([
    db.select({ count: count() }).from(schema.users).where(where),
    db
      .select()
      .from(schema.users)
      .where(where)
      .orderBy(asc(schema.users.createdAt))
      .limit(options.limit)
      .offset(options.offset),
  ]);

  return { entries: recordsFromLegacyRows(rows), total: totalRows[0]?.count ?? 0 };
}
