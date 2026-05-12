#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import postgres, { type Sql } from 'postgres';
import { collectionSchemas } from '../src/schemas/collections.js';

type JsonRecord = Record<string, unknown>;
type SqlRunner = {
  unsafe<T extends object[] = Record<string, unknown>[]>(query: string, params?: unknown[]): Promise<T>;
};

type CollectionMapping = {
  collection: string;
  table: string;
  columns: string[];
  primaryFields?: string[];
  schemaKey?: string;
};

type CollectionReport = {
  collection: string;
  table: string;
  sourceCount: number;
  insertedCount: number;
  skippedCount: number;
  validationSkipped: number;
  constraintSkipped: number;
  schema: 'validated' | 'missing';
  elapsedMs: number;
};

type ReportIssue = {
  collection: string;
  index: number;
  id: string | null;
  type: 'validation' | 'constraint' | 'parse' | 'database';
  message: string;
};

type ImportReport = {
  mode: 'dry-run' | 'import';
  dataDir: string;
  databaseUrl: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  dryRunRolledBack: boolean;
  targetEmptyCheck: 'passed' | 'failed' | 'skipped';
  totals: {
    source: number;
    inserted: number;
    skipped: number;
    validationSkipped: number;
    constraintSkipped: number;
  };
  collections: CollectionReport[];
  issues: ReportIssue[];
};

const fallbackTable = 'sql_store_records';
const rollbackMarker = '__OPENWORK_JSON_IMPORT_DRY_RUN_ROLLBACK__';

