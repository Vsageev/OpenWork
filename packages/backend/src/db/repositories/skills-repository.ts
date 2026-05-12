import { sql } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow } from './native-repository-utils.js';

const COLLECTION = 'skills';

export async function findSkillRecordByNameLower(nameLower: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return (
      store.getAll(COLLECTION).find(
        (s) => typeof s.name === 'string' && s.name.toLowerCase() === nameLower,
      ) ?? null
    );
  }
  const rows = await db
    .select()
    .from(schema.skills)
    .where(sql`lower(${schema.skills.name}) = ${nameLower}`)
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export function listSkillRecords(): StoreRecord[] {
  return store.getAll(COLLECTION);
}

export function getSkillRecord(id: string): StoreRecord | null {
  return store.getById(COLLECTION, id);
}

export function insertSkillRecord(data: StoreRecord): StoreRecord {
  return store.insert(COLLECTION, data);
}

export function updateSkillRecord(id: string, data: StoreRecord): StoreRecord | null {
  return store.update(COLLECTION, id, data);
}

export function deleteSkillRecord(id: string): StoreRecord | null {
  return store.delete(COLLECTION, id);
}
