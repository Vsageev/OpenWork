import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
};

const optionalTimestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
};

const legacyPayload = {
  legacyData: jsonb('legacy_data').notNull(),
};

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    type: text('type'),
    agentId: text('agent_id'),
    isActive: boolean('is_active').notNull(),
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull(),
    recoveryCodes: text('recovery_codes'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    uniqueIndex('users_email_idx').on(table.email),
    index('users_agent_id_idx').on(table.agentId),
  ],
);

export const agentGroups = pgTable('agent_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  order: integer('order_index'),
  ...timestamps,
  ...legacyPayload,
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    permissions: jsonb('permissions').notNull(),
    createdById: text('created_by_id').references(() => users.id),
    isActive: boolean('is_active').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    description: text('description'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    uniqueIndex('api_keys_key_hash_idx').on(table.keyHash),
    index('api_keys_created_by_id_idx').on(table.createdById),
  ],
);

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    model: text('model'),
    modelId: text('model_id'),
    thinkingLevel: text('thinking_level'),
    preset: text('preset'),
    presetParameters: jsonb('preset_parameters'),
    status: text('status').notNull(),
    apiKeyId: text('api_key_id').references(() => apiKeys.id),
    apiKeyName: text('api_key_name'),
    apiKeyPrefix: text('api_key_prefix'),
    workspaceApiKey: text('workspace_api_key'),
    workspaceApiKeyId: text('workspace_api_key_id').references(() => apiKeys.id),
    capabilities: jsonb('capabilities'),
    skipPermissions: boolean('skip_permissions'),
    groupId: text('group_id').references(() => agentGroups.id),
    serviceUserId: text('service_user_id').references(() => users.id),
    repositoryRoot: text('repository_root'),
    workspacePath: text('workspace_path'),
    separateFolderPerChat: boolean('separate_folder_per_chat'),
    skillIds: jsonb('skill_ids'),
    cronJobs: jsonb('cron_jobs'),
    avatarIcon: text('avatar_icon'),
    avatarBgColor: text('avatar_bg_color'),
    avatarLogoColor: text('avatar_logo_color'),
    lastActivity: timestamp('last_activity', { withTimezone: true }),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('agents_api_key_id_idx').on(table.apiKeyId),
    index('agents_group_id_idx').on(table.groupId),
    index('agents_service_user_id_idx').on(table.serviceUserId),
  ],
);

export const agentAvatarPresets = pgTable('agent_avatar_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatarIcon: text('avatar_icon').notNull(),
  ...timestamps,
  ...legacyPayload,
});

export const agentColorPresets = pgTable('agent_color_presets', {
  id: text('id').primaryKey(),
  name: text('name'),
  color: text('color'),
  ...optionalTimestamps,
  ...legacyPayload,
});

export const agentEnvVars = pgTable(
  'agent_env_vars',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    key: text('key').notNull(),
    description: text('description'),
    encryptedValue: text('encrypted_value').notNull(),
    valuePreview: text('value_preview'),
    isActive: boolean('is_active').notNull(),
    createdById: text('created_by_id').references(() => users.id),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    uniqueIndex('agent_env_vars_agent_key_idx').on(table.agentId, table.key),
    index('agent_env_vars_created_by_id_idx').on(table.createdById),
  ],
);

export const agentExternalApiKeys = pgTable('agent_external_api_keys', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').references(() => agents.id),
  provider: text('provider'),
  keyHash: text('key_hash'),
  keyPrefix: text('key_prefix'),
  encryptedValue: text('encrypted_value'),
  metadata: jsonb('metadata'),
  ...optionalTimestamps,
  ...legacyPayload,
});

export const collections = pgTable(
  'collections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    isGeneral: boolean('is_general'),
    agentBatchConfig: jsonb('agent_batch_config'),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [index('collections_created_by_id_idx').on(table.createdById)],
);

export const boards = pgTable(
  'boards',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    collectionId: text('collection_id').references(() => collections.id),
    defaultCollectionId: text('default_collection_id').references(() => collections.id),
    isGeneral: boolean('is_general'),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('boards_collection_id_idx').on(table.collectionId),
    index('boards_default_collection_id_idx').on(table.defaultCollectionId),
    index('boards_created_by_id_idx').on(table.createdById),
  ],
);

export const boardColumns = pgTable(
  'board_columns',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    name: text('name').notNull(),
    color: text('color').notNull(),
    position: doublePrecision('position').notNull(),
    wipLimit: integer('wip_limit'),
    assignAgentId: text('assign_agent_id').references(() => agents.id),
    assignAgentPrompt: text('assign_agent_prompt'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('board_columns_board_id_idx').on(table.boardId),
    index('board_columns_assign_agent_id_idx').on(table.assignAgentId),
  ],
);