const mappings: CollectionMapping[] = [
  mapping('users', 'users', [
    'id',
    'email',
    'passwordHash',
    'firstName',
    'lastName',
    'type',
    'agentId',
    'isActive',
    'totpSecret',
    'totpEnabled',
    'recoveryCodes',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('refreshTokens', 'refresh_tokens', [
    'id',
    'userId',
    'tokenHash',
    'expiresAt',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('apiKeys', 'api_keys', [
    'id',
    'name',
    'keyHash',
    'keyPrefix',
    'permissions',
    'createdById',
    'isActive',
    'expiresAt',
    'lastUsedAt',
    'description',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('settings', 'settings', [
    'id',
    'defaultAgentKeyId',
    'fallbackModel',
    'fallbackModelId',
    'agentPromptMax',
    'agentPromptWindowS',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('auditLogs', 'audit_logs', [
    'id',
    'userId',
    'action',
    'entityType',
    'entityId',
    'changes',
    'ipAddress',
    'userAgent',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentGroups', 'agent_groups', [
    'id',
    'name',
    'order',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('skills', 'skills', ['id', 'name', 'description', 'createdAt', 'updatedAt', 'legacyData']),
  mapping('collections', 'collections', [
    'id',
    'name',
    'description',
    'isGeneral',
    'agentBatchConfig',
    'createdById',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('workspaces', 'workspaces', [
    'id',
    'name',
    'userId',
    'boardIds',
    'collectionIds',
    'agentGroupIds',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agents', 'agents', [
    'id',
    'name',
    'description',
    'model',
    'modelId',
    'thinkingLevel',
    'preset',
    'presetParameters',
    'status',
    'apiKeyId',
    'apiKeyName',
    'apiKeyPrefix',
    'workspaceApiKey',
    'workspaceApiKeyId',
    'capabilities',
    'skipPermissions',
    'groupId',
    'serviceUserId',
    'repositoryRoot',
    'workspacePath',
    'separateFolderPerChat',
    'skillIds',
    'cronJobs',
    'avatarIcon',
    'avatarBgColor',
    'avatarLogoColor',
    'lastActivity',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentAvatarPresets', 'agent_avatar_presets', [
    'id',
    'name',
    'avatarIcon',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentColorPresets', 'agent_color_presets', [
    'id',
    'name',
    'color',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentExternalApiKeys', 'agent_external_api_keys', [
    'id',
    'agentId',
    'provider',
    'keyHash',
    'keyPrefix',
    'encryptedValue',
    'metadata',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentEnvVars', 'agent_env_vars', [
    'id',
    'agentId',
    'key',
    'description',
    'encryptedValue',
    'valuePreview',
    'isActive',
    'createdById',
    'lastUsedAt',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('boards', 'boards', [
    'id',
    'name',
    'description',
    'collectionId',
    'defaultCollectionId',
    'isGeneral',
    'createdById',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('boardColumns', 'board_columns', [
    'id',
    'boardId',
    'name',
    'color',
    'position',
    'wipLimit',
    'assignAgentId',
    'assignAgentPrompt',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('cards', 'cards', [
    'id',
    'collectionId',
    'name',
    'description',
    'customFields',
    'createdById',
    'assigneeId',
    'position',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('boardCards', 'board_cards', [
    'id',
    'boardId',
    'cardId',
    'columnId',
    'position',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('tags', 'tags', ['id', 'name', 'color', 'createdAt', 'updatedAt', 'legacyData']),
  mapping('cardTags', 'card_tags', ['cardId', 'tagId', 'legacyData'], ['cardId', 'tagId']),
  mapping('cardLinks', 'card_links', [
    'id',
    'sourceCardId',
    'targetCardId',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('cardComments', 'card_comments', [
    'id',
    'cardId',
    'authorId',
    'agentRunId',
    'content',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('boardCronTemplates', 'board_cron_templates', [
    'id',
    'boardId',
    'agentId',
    'schedule',
    'prompt',
    'config',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('conversations', 'conversations', [
    'id',
    'contactId',
    'assigneeId',
    'channelType',
    'status',
    'subject',
    'externalId',
    'isUnread',
    'lastMessageAt',
    'closedAt',
    'metadata',
    'provider',
    'modelId',
    'activeChatbotFlowId',
    'chatbotFlowStepId',
    'chatbotFlowData',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('messages', 'messages', [
    'id',
    'conversationId',
    'senderId',
    'direction',
    'type',
    'content',
    'status',
    'externalId',
    'parentId',
    'previousUserMessageId',
    'attachments',
    'metadata',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('messageDrafts', 'message_drafts', [
    'id',
    'conversationId',
    'content',
    'attachments',
    'metadata',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('telegramBots', 'telegram_bots', [
    'id',
    'token',
    'botId',
    'botUsername',
    'botFirstName',
    'webhookUrl',
    'webhookSecret',
    'status',
    'statusMessage',
    'autoGreetingEnabled',
    'autoGreetingText',
    'createdById',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('connectors', 'connectors', [
    'id',
    'type',
    'name',
    'status',
    'statusMessage',
    'capabilities',
    'integrationId',
    'config',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('webhooks', 'webhooks', [
    'id',
    'url',
    'description',
    'events',
    'secret',
    'isActive',
    'createdById',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('webhookDeliveries', 'webhook_deliveries', [
    'id',
    'webhookId',
    'event',
    'payload',
    'status',
    'responseStatus',
    'responseBody',
    'attempt',
    'maxAttempts',
    'nextRetryAt',
    'durationMs',
    'createdAt',
    'completedAt',
    'legacyData',
  ]),
  mapping('agent_runs', 'agent_runs', [
    'id',
    'agentId',
    'agentName',
    'model',
    'modelId',
    'triggerType',
    'triggerPrompt',
    'status',
    'conversationId',
    'cardId',
    'cronJobId',
    'pid',
    'stdoutPath',
    'stderrPath',
    'stdout',
    'stderr',
    'errorMessage',
    'responseText',
    'responseParentId',
    'killedByUser',
    'avatarIcon',
    'avatarBgColor',
    'avatarLogoColor',
    'startedAt',
    'finishedAt',
    'durationMs',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentChatQueue', 'agent_chat_queue', [
    'id',
    'agentId',
    'conversationId',
    'mode',
    'prompt',
    'status',
    'attempts',
    'maxAttempts',
    'runId',
    'lastRunId',
    'targetMessageId',
    'continuationParentId',
    'dependsOnQueueItemId',
    'previousUserMessageId',
    'queuedMessageId',
    'responseMessageId',
    'errorMessage',
    'nextAttemptAt',
    'startedAt',
    'completedAt',
    'usedFallback',
    'fallbackModel',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentBatchRuns', 'agent_batch_runs', [
    'id',
    'sourceType',
    'sourceId',
    'sourceName',
    'agentId',
    'prompt',
    'maxParallel',
    'status',
    'total',
    'queued',
    'processing',
    'completed',
    'failed',
    'cancelled',
    'skipped',
    'stageCount',
    'dependencyItemCount',
    'startedAt',
    'finishedAt',
    'errorMessage',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentBatchRunItems', 'agent_batch_run_items', [
    'id',
    'runId',
    'sourceType',
    'sourceId',
    'agentId',
    'cardId',
    'cardName',
    'cardDescription',
    'cardCollectionId',
    'order',
    'status',
    'attempts',
    'maxAttempts',
    'nextAttemptAt',
    'errorMessage',
    'startedAt',
    'completedAt',
    'agentRunId',
    'stageId',
    'dependsOnItemIds',
    'blockingMode',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('migrations', 'json_migrations', ['id', 'createdAt', 'updatedAt', 'legacyData']),
  mapping('mediaObjects', 'media_objects', [
    'id',
    'storagePath',
    'name',
    'type',
    'size',
    'mimeType',
    'checksum',
    'metadata',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('backupManifests', 'backup_manifests', [
    'id',
    'filename',
    'storagePath',
    'sizeBytes',
    'metadata',
    'createdAt',
    'legacyData',
  ]),
];

const mappingByCollection = new Map(mappings.map((entry) => [entry.collection, entry]));
const schemaAliases = new Map(mappings.map((entry) => [entry.collection, entry.schemaKey]));

const constraints: Record<string, Array<[string, string]>> = {
  apiKeys: [['createdById', 'users']],
  settings: [['defaultAgentKeyId', 'apiKeys']],
  auditLogs: [['userId', 'users']],
  collections: [['createdById', 'users']],
  workspaces: [['userId', 'users']],
  agents: [
    ['apiKeyId', 'apiKeys'],
    ['workspaceApiKeyId', 'apiKeys'],
    ['groupId', 'agentGroups'],
    ['serviceUserId', 'users'],
  ],
  agentExternalApiKeys: [['agentId', 'agents']],
  agentEnvVars: [
    ['agentId', 'agents'],
    ['createdById', 'users'],
  ],
  boards: [
    ['collectionId', 'collections'],
    ['defaultCollectionId', 'collections'],
    ['createdById', 'users'],
  ],
  boardColumns: [['boardId', 'boards']],
  cards: [['collectionId', 'collections']],
  boardCards: [
    ['boardId', 'boards'],
    ['cardId', 'cards'],
    ['columnId', 'boardColumns'],
  ],
  cardTags: [
    ['cardId', 'cards'],
    ['tagId', 'tags'],
  ],
  cardLinks: [
    ['sourceCardId', 'cards'],
    ['targetCardId', 'cards'],
  ],
  cardComments: [['cardId', 'cards']],
  boardCronTemplates: [
    ['boardId', 'boards'],
    ['agentId', 'agents'],
  ],
  messages: [['conversationId', 'conversations']],
  messageDrafts: [['conversationId', 'conversations']],
  telegramBots: [['createdById', 'users']],
  webhooks: [['createdById', 'users']],
  webhookDeliveries: [['webhookId', 'webhooks']],
  agent_runs: [
    ['agentId', 'agents'],
    ['cardId', 'cards'],
  ],
  agentChatQueue: [
    ['agentId', 'agents'],
    ['conversationId', 'conversations'],
    ['lastRunId', 'agent_runs'],
  ],
  agentBatchRuns: [['agentId', 'agents']],
  agentBatchRunItems: [
    ['runId', 'agentBatchRuns'],
    ['agentId', 'agents'],
    ['cardId', 'cards'],
    ['cardCollectionId', 'collections'],
    ['agentRunId', 'agent_runs'],
  ],
  refreshTokens: [['userId', 'users']],
};

async function main(): Promise<void> {
  const startedAt = new Date();
  const started = performance.now();
  const options = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const issues: ReportIssue[] = [];

  try {
    const loaded = await loadCollections(dataDir, issues);
    const availableTables = await loadAvailableTables(sql);
    await ensureRequiredTables(availableTables);

    const targetEmptyCheck = await checkTargetEmpty(sql, availableTables);
    if (!options.allowNonEmpty && targetEmptyCheck.length > 0) {
      throw new Error(
        `Target SQL database is not empty (${targetEmptyCheck
          .slice(0, 5)
          .map((entry) => `${entry.table}=${entry.count}`)
          .join(', ')}). Re-run against an empty database, or pass --allow-non-empty to make repeat behavior explicit.`,
      );
    }

    const report = await runImport(sql, loaded, availableTables, issues, options.mode);
    report.dataDir = dataDir;
    report.databaseUrl = redactDatabaseUrl(databaseUrl);
    report.startedAt = startedAt.toISOString();
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Math.round(performance.now() - started);
    report.targetEmptyCheck = targetEmptyCheck.length > 0 ? 'skipped' : 'passed';

    if (options.reportPath) {
      await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    const reportDir = options.reportDir ?? process.env.OPENWORK_IMPORT_REPORT_DIR;
    if (reportDir) {
      const dir = path.resolve(reportDir);
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(':', '-');
      const fileName = `import-${options.mode}-${stamp}.json`;
      const reportFile = path.join(dir, fileName);
      await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
      console.error(`Wrote import report: ${reportFile}`);
    }

    printReport(report);
    if (report.totals.skipped > 0 || issues.some((issue) => issue.type === 'database')) {
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

async function runImport(
  sql: Sql,
  loaded: Map<string, JsonRecord[]>,
  availableTables: Set<string>,
  issues: ReportIssue[],
  mode: 'dry-run' | 'import',
): Promise<ImportReport> {
  const collectionReports: CollectionReport[] = [];
  const totals = {
    source: 0,
    inserted: 0,
    skipped: 0,
    validationSkipped: 0,
    constraintSkipped: 0,
  };
  const insertedByTable = new Map<string, number>();
  const importedIds = new Map<string, Set<string>>();

  try {
    await sql.begin(async (tx) => {
      for (const collection of orderedCollections(loaded)) {
        const records = loaded.get(collection) ?? [];
        const entry = mappingByCollection.get(collection);
        const collectionStarted = performance.now();
        const schemaKey = schemaAliases.get(collection);
        const schema = schemaKey ? collectionSchemas[schemaKey] : undefined;
        let insertedCount = 0;
        let validationSkipped = 0;
        let constraintSkipped = 0;

        totals.source += records.length;

        if (!entry) {
          if (!availableTables.has(fallbackTable)) {
            throw new Error(`No mapped table for ${collection} and ${fallbackTable} is missing.`);
          }
          for (const [index, record] of records.entries()) {
            const id = recordId(collection, record);
            if (!id) {
              validationSkipped += 1;
              issues.push({
                collection,
                index,
                id: null,
                type: 'validation',
                message: 'Fallback records must contain a string id.',
              });
              continue;
            }
            await insertFallback(tx, collection, id, record);
            insertedCount += 1;
            rememberImportedId(importedIds, collection, id);
            insertedByTable.set(fallbackTable, (insertedByTable.get(fallbackTable) ?? 0) + 1);
          }
        } else {
          for (const [index, record] of records.entries()) {
            const id = recordId(collection, record);
            const validationMessage = validateRecord(schema, record);
            if (validationMessage) {
              validationSkipped += 1;
              issues.push({ collection, index, id, type: 'validation', message: validationMessage });
              continue;
            }

            const constraintMessage = validateConstraints(collection, record, importedIds);
            if (constraintMessage) {
              constraintSkipped += 1;
              issues.push({ collection, index, id, type: 'constraint', message: constraintMessage });
              continue;
            }

            await insertMapped(tx, entry, record);
            insertedCount += 1;
            if (id) rememberImportedId(importedIds, collection, id);
            insertedByTable.set(entry.table, (insertedByTable.get(entry.table) ?? 0) + 1);
          }
        }

        const skippedCount = validationSkipped + constraintSkipped;
        totals.inserted += insertedCount;
        totals.skipped += skippedCount;
        totals.validationSkipped += validationSkipped;
        totals.constraintSkipped += constraintSkipped;
        collectionReports.push({
          collection,
          table: entry?.table ?? fallbackTable,
          sourceCount: records.length,
          insertedCount,
          skippedCount,
          validationSkipped,
          constraintSkipped,
          schema: schema ? 'validated' : 'missing',
          elapsedMs: Math.round(performance.now() - collectionStarted),
        });
      }

      for (const [table, expected] of insertedByTable) {
        const [{ count }] = await tx.unsafe<{ count: string }[]>(
          `select count(*)::text as count from ${quoteIdent(table)}`,
        );
        const actual = Number(count);
        if (actual !== expected) {
          issues.push({
            collection: table,
            index: -1,
            id: null,
            type: 'database',
            message: `SQL count mismatch for ${table}: expected ${expected}, got ${actual}`,
          });
        }
      }

      if (mode === 'dry-run') {
        throw new Error(rollbackMarker);
      }
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === rollbackMarker)) {
      throw error;
    }
  }

  return {
    mode,
    dataDir: '',
    databaseUrl: '',
    startedAt: '',
    finishedAt: '',
    elapsedMs: 0,
    dryRunRolledBack: mode === 'dry-run',
    targetEmptyCheck: 'passed',
    totals,
    collections: collectionReports,
    issues,
  };
}

async function loadCollections(
  dataDir: string,
  issues: ReportIssue[],
): Promise<Map<string, JsonRecord[]>> {
  const files = (await fs.readdir(dataDir))
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => collectionSortKey(a).localeCompare(collectionSortKey(b)));
  const loaded = new Map<string, JsonRecord[]>();

  for (const file of files) {
    const collection = file.slice(0, -'.json'.length);
    const filePath = path.join(dataDir, file);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) {
        issues.push({
          collection,
          index: -1,
          id: null,
          type: 'parse',
          message: `${file} must contain an array.`,
        });
        loaded.set(collection, []);
        continue;
      }
      loaded.set(
        collection,
        parsed.filter((record, index): record is JsonRecord => {
          if (record && typeof record === 'object' && !Array.isArray(record)) return true;
          issues.push({
            collection,
            index,
            id: null,
            type: 'parse',
            message: 'Record must be a JSON object.',
          });
          return false;
        }),
      );
    } catch (error) {
      issues.push({
        collection,
        index: -1,
        id: null,
        type: 'parse',
        message: error instanceof Error ? error.message : String(error),
      });
      loaded.set(collection, []);
    }
  }

  return loaded;
}

function orderedCollections(loaded: Map<string, JsonRecord[]>): string[] {
  const known = mappings.map((entry) => entry.collection).filter((collection) => loaded.has(collection));
  const unknown = [...loaded.keys()]
    .filter((collection) => !mappingByCollection.has(collection))
    .sort();
  return [...known, ...unknown];
}

function validateRecord(schema: unknown, record: JsonRecord): string | null {
  if (!schema || typeof schema !== 'object' || !('safeParse' in schema)) return null;
  const result = (schema as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }).safeParse(record);
  if (result.success) return null;
  return result.error instanceof Error ? result.error.message : String(result.error);
}

function rememberImportedId(ids: Map<string, Set<string>>, collection: string, id: string): void {
  let collectionIds = ids.get(collection);
  if (!collectionIds) {
    collectionIds = new Set();
    ids.set(collection, collectionIds);
  }
  collectionIds.add(id);
}

function validateConstraints(
  collection: string,
  record: JsonRecord,
  validIds: Map<string, Set<string>>,
): string | null {
  for (const [field, targetCollection] of constraints[collection] ?? []) {
    const value = record[field];
    if (value === null || value === undefined || value === '') continue;
    const ids = validIds.get(targetCollection);
    if (!ids?.has(String(value))) {
      return `${field} references missing ${targetCollection}.${String(value)}`;
    }
  }
  return null;
}

async function insertMapped(tx: SqlRunner, entry: CollectionMapping, record: JsonRecord): Promise<void> {
  const columns = entry.columns.map(toSnake);
  const params = entry.columns.map((field) => sqlValue(field, record));
  const columnSql = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  await tx.unsafe(
    `insert into ${quoteIdent(entry.table)} (${columnSql}) values (${placeholders})`,
    params,
  );
}

async function insertFallback(
  tx: SqlRunner,
  collection: string,
  id: string,
  record: JsonRecord,
): Promise<void> {
  const now = new Date().toISOString();
  await tx.unsafe(
    `insert into ${quoteIdent(fallbackTable)} ("collection", "id", "data", "created_at", "updated_at")
     values ($1, $2, $3, $4, $5)`,
    [collection, id, JSON.stringify(record), record.createdAt ?? now, record.updatedAt ?? now],
  );
}

async function loadAvailableTables(sql: Sql): Promise<Set<string>> {
  const rows = await sql.unsafe<{ table_name: string }[]>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  return new Set(rows.map((row) => row.table_name));
}

async function ensureRequiredTables(availableTables: Set<string>): Promise<void> {
  const missing = [...new Set([...mappings.map((entry) => entry.table), fallbackTable])].filter(
    (table) => !availableTables.has(table),
  );
  if (missing.length > 0) {
    throw new Error(
      `Target SQL database is missing ${missing.length} required table(s): ${missing
        .slice(0, 10)
        .join(', ')}. Run the Drizzle migration before importing JSON.`,
    );
  }
}

async function checkTargetEmpty(
  sql: Sql,
  availableTables: Set<string>,
): Promise<Array<{ table: string; count: number }>> {
  const tables = [...new Set([...mappings.map((entry) => entry.table), fallbackTable])].filter((table) =>
    availableTables.has(table),
  );
  const nonEmpty: Array<{ table: string; count: number }> = [];
  for (const table of tables) {
    const [{ count }] = await sql.unsafe<{ count: string }[]>(
      `select count(*)::text as count from ${quoteIdent(table)}`,
    );
    const parsed = Number(count);
    if (parsed > 0) nonEmpty.push({ table, count: parsed });
  }
  return nonEmpty;
}

function parseArgs(args: string[]): {
  mode: 'dry-run' | 'import';
  dataDir?: string;
  databaseUrl?: string;
  reportPath?: string;
  reportDir?: string;
  allowNonEmpty: boolean;
} {
  const options = { mode: 'dry-run' as const, allowNonEmpty: false };
  const parsed: {
    mode: 'dry-run' | 'import';
    dataDir?: string;
    databaseUrl?: string;
    reportPath?: string;
    reportDir?: string;
    allowNonEmpty: boolean;
  } = { ...options };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === '--') continue;
    else if (arg === '--dry-run') parsed.mode = 'dry-run';
    else if (arg === '--import') parsed.mode = 'import';
    else if (arg === '--allow-non-empty') parsed.allowNonEmpty = true;
    else if (arg === '--data-dir') parsed.dataDir = next();
    else if (arg === '--database-url') parsed.databaseUrl = next();
    else if (arg === '--report') parsed.reportPath = next();
    else if (arg === '--report-dir') parsed.reportDir = next();
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Usage: pnpm --filter backend db:import-json -- [options]

Imports top-level DATA_DIR/*.json collections into the current PostgreSQL schema.
Dry-run is the default and rolls back the transaction.

Options:
  --dry-run              Validate and insert inside a rollback transaction (default)
  --import               Commit the import
  --data-dir <path>      JSON data directory (default: DATA_DIR or ./data)
  --database-url <url>   PostgreSQL URL (default: DATABASE_URL)
  --report <path>        Write the full JSON report to a file
  --report-dir <path>    Also write import-<mode>-<timestamp>.json under this directory
                         (or set OPENWORK_IMPORT_REPORT_DIR; combines with --report)
  --allow-non-empty      Allow running against a non-empty target database
`);
}

function printReport(report: ImportReport): void {
  console.log(JSON.stringify(report, null, 2));
  const verb = report.mode === 'dry-run' ? 'Dry-run' : 'Import';
  console.error(
    `${verb} ${report.totals.skipped === 0 ? 'passed' : 'completed with skipped records'}: ${report.totals.inserted}/${report.totals.source} record(s), ${report.totals.skipped} skipped, ${report.elapsedMs}ms.`,
  );
}

function mapping(
  collection: string,
  table: string,
  columns: string[],
  primaryFields = ['id'],
): CollectionMapping {
  return {
    collection,
    table,
    columns,
    primaryFields,
    schemaKey: collectionSchemas[collection] ? collection : toSnake(collection),
  };
}

function collectionSortKey(file: string): string {
  const collection = file.slice(0, -'.json'.length);
  const index = mappings.findIndex((entry) => entry.collection === collection);
  return `${index === -1 ? mappings.length : index}`.padStart(3, '0') + collection;
}

function recordId(collection: string, record: JsonRecord): string | null {
  const primaryFields = mappingByCollection.get(collection)?.primaryFields ?? ['id'];
  const values = primaryFields.map((field) => record[field]);
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) return null;
  return values.map(String).join(':');
}

function sqlValue(field: string, record: JsonRecord): unknown {
  if (field === 'legacyData') return JSON.stringify(record);
  const value = record[field];
  if (value === undefined) return null;
  if (field === 'metadata' && typeof value === 'string') return JSON.stringify(parseMaybeJson(value));
  if (Array.isArray(value) || (value && typeof value === 'object' && !(value instanceof Date))) {
    return JSON.stringify(value);
  }
  return value;
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toSnake(name: string): string {
  if (name === 'order') return 'order_index';
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
