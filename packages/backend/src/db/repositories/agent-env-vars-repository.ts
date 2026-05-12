import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

const COLLECTION = 'agentEnvVars';

function normalizeEnvVarKey(value: string): string {
  return value.trim().toUpperCase();
}

export async function listAgentEnvVarRecordsForAgent(agentId: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll(COLLECTION).filter((record) => record.agentId === agentId);
  }
  const rows = await db
    .select()
    .from(schema.agentEnvVars)
    .where(eq(schema.agentEnvVars.agentId, agentId))
    .orderBy(desc(schema.agentEnvVars.isActive), asc(schema.agentEnvVars.key));
  return recordsFromLegacyRows(rows);
}

export async function getAgentEnvVarRecordById(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById(COLLECTION, id);
  const rows = await db
    .select()
    .from(schema.agentEnvVars)
    .where(eq(schema.agentEnvVars.id, id))
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export async function findAgentEnvVarIdByAgentAndKey(
  agentId: string,
  keyUpper: string,
  excludeId?: string,
): Promise<string | null> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const existing = store.getAll(COLLECTION).filter((record) => {
      if (record.agentId !== agentId) return false;
      if (excludeId && record.id === excludeId) return false;
      return normalizeEnvVarKey(String(record.key ?? '')) === keyUpper;
    });
    return existing[0] ? String(existing[0].id) : null;
  }

  const keyMatch = sql`upper(${schema.agentEnvVars.key}) = ${keyUpper}`;
  const where =
    excludeId !== undefined
      ? and(eq(schema.agentEnvVars.agentId, agentId), keyMatch, ne(schema.agentEnvVars.id, excludeId))
      : and(eq(schema.agentEnvVars.agentId, agentId), keyMatch);

  const rows = await db.select({ id: schema.agentEnvVars.id }).from(schema.agentEnvVars).where(where).limit(1);
  return rows[0]?.id ?? null;
}

export async function listActiveAgentEnvVarIdsForAgent(agentId: string): Promise<string[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store
      .getAll(COLLECTION)
      .filter((record) => record.agentId === agentId && record.isActive !== false)
      .map((r) => String(r.id));
  }
  const rows = await db
    .select({ id: schema.agentEnvVars.id })
    .from(schema.agentEnvVars)
    .where(and(eq(schema.agentEnvVars.agentId, agentId), eq(schema.agentEnvVars.isActive, true)));
  return rows.map((r) => r.id);
}

/** Returns row ids for `store.delete` so the SQL adapter cache stays consistent. */
export async function listAgentEnvVarIdsForAgent(agentId: string): Promise<string[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll(COLLECTION).filter((r) => r.agentId === agentId).map((r) => String(r.id));
  }
  const rows = await db
    .select({ id: schema.agentEnvVars.id })
    .from(schema.agentEnvVars)
    .where(eq(schema.agentEnvVars.agentId, agentId));
  return rows.map((r) => r.id);
}