export const cards = pgTable(
  'cards',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id),
    name: text('name').notNull(),
    description: text('description'),
    customFields: jsonb('custom_fields').notNull(),
    createdById: text('created_by_id').references(() => users.id),
    assigneeId: text('assignee_id'),
    position: doublePrecision('position').notNull(),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('cards_collection_id_idx').on(table.collectionId),
    index('cards_created_by_id_idx').on(table.createdById),
    index('cards_assignee_id_idx').on(table.assigneeId),
    index('cards_collection_position_idx').on(table.collectionId, table.position),
  ],
);

export const boardCards = pgTable(
  'board_cards',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    columnId: text('column_id')
      .notNull()
      .references(() => boardColumns.id),
    position: doublePrecision('position').notNull(),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    uniqueIndex('board_cards_board_card_idx').on(table.boardId, table.cardId),
    index('board_cards_card_id_idx').on(table.cardId),
    index('board_cards_column_id_idx').on(table.columnId),
    index('board_cards_board_position_idx').on(table.boardId, table.position),
  ],
);

export const tags = pgTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  ...legacyPayload,
});

export const cardTags = pgTable(
  'card_tags',
  {
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id),
    legacyData: jsonb('legacy_data').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.cardId, table.tagId] }),
    index('card_tags_tag_id_idx').on(table.tagId),
  ],
);

