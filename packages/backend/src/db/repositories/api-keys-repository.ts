import { and, desc, eq } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

const COLLECTION = 'apiKeys';

export async function listApiKeyRecords(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getAll(COLLECTION);
  const rows = await db.select().from(schema.apiKeys).orderBy(desc(schema.apiKeys.createdAt));
  return recordsFromLegacyRows(rows);
}

export async function getApiKeyRecord(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById(COLLECTION, id);
  const rows = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

/** Lookup by SHA-256 hash of the raw key (indexed column). */
export async function findActiveApiKeyByKeyHash(keyHash: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) {
    for (const row of store.getAll(COLLECTION)) {
      if (row.keyHash === keyHash && row.isActive === true) return row;
    }
    return null;
  }
  const rows = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.keyHash, keyHash), eq(schema.apiKeys.isActive, true)))
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export async function filterApiKeysByCreatedById(createdById: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll(COLLECTION).filter((r) => r.createdById === createdById);
  }
  const rows = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.createdById, createdById))
    .orderBy(desc(schema.apiKeys.createdAt));
  return recordsFromLegacyRows(rows);
}

export function insertApiKeyRecord(data: StoreRecord): StoreRecord {
  return store.insert(COLLECTION, data);
}

export function updateApiKeyRecord(id: string, data: StoreRecord): StoreRecord | null {
  return store.update(COLLECTION, id, data);
}

export function deleteApiKeyRecord(id: string): StoreRecord | null {
  return store.delete(COLLECTION, id);
}
