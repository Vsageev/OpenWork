import { asc, eq } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

export async function listConnectorRecords(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getAll('connectors');
  const rows = await db.select().from(schema.connectors).orderBy(asc(schema.connectors.name));
  return recordsFromLegacyRows(rows);
}

export async function getConnectorRecordById(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById('connectors', id);
  const rows = await db.select().from(schema.connectors).where(eq(schema.connectors.id, id)).limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}
