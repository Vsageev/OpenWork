import { eq } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow } from './native-repository-utils.js';

const COLLECTION = 'settings';

export async function getSetting(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById(COLLECTION, id);
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, id)).limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export function upsertSetting(record: StoreRecord): StoreRecord {
  const id = String(record.id ?? '');
  const existing = store.getById(COLLECTION, id);
  if (existing) {
    return store.update(COLLECTION, id, record) as StoreRecord;
  }
  return store.insert(COLLECTION, record);
}
