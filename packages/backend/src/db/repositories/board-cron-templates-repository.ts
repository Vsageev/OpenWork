import { asc, eq, isNotNull } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

const COLLECTION = 'boardCronTemplates';

export async function listBoardCronTemplatesForBoard(boardId: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store.getAll(COLLECTION).filter((r) => r.boardId === boardId);
  }
  const rows = await db
    .select()
    .from(schema.boardCronTemplates)
    .where(eq(schema.boardCronTemplates.boardId, boardId))
    .orderBy(asc(schema.boardCronTemplates.id));
  return recordsFromLegacyRows(rows);
}

export async function getBoardCronTemplateRecordById(id: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getById(COLLECTION, id);
  const rows = await db
    .select()
    .from(schema.boardCronTemplates)
    .where(eq(schema.boardCronTemplates.id, id))
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

export async function listDistinctBoardIdsFromCronTemplates(): Promise<string[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    const boardIds = new Set<string>();
    for (const t of store.getAll(COLLECTION) as StoreRecord[]) {
      if (typeof t.boardId === 'string') boardIds.add(t.boardId);
    }
    return [...boardIds];
  }
  const rows = await db
    .selectDistinct({ boardId: schema.boardCronTemplates.boardId })
    .from(schema.boardCronTemplates)
    .where(isNotNull(schema.boardCronTemplates.boardId));
  return rows.map((r) => String(r.boardId)).filter(Boolean);
}
