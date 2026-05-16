import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { DatabaseConfig } from '../config/database.js';
import * as schema from './schema.js';
import type { DurableStoreRecord, NativeQueryStore, Store, StoreRecord } from './store.js';

type SqlClient = {
  unsafe(query: string, params?: unknown[]): Promise<StoreRecord[]>;
  begin?: <T>(operation: (client: SqlClient) => Promise<T>) => Promise<T>;
  end?: () => Promise<void>;
};

type CollectionMapping = {
  collection: string;
  table: string;
  columns: string[];
  primaryFields: string[];
};

const MAPPINGS: CollectionMapping[] = [
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
  mapping('agentGroups', 'agent_groups', [
    'id',
    'name',
    'order',
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
  mapping('contacts', 'contacts', [
    'id',
    'firstName',
    'lastName',
    'email',
    'phone',
    'source',
    'telegramId',
    'notes',
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
  mapping('refreshTokens', 'refresh_tokens', [
    'id',
    'userId',
    'tokenHash',
    'expiresAt',
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
    'executor',
    'pid',
    'stdoutPath',
    'stderrPath',
    'stdout',
    'stderr',
    'errorMessage',
    'responseText',
    'responseParentId',
    'turnId',
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
  mapping('agentChatTurns', 'agent_chat_turns', [
    'id',
    'conversationId',
    'agentId',
    'parentTurnId',
    'userMessageId',
    'assistantMessageId',
    'status',
    'runId',
    'source',
    'createdById',
    'turnType',
    'supersedesTurnId',
    'metadata',
    'startedAt',
    'completedAt',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentRunners', 'agent_runners', [
    'id',
    'userId',
    'workspaceId',
    'displayName',
    'credentialHash',
    'credentialPrefix',
    'status',
    'lastSeenAt',
    'version',
    'capabilities',
    'revokedAt',
    'createdAt',
    'updatedAt',
    'legacyData',
  ]),
  mapping('agentRunnerPairingCodes', 'agent_runner_pairing_codes', [
    'id',
    'userId',
    'workspaceId',
    'codeHash',
    'displayName',
    'expiresAt',
    'usedAt',
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
    'turnId',
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
  mapping('skills', 'skills', [
    'id',
    'name',
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
  mapping('migrations', 'json_migrations', ['id', 'createdAt', 'updatedAt', 'legacyData']),
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

const MAPPING_BY_COLLECTION = new Map(MAPPINGS.map((entry) => [entry.collection, entry]));

/** API collection names backed by mapped SQL tables (used for SQL-mode JSON export in backups). */
export const STORE_MAPPED_COLLECTION_NAMES: readonly string[] = MAPPINGS.map((m) => m.collection);

export class SqlStoreAdapter implements Store, NativeQueryStore<ReturnType<typeof drizzle<typeof schema>>> {
  private client: SqlClient | null = null;
  private collections = new Map<string, Map<string, StoreRecord>>();
  private availableTables = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  private transactionClient: SqlClient | null = null;
  private transactionWrites: Promise<void>[] | null = null;
  private transactionQueue: Promise<void> = Promise.resolve();
  private transactionScope = new AsyncLocalStorage<boolean>();

  constructor(
    private readonly config: DatabaseConfig,
    client?: SqlClient,
  ) {
    this.client = client ?? null;
  }

  async init(): Promise<void> {
    if (!this.client) {
      const { default: postgres } = await import('postgres');
      this.client = postgres(this.config.databaseUrl, { max: 10, prepare: false }) as SqlClient;
    }

    await this.loadFromSql();
  }

  getAll(collection: string): StoreRecord[] {
    return [...this.ensureCollection(collection).values()];
  }

  getById(collection: string, id: string): StoreRecord | null {
    return this.ensureCollection(collection).get(id) ?? null;
  }

  count(collection: string): number {
    return this.ensureCollection(collection).size;
  }

  nativeDb(): ReturnType<typeof drizzle<typeof schema>> {
    return drizzle((this.transactionClient ?? this.requireClient()) as never, { schema });
  }

  insert(collection: string, data: StoreRecord): DurableStoreRecord {
    this.assertWritableCollection(collection);
    const map = this.ensureCollection(collection);
    const now = new Date().toISOString();
    const record: StoreRecord = {
      ...data,
      id: (data.id as string | undefined) || crypto.randomUUID(),
      createdAt: (data.createdAt as string | undefined) || now,
      updatedAt: (data.updatedAt as string | undefined) || now,
    };

    const key = this.cacheKey(collection, record);
    map.set(key, record);
    return this.withWritePromise(
      record,
      this.runWrite((client) => this.persistRecord(collection, record, client)).catch((error) => {
        if (map.get(key) === record) map.delete(key);
        throw error;
      }),
    );
  }

  insertMany(collection: string, items: StoreRecord[]): DurableStoreRecord[] {
    return items.map((item) => this.insert(collection, item));
  }

  update(collection: string, id: string, data: StoreRecord): DurableStoreRecord | null {
    const map = this.ensureCollection(collection);
    const existing = map.get(id);
    if (!existing) return null;

    const updated: StoreRecord = {
      ...existing,
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    };

    map.set(id, updated);
    return this.withWritePromise(
      updated,
      this.runWrite((client) => this.persistRecord(collection, updated, client)).catch((error) => {
        if (map.get(id) === updated) map.set(id, existing);
        throw error;
      }),
    );
  }

  delete(collection: string, id: string): DurableStoreRecord | null {
    const map = this.ensureCollection(collection);
    const existing = map.get(id);
    if (!existing) return null;

    map.delete(id);
    return this.withWritePromise(
      existing,
      this.runWrite((client) => this.deleteRecord(collection, existing, client)).catch((error) => {
        if (!map.has(id)) map.set(id, existing);
        throw error;
      }),
    );
  }

  async transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.transactionClient && this.transactionScope.getStore()) {
      return operation();
    }

    return this.withTransactionLock(async () => {
      await this.flush();

      const snapshot = this.cloneCollections();
      const client = this.requireClient();
      if (!client.begin) throw new Error('SQL client does not support transactions.');

      try {
        return await client.begin(async (transactionClient: SqlClient) => {
          this.transactionClient = transactionClient;
          this.transactionWrites = [];
          try {
            return await this.transactionScope.run(true, async () => {
              const result = await operation();
              await Promise.all(this.transactionWrites ?? []);
              return result;
            });
          } finally {
            this.transactionClient = null;
            this.transactionWrites = null;
          }
        });
      } catch (error) {
        this.collections = snapshot;
        throw error;
      }
    });
  }

  async reload(): Promise<void> {
    await this.flush();
    this.collections.clear();
    await this.loadFromSql();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
    if (this.writeError) {
      const error = this.writeError;
      this.writeError = null;
      throw error;
    }
  }

  /**
   * SELECT … FOR UPDATE on all chat-queue rows for a conversation, then hydrate the cache.
   * Must run inside {@link Store.transaction}.
   */
  async lockAgentChatQueueConversation(agentId: string, conversationId: string): Promise<void> {
    if (!this.transactionClient) {
      throw new Error('lockAgentChatQueueConversation must be called inside store.transaction()');
    }
    const client = this.transactionClient;
    const rows = await client.unsafe(
      `select * from "agent_chat_queue" where "agent_id" = $1 and "conversation_id" = $2 order by "created_at" asc for update`,
      [agentId, conversationId],
    );
    const map = this.ensureCollection('agentChatQueue');
    for (const row of rows) {
      const record = this.recordFromRow('agentChatQueue', row);
      map.set(this.cacheKey('agentChatQueue', record), record);
    }
  }

  /**
   * Lock a batch run and its items (parent row first) for update, then hydrate the cache.
   * Must run inside {@link Store.transaction}.
   */
  async lockAgentBatchRunScope(runId: string): Promise<void> {
    if (!this.transactionClient) {
      throw new Error('lockAgentBatchRunScope must be called inside store.transaction()');
    }
    const client = this.transactionClient;
    const runRows = await client.unsafe(`select * from "agent_batch_runs" where "id" = $1 for update`, [
      runId,
    ]);
    const itemRows = await client.unsafe(
      `select * from "agent_batch_run_items" where "run_id" = $1 order by "order_index" asc for update`,
      [runId],
    );

    const runMap = this.ensureCollection('agentBatchRuns');
    if (runRows[0]) {
      const record = this.recordFromRow('agentBatchRuns', runRows[0]);
      runMap.set(this.cacheKey('agentBatchRuns', record), record);
    }

    const itemMap = this.ensureCollection('agentBatchRunItems');
    for (const row of itemRows) {
      const record = this.recordFromRow('agentBatchRunItems', row);
      itemMap.set(this.cacheKey('agentBatchRunItems', record), record);
    }
  }

  /**
   * Lock a single agent run row for update and hydrate the cache.
   * Must run inside {@link Store.transaction}.
   */
  async lockAgentRunRowForUpdate(runId: string): Promise<void> {
    if (!this.transactionClient) {
      throw new Error('lockAgentRunRowForUpdate must be called inside store.transaction()');
    }
    const client = this.transactionClient;
    const rows = await client.unsafe(`select * from "agent_runs" where "id" = $1 for update`, [runId]);
    const map = this.ensureCollection('agent_runs');
    if (!rows[0]) {
      map.delete(runId);
      return;
    }
    const record = this.recordFromRow('agent_runs', rows[0]);
    map.set(this.cacheKey('agent_runs', record), record);
  }

  private async loadFromSql(): Promise<void> {
    const client = this.requireClient();
    this.collections.clear();
    this.availableTables = await this.loadAvailableTables();

    for (const entry of MAPPINGS) {
      if (!this.availableTables.has(entry.table)) continue;
      const rows = await client.unsafe(`select * from "${entry.table}"`);
      const records = new Map<string, StoreRecord>();
      for (const row of rows) {
        const record = this.recordFromRow(entry.collection, row);
        records.set(this.cacheKey(entry.collection, record), record);
      }
      this.collections.set(entry.collection, records);
    }
  }

  private async loadAvailableTables(): Promise<Set<string>> {
    const rows = await this.requireClient().unsafe(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    return new Set(rows.map((row) => String(row.table_name)));
  }

  private persistRecord(
    collection: string,
    record: StoreRecord,
    client = this.requireClient(),
  ): Promise<void> {
    const entry = this.mappingForCollection(collection);
    if (!entry) {
      throw new Error(`No SQL table mapping is configured for collection "${collection}".`);
    }
    return this.persistMapped(entry, record, client);
  }

  private async persistMapped(
    entry: CollectionMapping,
    record: StoreRecord,
    client = this.requireClient(),
  ): Promise<void> {
    const row = this.rowFromRecord(entry, record);
    const columns = Object.keys(row);
    const columnSql = columns.map(quoteIdent).join(', ');
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const conflictSql = entry.primaryFields.map((field) => quoteIdent(toSnake(field))).join(', ');
    const updateColumns = columns.filter(
      (column) => !entry.primaryFields.map(toSnake).includes(column),
    );
    const updateSql = updateColumns
      .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
      .join(', ');
    const sql = `insert into ${quoteIdent(entry.table)} (${columnSql}) values (${placeholders}) on conflict (${conflictSql}) do update set ${updateSql}`;

    await client.unsafe(
      sql,
      columns.map((column) => row[column]),
    );
  }

  private deleteRecord(
    collection: string,
    record: StoreRecord,
    client = this.requireClient(),
  ): Promise<void> {
    const entry = this.mappingForCollection(collection);
    if (!entry) {
      throw new Error(`No SQL table mapping is configured for collection "${collection}".`);
    }
    const where = entry.primaryFields
      .map((field, index) => `${quoteIdent(toSnake(field))} = $${index + 1}`)
      .join(' and ');
    return client
      .unsafe(
        `delete from ${quoteIdent(entry.table)} where ${where}`,
        entry.primaryFields.map((field) => record[field]),
      )
      .then(() => undefined);
  }

  private rowFromRecord(entry: CollectionMapping, record: StoreRecord): StoreRecord {
    const row: StoreRecord = {};
    const legacyData = { ...record };
    for (const field of entry.columns) {
      const column = toSnake(field);
      if (field === 'legacyData') {
        row[column] = JSON.stringify(legacyData);
        continue;
      }
      delete legacyData[field];
      if (field in record || entry.primaryFields.includes(field)) {
        row[column] = sqlValue(field, record[field]);
      }
    }
    return row;
  }

  private recordFromRow(collection: string, row: StoreRecord): StoreRecord {
    const legacyData = normalizeJson(row.legacy_data);
    const entry = MAPPING_BY_COLLECTION.get(collection);
    const record =
      legacyData && typeof legacyData === 'object' && !Array.isArray(legacyData)
        ? ({ ...(legacyData as StoreRecord) } as StoreRecord)
        : ({ ...row } as StoreRecord);
    if (entry) {
      for (const field of entry.columns) {
        if (field === 'legacyData') continue;
        const column = toSnake(field);
        if (column in row) {
          record[field] = row[column];
        }
      }
    }

    if (!record.id) record.id = this.cacheKey(collection, record);
    return record;
  }

  private mappingForCollection(collection: string): CollectionMapping | null {
    const entry = MAPPING_BY_COLLECTION.get(collection);
    if (!entry || !this.availableTables.has(entry.table)) return null;
    return entry;
  }

  private assertWritableCollection(collection: string): void {
    if (!this.mappingForCollection(collection)) {
      throw new Error(`No SQL table mapping is configured for collection "${collection}".`);
    }
  }

  private ensureCollection(collection: string): Map<string, StoreRecord> {
    let records = this.collections.get(collection);
    if (!records) {
      records = new Map();
      this.collections.set(collection, records);
    }
    return records;
  }

  private cacheKey(collection: string, record: StoreRecord): string {
    const entry = MAPPING_BY_COLLECTION.get(collection);
    if (entry?.primaryFields.length === 2) {
      return entry.primaryFields.map((field) => String(record[field])).join(':');
    }
    return String(record.id);
  }

  private runWrite(operation: (client: SqlClient) => Promise<void>): Promise<void> {
    const transactionClient = this.transactionClient;
    if (transactionClient) {
      const write = operation(transactionClient);
      this.transactionWrites?.push(write);
      return write;
    }

    const run = this.writeQueue.then(() => operation(this.requireClient()));
    this.writeQueue = run.catch((error: unknown) => {
      this.writeError = error;
    });
    return run;
  }

  private async withTransactionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transactionQueue;
    let release!: () => void;
    this.transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private withWritePromise<T extends StoreRecord>(record: T, write: Promise<void>): T & PromiseLike<T> {
    // Mark the write as handled so an un-awaited record never crashes the
    // process. The error is still tracked by runWrite -> writeError and is
    // re-thrown to any caller that awaits the record or calls flush().
    write.catch(() => {});
    Object.defineProperty(record, 'then', {
      configurable: true,
      value: <TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) =>
        write.then(
          () => {
            const then = Object.getOwnPropertyDescriptor(record, 'then');
            delete record.then;
            try {
              return onfulfilled ? onfulfilled(record) : (record as unknown as TResult1);
            } finally {
              if (then) queueMicrotask(() => Object.defineProperty(record, 'then', then));
            }
          },
          onrejected ?? undefined,
        ),
    });
    return record as T & PromiseLike<T>;
  }

  private cloneCollections(): Map<string, Map<string, StoreRecord>> {
    const clone = new Map<string, Map<string, StoreRecord>>();
    for (const [collection, records] of this.collections) {
      clone.set(collection, new Map(records));
    }
    return clone;
  }

  private requireClient(): SqlClient {
    if (!this.client) {
      throw new Error('SQL store adapter has not been initialized. Call store.init() before use.');
    }
    return this.client;
  }
}

function mapping(
  collection: string,
  table: string,
  columns: string[],
  primaryFields = ['id'],
): CollectionMapping {
  return { collection, table, columns, primaryFields };
}

function toSnake(name: string): string {
  if (name === 'order') return 'order_index';
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlValue(field: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (field === 'metadata' && typeof value === 'string')
    return stringifyJson(parseMaybeJson(value));
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return stringifyJson(value);
  }
  return value;
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return parseMaybeJson(value);
}
