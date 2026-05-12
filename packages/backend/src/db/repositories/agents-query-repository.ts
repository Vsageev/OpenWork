import { asc, eq, max } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordsFromLegacyRows } from './native-repository-utils.js';

export async function listAgentGroupRecordsOrdered(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store
      .getAll('agentGroups')
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  }
  const rows = await db
    .select()
    .from(schema.agentGroups)
    .orderBy(asc(schema.agentGroups.order), asc(schema.agentGroups.name));
  return recordsFromLegacyRows(rows);
}

export async function maxAgentGroupOrder(): Promise<number> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const all = store.getAll('agentGroups');
    return all.reduce((m, r) => Math.max(m, typeof r.order === 'number' ? r.order : 0), -1);
  }
  const rows = await db.select({ max: max(schema.agentGroups.order) }).from(schema.agentGroups);
  const v = rows[0]?.max;
  return typeof v === 'number' ? v : -1;
}

export async function listAgentIdsWithGroupId(groupId: string): Promise<string[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store
      .getAll('agents')
      .filter((r) => r.groupId === groupId)
      .map((r) => String(r.id));
  }
  const rows = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.groupId, groupId));
  return rows.map((r) => r.id);
}

export async function listAgentRecordsOrdered(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getAll('agents');
  const rows = await db.select().from(schema.agents).orderBy(asc(schema.agents.name));
  return recordsFromLegacyRows(rows);
}

export async function listAgentRecordsByApiKeyId(apiKeyId: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll('agents').filter((r) => r.apiKeyId === apiKeyId);
  }
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.apiKeyId, apiKeyId))
    .orderBy(asc(schema.agents.name));
  return recordsFromLegacyRows(rows);
}

export async function listAllAgentRecordIds(): Promise<string[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll('agents').map((r) => String(r.id));
  }
  const rows = await db.select({ id: schema.agents.id }).from(schema.agents);
  return rows.map((r) => r.id);
}
