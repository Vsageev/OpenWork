// Plain TypeScript interfaces matching the Drizzle schema definitions.
// Used as the data-layer types throughout services now that Drizzle is removed.

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  type?: 'human' | 'agent';
  agentId?: string | null;
  isActive: boolean;
  totpSecret: string | null;
  totpEnabled: boolean;
  recoveryCodes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  action:
    | 'create'
    | 'update'
    | 'delete'
    | 'login'
    | 'logout'
    | 'login_failed'
    | 'export'
    | 'import'
    | 'two_factor_enabled'
    | 'two_factor_disabled'
    | 'two_factor_failed';
  entityType: string;
  entityId: string | null;
  changes: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  isGeneral?: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface Card {
  id: string;
  collectionId: string;
  name: string;
  description: string | null;
  customFields: Record<string, unknown>;
  createdById: string;
  assigneeId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CardTag {
  cardId: string;
  tagId: string;
}

export interface CardLink {
  id: string;
  sourceCardId: string;
  targetCardId: string;
  createdAt: string;
}

export interface Board {
  id: string;
  name: string;
  description: string | null;
  collectionId: string | null;
  defaultCollectionId: string | null;
  isGeneral?: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardColumn {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
  assignAgentId: string | null;
  assignAgentPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardCard {
  id: string;
  boardId: string;
  cardId: string;
  columnId: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  contactId: string;
  assigneeId: string | null;
  channelType: 'telegram' | 'internal' | 'other';
  status: 'open' | 'closed' | 'archived';
  subject: string | null;
  externalId: string | null;
  isUnread: boolean;
  lastMessageAt: string | null;
  closedAt: string | null;
  metadata: string | null;
  activeChatbotFlowId: string | null;
  chatbotFlowStepId: string | null;
  chatbotFlowData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string | null;
  direction: 'inbound' | 'outbound';
  type: 'text' | 'image' | 'video' | 'document' | 'voice' | 'sticker' | 'location' | 'system';
  content: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  externalId: string | null;
  attachments: unknown;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramBot {
  id: string;
  token: string;
  botId: string;
  botUsername: string;
  botFirstName: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
  status: 'active' | 'inactive' | 'error';
  statusMessage: string | null;
  autoGreetingEnabled: boolean;
  autoGreetingText: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Webhook {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  secret: string;
  isActive: boolean;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: unknown;
  status: 'pending' | 'success' | 'failed';
  responseStatus: number | null;
  responseBody: string | null;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  permissions: string[];
  createdById: string;
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Connector {
  id: string;
  type: 'telegram';
  name: string;
  status: 'active' | 'inactive' | 'error';
  statusMessage: string | null;
  capabilities: string[];
  integrationId: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CardComment {
  id: string;
  cardId: string;
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDraft {
  id: string;
  conversationId: string;
  content: string;
  attachments: unknown;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  userId: string;
  boardIds: string[];
  collectionIds: string[];
  agentGroupIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentAvatarPreset {
  id: string;
  name: string;
  avatarIcon: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  model: string | null;
  modelId: string | null;
  triggerType: 'chat' | 'cron_job' | 'card_assignment';
  status: 'running' | 'completed' | 'error';
  conversationId: string | null;
  cardId: string | null;
  cronJobId: string | null;
  pid: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  errorMessage: string | null;
  responseText: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}
