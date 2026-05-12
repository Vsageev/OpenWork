import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { SqlStoreAdapter } from './sql-store-adapter.js';
import type { DatabaseConfig } from '../config/database.js';

const adminDatabaseUrl = process.env.STORE_CONTRACT_DATABASE_URL ?? process.env.DATABASE_URL;
const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('agent execution row locking', () => {
  it.skipIf(!adminDatabaseUrl)(
    'only one of two concurrent transactions can claim the same chat queue row',
    async () => {
      await withTemporaryPostgresDatabase(adminDatabaseUrl!, async (databaseUrl) => {
        const config: DatabaseConfig = {
          driver: 'postgres',
          databaseUrl,
          migrationsDir: './drizzle',
          migrationsTable: '__drizzle_migrations',
          migrationsSchema: 'drizzle',
        };

        const storeA = new SqlStoreAdapter(config);
        const storeB = new SqlStoreAdapter(config);
        await storeA.init();
        await storeB.init();

        const suffix = crypto.randomUUID().slice(0, 8);
        const userId = `user-lock-${suffix}`;
        const contactId = `contact-lock-${suffix}`;
        const conversationId = `conv-lock-${suffix}`;
        const agentId = `agent-lock-${suffix}`;
        const queueId = `queue-lock-${suffix}`;

        await storeA.insert('users', {
          id: userId,
          email: `${userId}@example.test`,
          passwordHash: 'hash',
          firstName: 'Lock',
          lastName: 'Test',
          type: 'human',
          isActive: true,
          totpSecret: null,
          totpEnabled: false,
          recoveryCodes: null,
        });

        await storeA.insert('contacts', {
          id: contactId,
          firstName: 'C',
          lastName: null,
          email: null,
          phone: null,
          source: null,
          telegramId: null,
          notes: null,
        });

        await storeA.insert('conversations', {
          id: conversationId,
          contactId,
          assigneeId: null,
          channelType: 'web',
          status: 'open',
          subject: null,
          externalId: null,
          isUnread: false,
          lastMessageAt: null,
          closedAt: null,
          metadata: null,
          provider: null,
          modelId: null,
          activeChatbotFlowId: null,
          chatbotFlowStepId: null,
          chatbotFlowData: null,
        });

        await storeA.insert('agents', {
          id: agentId,
          name: 'Lock test agent',
          description: null,
          model: null,
          modelId: null,
          thinkingLevel: null,
          preset: null,
          presetParameters: null,
          status: 'active',
          apiKeyId: null,
          apiKeyName: null,
          apiKeyPrefix: null,
          workspaceApiKey: null,
          workspaceApiKeyId: null,
          capabilities: null,
          skipPermissions: null,
          groupId: null,
          serviceUserId: null,
          repositoryRoot: null,
          workspacePath: null,
          separateFolderPerChat: false,
          skillIds: null,
          cronJobs: null,
          avatarIcon: null,
          avatarBgColor: null,
          avatarLogoColor: null,
          lastActivity: null,
        });

        const nowIso = new Date().toISOString();
        await storeA.insert('agentChatQueue', {
          id: queueId,
          agentId,
          conversationId,
          mode: 'append_prompt',
          prompt: 'hello',
          status: 'queued',
          attempts: 0,
          maxAttempts: 4,
          runId: null,
          lastRunId: null,
          targetMessageId: null,
          continuationParentId: null,
          dependsOnQueueItemId: null,
          previousUserMessageId: null,
          queuedMessageId: null,
          responseMessageId: null,
          errorMessage: null,
          nextAttemptAt: nowIso,
          startedAt: null,
          completedAt: null,
          usedFallback: null,
          fallbackModel: null,
        });

        await storeA.flush();
        await storeB.reload();

        async function tryClaim(sqlStore: SqlStoreAdapter): Promise<boolean> {
          return sqlStore.transaction(async () => {
            await sqlStore.lockAgentChatQueueConversation(agentId, conversationId);
            const row = sqlStore.getById('agentChatQueue', queueId);
            if (!row || row.status !== 'queued') return false;
            sqlStore.update('agentChatQueue', queueId, {
              status: 'processing',
              attempts: Number(row.attempts ?? 0) + 1,
              startedAt: new Date().toISOString(),
              runId: null,
              errorMessage: null,
              completedAt: null,
              usedFallback: false,
              fallbackModel: null,
            });
            return true;
          });
        }

        const [first, second] = await Promise.all([tryClaim(storeA), tryClaim(storeB)]);
        expect(first === true || second === true).toBe(true);
        expect(first === true && second === true).toBe(false);

        await storeA.reload();
        const finalRow = storeA.getById('agentChatQueue', queueId);
        expect(finalRow?.status).toBe('processing');
        expect(Number(finalRow?.attempts ?? 0)).toBe(1);

        await storeA.flush();
      });
    },
  );

  it.skipIf(!adminDatabaseUrl)('applies migration 0002 partial index for live chat runs', async () => {
    await withTemporaryPostgresDatabase(adminDatabaseUrl!, async (databaseUrl) => {
      const sql = postgres(databaseUrl, { max: 1, prepare: false });
      try {
        const rows = await sql`
          select indexname from pg_indexes
          where schemaname = 'public' and indexname = 'agent_runs_live_chat_idx'
        `;
        expect(rows).toHaveLength(1);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });
});

async function withTemporaryPostgresDatabase(
  baseDatabaseUrl: string,
  run: (databaseUrl: string) => Promise<void>,
): Promise<void> {
  const tmpDatabase = `openwork_agent_exec_${process.pid}_${Date.now()}`;
  const adminUrl = databaseUrlForDatabase(baseDatabaseUrl, 'postgres');
  const tmpDatabaseUrl = databaseUrlForDatabase(baseDatabaseUrl, tmpDatabase);
  const admin = postgres(adminUrl, { max: 1, prepare: false });

  try {
    await admin.unsafe(`create database "${tmpDatabase}"`);
    await migratePostgresDatabase(tmpDatabaseUrl);
    await run(tmpDatabaseUrl);
  } finally {
    await admin.unsafe(`drop database if exists "${tmpDatabase}" with (force)`);
    await admin.end();
  }
}

async function migratePostgresDatabase(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const migrationFiles = [
    '0000_graceful_wiccan.sql',
    '0001_aberrant_peter_parker.sql',
    '0002_sql_hardening.sql',
  ];

  try {
    for (const name of migrationFiles) {
      const migrationPath = path.resolve(testDir, '../../drizzle', name);
      if (!fs.existsSync(migrationPath)) continue;
      const migration = fs.readFileSync(migrationPath, 'utf-8');
      for (const statement of migration
        .split('--> statement-breakpoint')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await sql.unsafe(statement);
      }
    }
  } finally {
    await sql.end();
  }
}

function databaseUrlForDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
