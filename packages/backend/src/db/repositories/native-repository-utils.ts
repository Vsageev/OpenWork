import { store } from '../connection.js';
import type { PostgresDatabase } from '../postgres.js';
import type { NativeQueryStore, StoreRecord } from '../store.js';

/**
 * When SqlStoreAdapter is the active store, returns a Drizzle handle backed by the same Postgres
 * connection (after awaiting pending writes via store.flush).
 *
 * Intentionally generic Store access (owner: platform / persistence):
 * - Store insert/update/delete remain the supported mutation path so the adapter cache and SQL
 *   persistence stay aligned.
 * - Store.getAll plus in-process filters are retained only where called out (e.g. backup export,
 *   audit log listing) or in tests that mock store without nativeDb.
 */

export function getNativeDb(): PostgresDatabase | null {
  const candidate = store as Partial<NativeQueryStore<PostgresDatabase>>;
  if (typeof candidate.nativeDb !== 'function') return null;

  try {
    return candidate.nativeDb();
  } catch {
    return null;
  }
}

export async function getFlushedNativeDb(): Promise<PostgresDatabase | null> {
  const db = getNativeDb();
  if (!db) return null;
  await store.flush();
  return db;
}

export function recordFromLegacyRow<T extends StoreRecord>(row: T): StoreRecord {
  const legacy = row.legacyData;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    return { ...(legacy as StoreRecord) };
  }
  return { ...row };
}

export function recordsFromLegacyRows<T extends StoreRecord>(rows: T[]): StoreRecord[] {
  return rows.map(recordFromLegacyRow);
}
