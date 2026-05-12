import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

/** `ngrokAuto` is stored inside `legacy_data` JSON (not a first-class column). */
function legacyNgrokAutoTrue() {
  return sql`(${schema.telegramBots.legacyData}::jsonb ->> 'ngrokAuto') = 'true'`;
}

export async function findFirstActiveTelegramBot(): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll('telegramBots').find((b) => b.status === 'active') ?? null;
  }
  const rows = await db
    .select()
    .from(schema.telegramBots)
    .where(eq(schema.telegramBots.status, 'active'))
    .orderBy(asc(schema.telegramBots.createdAt))
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export async function getTelegramBotRecordById(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById('telegramBots', id);
  const rows = await db
    .select()
    .from(schema.telegramBots)
    .where(eq(schema.telegramBots.id, id))
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export async function findTelegramBotByBotId(botId: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll('telegramBots').find((r) => r.botId === botId) ?? null;
  }
  const rows = await db
    .select()
    .from(schema.telegramBots)
    .where(eq(schema.telegramBots.botId, botId))
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export async function listAllTelegramBotRecords(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getAll('telegramBots');
  const rows = await db.select().from(schema.telegramBots).orderBy(asc(schema.telegramBots.createdAt));
  return recordsFromLegacyRows(rows);
}

export async function listTelegramBotsWithNgrokAutoFlag(): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll('telegramBots').filter((r) => r.ngrokAuto === true);
  }
  const rows = await db
    .select()
    .from(schema.telegramBots)
    .where(legacyNgrokAutoTrue())
    .orderBy(asc(schema.telegramBots.createdAt));
  return recordsFromLegacyRows(rows);
}

export async function countOtherTelegramBotsWithNgrokAutoFlag(excludeId: string): Promise<number> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store
      .getAll('telegramBots')
      .filter((r) => r.id !== excludeId && r.ngrokAuto === true).length;
  }
  const rows = await db
    .select({ count: count() })
    .from(schema.telegramBots)
    .where(and(ne(schema.telegramBots.id, excludeId), legacyNgrokAutoTrue()));
  return rows[0]?.count ?? 0;
}