export const cardLinks = pgTable(
  'card_links',
  {
    id: text('id').primaryKey(),
    sourceCardId: text('source_card_id')
      .notNull()
      .references(() => cards.id),
    targetCardId: text('target_card_id')
      .notNull()
      .references(() => cards.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    ...legacyPayload,
  },
  (table) => [
    index('card_links_source_card_id_idx').on(table.sourceCardId),
    index('card_links_target_card_id_idx').on(table.targetCardId),
  ],
);

export const cardComments = pgTable(
  'card_comments',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    authorId: text('author_id').notNull(),
    agentRunId: text('agent_run_id'),
    content: text('content').notNull(),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('card_comments_card_id_idx').on(table.cardId),
    index('card_comments_author_id_idx').on(table.authorId),
    index('card_comments_agent_run_id_idx').on(table.agentRunId),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    source: text('source'),
    telegramId: text('telegram_id'),
    notes: text('notes'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [index('contacts_telegram_id_idx').on(table.telegramId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    assigneeId: text('assignee_id').references(() => users.id),
    channelType: text('channel_type').notNull(),
    status: text('status').notNull(),
    subject: text('subject'),
    externalId: text('external_id'),
    isUnread: boolean('is_unread').notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    provider: text('provider'),
    modelId: text('model_id'),
    activeChatbotFlowId: text('active_chatbot_flow_id'),
    chatbotFlowStepId: text('chatbot_flow_step_id'),
    chatbotFlowData: jsonb('chatbot_flow_data'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('conversations_assignee_last_msg_idx').on(table.assigneeId, table.lastMessageAt),
    uniqueIndex('conversations_channel_external_uidx')
      .on(table.channelType, table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    senderId: text('sender_id'),
    direction: text('direction').notNull(),
    type: text('type').notNull(),
    content: text('content'),
    status: text('status').notNull(),
    externalId: text('external_id'),
    parentId: text('parent_id'),
    previousUserMessageId: text('previous_user_message_id'),
    attachments: jsonb('attachments'),
    metadata: jsonb('metadata'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('messages_conversation_id_idx').on(table.conversationId),
    index('messages_conv_created_idx').on(table.conversationId, table.createdAt),
    index('messages_parent_id_idx').on(table.parentId),
    index('messages_previous_user_message_id_idx').on(table.previousUserMessageId),
    index('messages_external_id_idx')
      .on(table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

export const messageDrafts = pgTable(
  'message_drafts',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    content: text('content').notNull(),
    attachments: jsonb('attachments'),
    metadata: jsonb('metadata'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [index('message_drafts_conversation_id_idx').on(table.conversationId)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    boardIds: jsonb('board_ids').notNull(),
    collectionIds: jsonb('collection_ids').notNull(),
    agentGroupIds: jsonb('agent_group_ids').notNull(),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [index('workspaces_user_id_idx').on(table.userId)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    ...legacyPayload,
  },
  (table) => [index('refresh_tokens_user_id_idx').on(table.userId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    changes: jsonb('changes'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    ...legacyPayload,
  },
  (table) => [index('audit_logs_user_id_idx').on(table.userId)],
);

export const telegramBots = pgTable(
  'telegram_bots',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull(),
    botId: text('bot_id').notNull(),
    botUsername: text('bot_username').notNull(),
    botFirstName: text('bot_first_name').notNull(),
    webhookUrl: text('webhook_url'),
    webhookSecret: text('webhook_secret'),
    status: text('status').notNull(),
    statusMessage: text('status_message'),
    autoGreetingEnabled: boolean('auto_greeting_enabled').notNull(),
    autoGreetingText: text('auto_greeting_text'),
    createdById: text('created_by_id').references(() => users.id),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [index('telegram_bots_created_by_id_idx').on(table.createdById)],
);

export const connectors = pgTable('connectors', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  statusMessage: text('status_message'),
  capabilities: jsonb('capabilities').notNull(),
  integrationId: text('integration_id').notNull(),
  config: jsonb('config').notNull(),
  ...timestamps,
  ...legacyPayload,
});

export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    description: text('description'),
    events: jsonb('events').notNull(),
    secret: text('secret').notNull(),
    isActive: boolean('is_active').notNull(),
    createdById: text('created_by_id').references(() => users.id),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [index('webhooks_created_by_id_idx').on(table.createdById)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    attempt: integer('attempt').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...legacyPayload,
  },
  (table) => [index('webhook_deliveries_webhook_id_idx').on(table.webhookId)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    agentName: text('agent_name').notNull(),
    model: text('model'),
    modelId: text('model_id'),
    triggerType: text('trigger_type').notNull(),
    triggerPrompt: text('trigger_prompt'),
    status: text('status').notNull(),
    conversationId: text('conversation_id').references(() => conversations.id),
    cardId: text('card_id').references(() => cards.id),
    cronJobId: text('cron_job_id'),
    executor: text('executor').notNull().default('remote'),
    pid: integer('pid'),
    stdoutPath: text('stdout_path'),
    stderrPath: text('stderr_path'),
    stdout: text('stdout'),
    stderr: text('stderr'),
    errorMessage: text('error_message'),
    responseText: text('response_text'),
    responseParentId: text('response_parent_id'),
    turnId: text('turn_id'),
    killedByUser: boolean('killed_by_user'),
    avatarIcon: text('avatar_icon'),
    avatarBgColor: text('avatar_bg_color'),
    avatarLogoColor: text('avatar_logo_color'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('agent_runs_agent_id_idx').on(table.agentId),
    index('agent_runs_conversation_id_idx').on(table.conversationId),
    index('agent_runs_card_id_idx').on(table.cardId),
    index('agent_runs_status_agent_started_idx').on(table.status, table.agentId, table.startedAt),
    index('agent_runs_conv_status_idx').on(table.conversationId, table.status),
    index('agent_runs_turn_id_idx').on(table.turnId),
    index('agent_runs_live_chat_idx')
      .on(table.agentId, table.conversationId)
      .where(sql`${table.status} = 'running' AND ${table.triggerType} = 'chat'`),
  ],
);

export const agentChatTurns = pgTable(
  'agent_chat_turns',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    parentTurnId: text('parent_turn_id'),
    userMessageId: text('user_message_id').references(() => messages.id),
    assistantMessageId: text('assistant_message_id').references(() => messages.id),
    status: text('status').notNull(),
    runId: text('run_id').references(() => agentRuns.id),
    source: text('source').notNull(),
    createdById: text('created_by_id').references(() => users.id),
    turnType: text('turn_type').notNull(),
    supersedesTurnId: text('supersedes_turn_id'),
    metadata: jsonb('metadata').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('agent_chat_turns_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('agent_chat_turns_agent_conversation_idx').on(table.agentId, table.conversationId),
    index('agent_chat_turns_parent_turn_idx').on(table.parentTurnId),
    index('agent_chat_turns_user_message_idx').on(table.userMessageId),
    index('agent_chat_turns_assistant_message_idx').on(table.assistantMessageId),
    index('agent_chat_turns_run_idx').on(table.runId),
    index('agent_chat_turns_supersedes_idx').on(table.supersedesTurnId),
    index('agent_chat_turns_status_idx').on(table.status),
  ],
);

export const agentRunnerTokens = pgTable(
  'agent_runner_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    uniqueIndex('agent_runner_tokens_hash_idx').on(table.tokenHash),
    index('agent_runner_tokens_user_id_idx').on(table.userId),
  ],
);

export const agentRunners = pgTable(
  'agent_runners',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    displayName: text('display_name').notNull(),
    credentialHash: text('credential_hash').notNull(),
    credentialPrefix: text('credential_prefix').notNull(),
    status: text('status').notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    version: text('version'),
    capabilities: jsonb('capabilities').notNull().default({}),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    uniqueIndex('agent_runners_credential_hash_idx').on(table.credentialHash),
    index('agent_runners_user_workspace_idx').on(table.userId, table.workspaceId),
  ],
);

export const agentRunnerPairingCodes = pgTable(
  'agent_runner_pairing_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    codeHash: text('code_hash').notNull(),
    displayName: text('display_name').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    uniqueIndex('agent_runner_pairing_codes_hash_idx').on(table.codeHash),
    index('agent_runner_pairing_codes_user_workspace_idx').on(table.userId, table.workspaceId),
  ],
);

export const agentChatQueue = pgTable(
  'agent_chat_queue',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    mode: text('mode').notNull(),
    prompt: text('prompt'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    turnId: text('turn_id').references(() => agentChatTurns.id),
    runId: text('run_id'),
    lastRunId: text('last_run_id').references(() => agentRuns.id),
    targetMessageId: text('target_message_id'),
    continuationParentId: text('continuation_parent_id'),
    dependsOnQueueItemId: text('depends_on_queue_item_id'),
    previousUserMessageId: text('previous_user_message_id'),
    queuedMessageId: text('queued_message_id'),
    responseMessageId: text('response_message_id'),
    errorMessage: text('error_message'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    usedFallback: boolean('used_fallback'),
    fallbackModel: text('fallback_model'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('agent_chat_queue_agent_id_idx').on(table.agentId),
    index('agent_chat_queue_conversation_id_idx').on(table.conversationId),
    index('agent_chat_queue_status_idx').on(table.status),
    index('agent_chat_queue_turn_id_idx').on(table.turnId),
    index('agent_chat_queue_agent_conv_created_idx').on(
      table.agentId,
      table.conversationId,
      table.createdAt,
    ),
    index('agent_chat_queue_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('agent_chat_queue_run_processing_idx')
      .on(table.runId)
      .where(sql`${table.status} = 'processing' and ${table.runId} is not null`),
  ],
);

export const agentBatchRuns = pgTable(
  'agent_batch_runs',
  {
    id: text('id').primaryKey(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceName: text('source_name'),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    prompt: text('prompt').notNull(),
    maxParallel: integer('max_parallel').notNull(),
    status: text('status').notNull(),
    total: integer('total').notNull(),
    queued: integer('queued').notNull(),
    processing: integer('processing').notNull(),
    completed: integer('completed').notNull(),
    failed: integer('failed').notNull(),
    cancelled: integer('cancelled').notNull(),
    skipped: integer('skipped'),
    stageCount: integer('stage_count'),
    dependencyItemCount: integer('dependency_item_count'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('agent_batch_runs_agent_id_idx').on(table.agentId),
    index('agent_batch_runs_source_idx').on(table.sourceType, table.sourceId),
  ],
);

export const agentBatchRunItems = pgTable(
  'agent_batch_run_items',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentBatchRuns.id),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    cardName: text('card_name').notNull(),
    cardDescription: text('card_description'),
    cardCollectionId: text('card_collection_id')
      .notNull()
      .references(() => collections.id),
    order: integer('order_index').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    agentRunId: text('agent_run_id').references(() => agentRuns.id),
    stageId: text('stage_id'),
    dependsOnItemIds: jsonb('depends_on_item_ids'),
    blockingMode: text('blocking_mode'),
    ...timestamps,
    ...legacyPayload,
  },
  (table) => [
    index('agent_batch_run_items_run_id_idx').on(table.runId),
    index('agent_batch_run_items_card_id_idx').on(table.cardId),
    index('agent_batch_run_items_agent_run_id_idx').on(table.agentRunId),
    index('agent_batch_run_items_run_status_idx').on(table.runId, table.status),
  ],
);

export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  ...timestamps,
  ...legacyPayload,
});

export const settings = pgTable('settings', {
  id: text('id').primaryKey(),
  defaultAgentKeyId: text('default_agent_key_id').references(() => apiKeys.id),
  fallbackModel: text('fallback_model'),
  fallbackModelId: text('fallback_model_id'),
  agentPromptMax: integer('agent_prompt_max'),
  agentPromptWindowS: integer('agent_prompt_window_s'),
  ...timestamps,
  ...legacyPayload,
});

export const migrations = pgTable('json_migrations', {
  id: text('id').primaryKey(),
  ...timestamps,
  ...legacyPayload,
});

export const boardCronTemplates = pgTable('board_cron_templates', {
  id: text('id').primaryKey(),
  boardId: text('board_id').references(() => boards.id),
  agentId: text('agent_id').references(() => agents.id),
  schedule: text('schedule'),
  prompt: text('prompt'),
  config: jsonb('config'),
  ...optionalTimestamps,
  ...legacyPayload,
});

export const mediaObjects = pgTable('media_objects', {
  id: text('id').primaryKey(),
  storagePath: text('storage_path').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mime_type'),
  checksum: text('checksum'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  legacyData: jsonb('legacy_data').notNull(),
});

export const backupManifests = pgTable('backup_manifests', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  storagePath: text('storage_path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  legacyData: jsonb('legacy_data').notNull(),
});
