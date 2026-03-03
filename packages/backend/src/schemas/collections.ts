import { z } from 'zod/v4';

export const userSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    passwordHash: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    isActive: z.boolean(),
    totpSecret: z.string().nullable(),
    totpEnabled: z.boolean(),
    recoveryCodes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const auditLogSchema = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    action: z.enum([
      'create',
      'update',
      'delete',
      'login',
      'logout',
      'login_failed',
      'export',
      'import',
      'two_factor_enabled',
      'two_factor_disabled',
      'two_factor_failed',
    ]),
    entityType: z.string(),
    entityId: z.string().nullable(),
    changes: z.unknown(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough();

export const refreshTokenSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    tokenHash: z.string(),
    expiresAt: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export const tagSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export const agentBatchConfigSchema = z.object({
  agentId: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  maxParallel: z.number().int().min(1).max(20).optional(),
  cardFilters: z.object({
    search: z.string().optional(),
    assigneeId: z.string().optional(),
    completed: z.boolean().optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    tagId: z.string().optional(),
  }).optional(),
});

export const collectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isGeneral: z.boolean().optional(),
    agentBatchConfig: agentBatchConfigSchema.nullable().optional(),
    createdById: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const cardSchema = z
  .object({
    id: z.string(),
    collectionId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    customFields: z.record(z.string(), z.unknown()),
    createdById: z.string(),
    assigneeId: z.string().nullable(),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const cardTagSchema = z
  .object({
    cardId: z.string(),
    tagId: z.string(),
  })
  .passthrough();

export const cardLinkSchema = z
  .object({
    id: z.string(),
    sourceCardId: z.string(),
    targetCardId: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export const boardSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    collectionId: z.string().nullable(),
    isGeneral: z.boolean().optional(),
    createdById: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const boardColumnSchema = z
  .object({
    id: z.string(),
    boardId: z.string(),
    name: z.string(),
    color: z.string(),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const boardCardSchema = z
  .object({
    id: z.string(),
    boardId: z.string(),
    cardId: z.string(),
    columnId: z.string(),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const conversationSchema = z
  .object({
    id: z.string(),
    contactId: z.string(),
    assigneeId: z.string().nullable(),
    channelType: z.enum(['telegram', 'internal', 'other', 'agent', 'email', 'web_chat']),
    status: z.enum(['open', 'closed', 'archived']),
    subject: z.string().nullable(),
    externalId: z.string().nullable(),
    isUnread: z.boolean(),
    lastMessageAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    metadata: z.string().nullable(),
    activeChatbotFlowId: z.string().nullable(),
    chatbotFlowStepId: z.string().nullable(),
    chatbotFlowData: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const messageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    senderId: z.string().nullable(),
    direction: z.enum(['inbound', 'outbound']),
    type: z.enum(['text', 'image', 'video', 'document', 'voice', 'sticker', 'location', 'system']),
    content: z.string().nullable(),
    status: z.enum(['pending', 'sent', 'delivered', 'read', 'failed']),
    externalId: z.string().nullable(),
    attachments: z.unknown(),
    metadata: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const telegramBotSchema = z
  .object({
    id: z.string(),
    token: z.string(),
    botId: z.string(),
    botUsername: z.string(),
    botFirstName: z.string(),
    webhookUrl: z.string().nullable(),
    webhookSecret: z.string().nullable(),
    status: z.enum(['active', 'inactive', 'error']),
    statusMessage: z.string().nullable(),
    autoGreetingEnabled: z.boolean(),
    autoGreetingText: z.string().nullable(),
    createdById: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const webhookSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(z.string()),
    secret: z.string(),
    isActive: z.boolean(),
    createdById: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const webhookDeliverySchema = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    event: z.string(),
    payload: z.unknown(),
    status: z.enum(['pending', 'success', 'failed']),
    responseStatus: z.number().nullable(),
    responseBody: z.string().nullable(),
    attempt: z.number(),
    maxAttempts: z.number(),
    nextRetryAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .passthrough();

export const apiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    keyHash: z.string(),
    keyPrefix: z.string(),
    permissions: z.array(z.string()),
    createdById: z.string(),
    isActive: z.boolean(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    description: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const connectorSchema = z
  .object({
    id: z.string(),
    type: z.enum(['telegram']),
    name: z.string(),
    status: z.enum(['active', 'inactive', 'error']),
    statusMessage: z.string().nullable(),
    capabilities: z.array(z.string()),
    integrationId: z.string(),
    config: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const cardCommentSchema = z
  .object({
    id: z.string(),
    cardId: z.string(),
    authorId: z.string(),
    content: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const messageDraftSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    content: z.string(),
    attachments: z.unknown(),
    metadata: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const agentRunSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    triggerType: z.enum(['chat', 'cron', 'card']),
    status: z.enum(['running', 'completed', 'error']),
    conversationId: z.string().nullable(),
    cardId: z.string().nullable(),
    cronJobId: z.string().nullable(),
    errorMessage: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/**
 * Map of collection names to their Zod schemas.
 * Collections not in this map are skipped during validation (forward compat).
 */
export const collectionSchemas: Record<string, z.ZodType> = {
  users: userSchema,
  audit_logs: auditLogSchema,
  refresh_tokens: refreshTokenSchema,
  tags: tagSchema,
  collections: collectionSchema,
  cards: cardSchema,
  card_tags: cardTagSchema,
  card_links: cardLinkSchema,
  boards: boardSchema,
  board_columns: boardColumnSchema,
  board_cards: boardCardSchema,
  conversations: conversationSchema,
  messages: messageSchema,
  telegram_bots: telegramBotSchema,
  webhooks: webhookSchema,
  webhook_deliveries: webhookDeliverySchema,
  api_keys: apiKeySchema,
  connectors: connectorSchema,
  card_comments: cardCommentSchema,
  message_drafts: messageDraftSchema,
  agent_runs: agentRunSchema,
};
