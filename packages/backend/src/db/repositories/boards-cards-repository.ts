import { and, asc, count, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordsFromLegacyRows, recordFromLegacyRow } from './native-repository-utils.js';

const BOARD_COLUMNS = 'boardColumns';
const BOARD_CARDS = 'boardCards';
const CARD_TAGS = 'cardTags';
const CARD_LINKS = 'cardLinks';
const CARD_COMMENTS = 'cardComments';
const CARDS = 'cards';
const BOARDS = 'boards';
const WORKSPACES = 'workspaces';

export type ListBoardsOptions = {
  ids?: string[];
  collectionId?: string;
  search?: string;
  limit: number;
  offset: number;
};

export type ListCardsOptions = {
  collectionId?: string;
  assigneeId?: string;
  search?: string;
  tagId?: string;
  limit: number;
  offset: number;
};

/** Composite primary key for cardTags in SQL. */
export function cardTagStoreKey(record: StoreRecord): string {
  return `${String(record.cardId)}:${String(record.tagId)}`;
}

export function listBoardColumnsByBoardId(boardId: string): StoreRecord[] {
  return store.getAll(BOARD_COLUMNS).filter((r) => r.boardId === boardId);
}

export async function listBoardColumnsByBoardIdNative(boardId: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return listBoardColumnsByBoardId(boardId);

  const rows = await db
    .select()
    .from(schema.boardColumns)
    .where(eq(schema.boardColumns.boardId, boardId))
    .orderBy(asc(schema.boardColumns.position), asc(schema.boardColumns.id));
  return recordsFromLegacyRows(rows);
}

export function listBoardCardsByBoardId(boardId: string): StoreRecord[] {
  return store.getAll(BOARD_CARDS).filter((r) => r.boardId === boardId);
}

export async function listBoardCardsByBoardIdNative(boardId: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return listBoardCardsByBoardId(boardId);

  const rows = await db
    .select()
    .from(schema.boardCards)
    .where(eq(schema.boardCards.boardId, boardId))
    .orderBy(asc(schema.boardCards.position), asc(schema.boardCards.id));
  return recordsFromLegacyRows(rows);
}

export function listBoardCardsByBoardAndColumn(boardId: string, columnId: string): StoreRecord[] {
  return store
    .getAll(BOARD_CARDS)
    .filter((r) => r.boardId === boardId && r.columnId === columnId);
}

export async function countBoardCardsByBoardAndColumnNative(
  boardId: string,
  columnId: string,
): Promise<number> {
  const db = await getFlushedNativeDb();
  if (!db) return listBoardCardsByBoardAndColumn(boardId, columnId).length;

  const [row] = await db
    .select({ count: count() })
    .from(schema.boardCards)
    .where(and(eq(schema.boardCards.boardId, boardId), eq(schema.boardCards.columnId, columnId)));
  return row?.count ?? 0;
}

export function getBoardCardByBoardAndCard(
  boardId: string,
  cardId: string,
): StoreRecord | null {
  for (const r of store.getAll(BOARD_CARDS)) {
    if (r.boardId === boardId && r.cardId === cardId) return r;
  }
  return null;
}

export async function getBoardCardByBoardAndCardNative(
  boardId: string,
  cardId: string,
): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) return getBoardCardByBoardAndCard(boardId, cardId);

  const [row] = await db
    .select()
    .from(schema.boardCards)
    .where(and(eq(schema.boardCards.boardId, boardId), eq(schema.boardCards.cardId, cardId)))
    .limit(1);
  return row ? recordFromLegacyRow(row) : null;
}

export function listBoardCardsByCardId(cardId: string): StoreRecord[] {
  return store.getAll(BOARD_CARDS).filter((r) => r.cardId === cardId);
}

export function deleteBoardCardsByCardId(cardId: string): void {
  for (const r of listBoardCardsByCardId(cardId)) {
    if (typeof r.id === 'string') store.delete(BOARD_CARDS, r.id);
  }
}

export function deleteBoardColumnsByBoardId(boardId: string): void {
  for (const r of listBoardColumnsByBoardId(boardId)) {
    if (typeof r.id === 'string') store.delete(BOARD_COLUMNS, r.id);
  }
}

export function deleteBoardCardsByBoardId(boardId: string): StoreRecord[] {
  const removed: StoreRecord[] = [];
  for (const r of listBoardCardsByBoardId(boardId)) {
    if (typeof r.id === 'string') {
      const del = store.delete(BOARD_CARDS, r.id);
      if (del) removed.push(del);
    }
  }
  return removed;
}

export async function deleteBoardCardsByBoardIdNative(boardId: string): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) return deleteBoardCardsByBoardId(boardId);

  const removed = await db
    .delete(schema.boardCards)
    .where(eq(schema.boardCards.boardId, boardId))
    .returning();
  return recordsFromLegacyRows(removed);
}

