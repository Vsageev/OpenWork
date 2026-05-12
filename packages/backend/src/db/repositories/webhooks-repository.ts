import { and, asc, count, desc, eq, ilike, sql } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

export type WebhookListQuery = {
  isActive?: boolean;
  search?: string;
  limit: number;
  offset: number;
};

export async function listWebhooksNative(query: WebhookListQuery): Promise<{
  entries: StoreRecord[];
  total: number;
}> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const predicate = (r: StoreRecord) => {
      if (query.isActive !== undefined && r.isActive !== query.isActive) return false;
      if (
        query.search &&
        !(String(r.url ?? '').toLowerCase().includes(query.search.toLowerCase()))
      )
        return false;
      return true;
    };
    const all = store.getAll('webhooks').filter(predicate);
    all.sort(
      (a, b) =>
        new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime(),
    );
    return { entries: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }

  const conditions = [];
  if (query.isActive !== undefined) {
    conditions.push(eq(schema.webhooks.isActive, query.isActive));
  }
  if (query.search?.trim()) {
    conditions.push(ilike(schema.webhooks.url, `%${query.search.trim()}%`));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRows, rows] = await Promise.all([
    db.select({ count: count() }).from(schema.webhooks).where(whereClause),
    db
      .select()
      .from(schema.webhooks)
      .where(whereClause)
      .orderBy(desc(schema.webhooks.createdAt))
      .limit(query.limit)
      .offset(query.offset),
  ]);

  return { entries: recordsFromLegacyRows(rows), total: totalRows[0]?.count ?? 0 };
}

export async function getWebhookRecordById(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById('webhooks', id);
  const rows = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id)).limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

/** Active webhooks that subscribe to `event` or to the wildcard `*`. */
export async function listActiveWebhooksForEvent(event: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const all = store.getAll('webhooks').filter((r) => r.isActive === true);
    return all.filter((w) => {
      const events = w.events as string[];
      return events.includes(event) || events.includes('*');
    });
  }

  const eventMatch = sql`(${schema.webhooks.events}::jsonb @> ${JSON.stringify([event])}::jsonb or ${schema.webhooks.events}::jsonb @> ${JSON.stringify(['*'])}::jsonb)`;

  const rows = await db
    .select()
    .from(schema.webhooks)
    .where(and(eq(schema.webhooks.isActive, true), eventMatch))
    .orderBy(asc(schema.webhooks.createdAt));

  return recordsFromLegacyRows(rows);
}

export type WebhookDeliveryListQuery = {
  webhookId?: string;
  event?: string;
  status?: string;
  limit: number;
  offset: number;
};

export async function listWebhookDeliveriesNative(
  query: WebhookDeliveryListQuery,
): Promise<{ entries: StoreRecord[]; total: number }> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const predicate = (r: StoreRecord) => {
      if (query.webhookId && r.webhookId !== query.webhookId) return false;
      if (query.event && r.event !== query.event) return false;
      if (query.status && r.status !== query.status) return false;
      return true;
    };
    const all = store.getAll('webhookDeliveries').filter(predicate);
    all.sort(
      (a, b) =>
        new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime(),
    );
    return { entries: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }

  const conditions = [];
  if (query.webhookId) conditions.push(eq(schema.webhookDeliveries.webhookId, query.webhookId));
  if (query.event) conditions.push(eq(schema.webhookDeliveries.event, query.event));
  if (query.status) conditions.push(eq(schema.webhookDeliveries.status, query.status));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRows, rows] = await Promise.all([
    db.select({ count: count() }).from(schema.webhookDeliveries).where(whereClause),
    db
      .select()
      .from(schema.webhookDeliveries)
      .where(whereClause)
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(query.limit)
      .offset(query.offset),
  ]);

  return { entries: recordsFromLegacyRows(rows), total: totalRows[0]?.count ?? 0 };
}

export async function getWebhookDeliveryRecordById(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById('webhookDeliveries', id);
  const rows = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, id))
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}
