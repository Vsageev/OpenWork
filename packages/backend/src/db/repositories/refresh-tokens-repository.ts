import { and, eq, gt } from 'drizzle-orm';
import { store } from '../connection.js';
import * as schema from '../schema.js';
import type { StoreRecord } from '../store.js';
import { getFlushedNativeDb, recordFromLegacyRow } from './native-repository-utils.js';

export async function findValidRefreshTokenByHash(tokenHash: string): Promise<StoreRecord | null> {
  const db = await getFlushedNativeDb();
  if (!db) {
    return (
      store.getAll('refreshTokens').find(
        (r) =>
          r.tokenHash === tokenHash && new Date(String(r.expiresAt)).getTime() > Date.now(),
      ) ?? null
    );
  }
  const rows = await db
    .select()
    .from(schema.refreshTokens)
    .where(
      and(eq(schema.refreshTokens.tokenHash, tokenHash), gt(schema.refreshTokens.expiresAt, new Date())),
    )
    .limit(1);
  return rows[0] ? recordFromLegacyRow(rows[0]) : null;
}

/**
 * Deletes all refresh-token rows for a user. Uses `store.delete` per row so the
 * SqlStoreAdapter in-memory cache stays aligned with Postgres.
 */
export async function deleteRefreshTokensForUserId(userId: string): Promise<void> {
  const db = await getFlushedNativeDb();
  if (!db) {
    for (const record of store.getAll('refreshTokens')) {
      if (record.userId === userId) {
        await store.delete('refreshTokens', String(record.id));
      }
    }
    return;
  }
  const rows = await db
    .select({ id: schema.refreshTokens.id })
    .from(schema.refreshTokens)
    .where(eq(schema.refreshTokens.userId, userId));
  for (const row of rows) {
    await store.delete('refreshTokens', row.id);
  }
}