export function deleteBoardCardsByColumnId(columnId: string): void {
  for (const r of store.getAll(BOARD_CARDS)) {
    if (r.columnId === columnId && typeof r.id === 'string') store.delete(BOARD_CARDS, r.id);
  }
}

export function deleteBoardCardByBoardAndCard(boardId: string, cardId: string): void {
  const bc = getBoardCardByBoardAndCard(boardId, cardId);
  if (bc && typeof bc.id === 'string') store.delete(BOARD_CARDS, bc.id);
}

export function listCardTagsByCardId(cardId: string): StoreRecord[] {
  return store.getAll(CARD_TAGS).filter((r) => r.cardId === cardId);
}

export function listCardTagsByTagId(tagId: string): StoreRecord[] {
  return store.getAll(CARD_TAGS).filter((r) => r.tagId === tagId);
}

export function findCardTag(cardId: string, tagId: string): StoreRecord | null {
  for (const r of store.getAll(CARD_TAGS)) {
    if (r.cardId === cardId && r.tagId === tagId) return r;
  }
  return null;
}

export function deleteCardTagsByCardId(cardId: string): void {
  for (const r of listCardTagsByCardId(cardId)) {
    store.delete(CARD_TAGS, cardTagStoreKey(r));
  }
}

export function deleteCardTagPair(cardId: string, tagId: string): void {
  const r = findCardTag(cardId, tagId);
  if (r) store.delete(CARD_TAGS, cardTagStoreKey(r));
}

export function deleteCardTagsForTagId(tagId: string): void {
  for (const r of listCardTagsByTagId(tagId)) {
    store.delete(CARD_TAGS, cardTagStoreKey(r));
  }
}

export function listCardLinksBySourceCard(sourceCardId: string): StoreRecord[] {
  return store.getAll(CARD_LINKS).filter((r) => r.sourceCardId === sourceCardId);
}

export function listCardLinksByTargetCard(targetCardId: string): StoreRecord[] {
  return store.getAll(CARD_LINKS).filter((r) => r.targetCardId === targetCardId);
}

export function findBidirectionalCardLink(
  sourceCardId: string,
  targetCardId: string,
): StoreRecord | null {
  for (const r of store.getAll(CARD_LINKS)) {
    if (r.sourceCardId === sourceCardId && r.targetCardId === targetCardId) return r;
    if (r.sourceCardId === targetCardId && r.targetCardId === sourceCardId) return r;
  }
  return null;
}

export function deleteCardLinksForCard(cardId: string): void {
  for (const r of store.getAll(CARD_LINKS)) {
    if (r.sourceCardId === cardId || r.targetCardId === cardId) {
      if (typeof r.id === 'string') store.delete(CARD_LINKS, r.id);
    }
  }
}

export function listCardCommentsByCardId(cardId: string): StoreRecord[] {
  return store.getAll(CARD_COMMENTS).filter((r) => r.cardId === cardId);
}

export function deleteCardCommentsByCardId(cardId: string): void {
  for (const r of listCardCommentsByCardId(cardId)) {
    if (typeof r.id === 'string') store.delete(CARD_COMMENTS, r.id);
  }
}

export function listCardsByCollectionId(collectionId: string): StoreRecord[] {
  return store.getAll(CARDS).filter((r) => r.collectionId === collectionId);
}

export async function countCardsByCollectionIdNative(collectionId: string): Promise<number> {
  const db = await getFlushedNativeDb();
  if (!db) return listCardsByCollectionId(collectionId).length;

  const [row] = await db
    .select({ count: count() })
    .from(schema.cards)
    .where(eq(schema.cards.collectionId, collectionId));
  return row?.count ?? 0;
}

export async function listBoardsNative(options: ListBoardsOptions): Promise<{
  entries: StoreRecord[];
  total: number;
}> {
  const db = await getFlushedNativeDb();
  if (!db) {
    let all = store.getAll(BOARDS);
    if (options.ids) {
      const ids = new Set(options.ids);
      all = all.filter((board) => ids.has(String(board.id)));
    }
    if (options.collectionId) {
      all = all.filter((board) => board.collectionId === options.collectionId);
    }
    if (options.search) {
      const term = options.search.toLowerCase();
      all = all.filter((board) => {
        const name = typeof board.name === 'string' ? board.name.toLowerCase() : '';
        const description =
          typeof board.description === 'string' ? board.description.toLowerCase() : '';
        return name.includes(term) || description.includes(term);
      });
    }
    all.sort(
      (a, b) =>
        new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime(),
    );
    return {
      entries: all.slice(options.offset, options.offset + options.limit),
      total: all.length,
    };
  }

  const filters = [];
  if (options.ids) {
    if (options.ids.length === 0) return { entries: [], total: 0 };
    filters.push(inArray(schema.boards.id, options.ids));
  }
  if (options.collectionId) filters.push(eq(schema.boards.collectionId, options.collectionId));
  if (options.search) {
    const pattern = `%${options.search}%`;
    filters.push(or(ilike(schema.boards.name, pattern), ilike(schema.boards.description, pattern)));
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow, rows] = await Promise.all([
    db.select({ count: count() }).from(schema.boards).where(where),
    db
      .select()
      .from(schema.boards)
      .where(where)
      .orderBy(desc(schema.boards.createdAt), asc(schema.boards.id))
      .limit(options.limit)
      .offset(options.offset),
  ]);

  return { entries: recordsFromLegacyRows(rows), total: totalRow[0]?.count ?? 0 };
}

export async function countGeneralBoardsNative(
  isGeneralBoard: (board: unknown) => boolean,
): Promise<number> {
  const db = await getFlushedNativeDb();
  if (!db) return store.getAll(BOARDS).filter((board) => isGeneralBoard(board)).length;

  const rows = await db
    .select()
    .from(schema.boards)
    .where(or(eq(schema.boards.isGeneral, true), ilike(schema.boards.name, 'general')));
  return recordsFromLegacyRows(rows).filter((board) => isGeneralBoard(board)).length;
}

export async function listGeneralBoardsNative(
  isGeneralBoard: (board: unknown) => boolean,
  excludeId?: string,
): Promise<StoreRecord[]> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return store
      .getAll(BOARDS)
      .filter((board) => (excludeId ? board.id !== excludeId : true))
      .filter((board) => isGeneralBoard(board));
  }

  const rows = await db
    .select()
    .from(schema.boards)
    .where(or(eq(schema.boards.isGeneral, true), ilike(schema.boards.name, 'general')));
  return recordsFromLegacyRows(rows)
    .filter((board) => (excludeId ? board.id !== excludeId : true))
    .filter((board) => isGeneralBoard(board));
}

export async function listCardsNative(options: ListCardsOptions): Promise<{
  entries: StoreRecord[];
  total: number;
}> {
  const db = await getFlushedNativeDb();
  if (!db) {
    let all = store.getAll(CARDS);
    if (options.collectionId) all = all.filter((card) => card.collectionId === options.collectionId);
    if (options.assigneeId) all = all.filter((card) => card.assigneeId === options.assigneeId);
    if (options.search) {
      const term = options.search.toLowerCase();
      all = all.filter((card) => {
        const name = typeof card.name === 'string' ? card.name.toLowerCase() : '';
        const description =
          typeof card.description === 'string' ? card.description.toLowerCase() : '';
        return name.includes(term) || description.includes(term);
      });
    }
    if (options.tagId) {
      const ids = new Set(listCardTagsByTagId(options.tagId).map((tag) => tag.cardId));
      all = all.filter((card) => ids.has(card.id));
    }
    all.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
    return {
      entries: options.limit === 0 ? [] : all.slice(options.offset, options.offset + options.limit),
      total: all.length,
    };
  }

  const filters = [];
  if (options.collectionId) filters.push(eq(schema.cards.collectionId, options.collectionId));
  if (options.assigneeId) filters.push(eq(schema.cards.assigneeId, options.assigneeId));
  if (options.search) {
    const pattern = `%${options.search}%`;
    filters.push(or(ilike(schema.cards.name, pattern), ilike(schema.cards.description, pattern)));
  }
  if (options.tagId) {
    filters.push(
      inArray(
        schema.cards.id,
        db.select({ cardId: schema.cardTags.cardId }).from(schema.cardTags).where(eq(schema.cardTags.tagId, options.tagId)),
      ),
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const totalRows = await db.select({ count: count() }).from(schema.cards).where(where);
  if (options.limit === 0) return { entries: [], total: totalRows[0]?.count ?? 0 };

  const rows = await db
    .select()
    .from(schema.cards)
    .where(where)
    .orderBy(asc(schema.cards.position), asc(schema.cards.id))
    .limit(options.limit)
    .offset(options.offset);

  return { entries: recordsFromLegacyRows(rows), total: totalRows[0]?.count ?? 0 };
}

export function listCardsWithCollectionIdIn(collectionIds: Set<string>): StoreRecord[] {
  return store
    .getAll(CARDS)
    .filter((c) => typeof c.collectionId === 'string' && collectionIds.has(c.collectionId));
}

export function listBoardsTouchingCollectionIds(collectionIds: Set<string>): StoreRecord[] {
  return store.getAll(BOARDS).filter((board: StoreRecord) => {
    const cid = board.collectionId;
    const did = board.defaultCollectionId;
    return (
      (typeof cid === 'string' && collectionIds.has(cid)) ||
      (typeof did === 'string' && collectionIds.has(did))
    );
  });
}

export function listWorkspacesTouchingCollectionIds(collectionIds: Set<string>): StoreRecord[] {
  return store.getAll(WORKSPACES).filter((workspace: StoreRecord) => {
    const ids = workspace.collectionIds;
    if (!Array.isArray(ids)) return false;
    return ids.some((collectionId: unknown) =>
      typeof collectionId === 'string' ? collectionIds.has(collectionId) : false,
    );
  });
}
