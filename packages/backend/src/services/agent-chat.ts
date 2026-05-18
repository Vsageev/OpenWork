import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../db/index.js';
import {
  AGENT_CHAT_QUEUE_COLLECTION,
  clearAgentRunConversationReferences,
  countQueuedAppendPromptsForConversation,
  deleteChatQueueItemsForConversation,
  deleteTerminalChatQueueItemsBeyondRetention,
  findChatQueueItemProcessingForRunId,
  findLivePersistedChatRuns,
  listChatQueueItemsWithStatusNative,
  listConversationChatQueueItems,
} from '../db/repositories/agent-execution-repository.js';
import { deleteAllMessageDraftsForConversation } from '../db/repositories/message-drafts-repository.js';
import {
  compareMessagesChronologically,
  deleteAllMessagesForConversation,
  listMessagesByConversationId,
} from '../db/repositories/messages-repository.js';
import { getApiKeyRecord } from '../db/repositories/api-keys-repository.js';
import { env } from '../config/env.js';
import { extractFinalResponseText } from '../lib/agent-output.js';
import { allocatePort, releasePort } from '../lib/port-allocator.js';
import type { RunnerAttachment, RunnerJobIntent, RunnerProvider } from 'shared';
import {
  dispatchRemoteAgentJob,
  getRemoteAgentRunnerUnavailableMessage,
  hasAvailableRemoteAgentRunner,
  hasConnectedRemoteAgentRunner,
  RemoteAgentJobError,
} from './agent-runners.js';
import { getAgent, listAgents, prepareAgentWorkspaceAccess } from './agents.js';
import { runnerRoutingScopesForAgentGroup } from './runner-devices.js';
import {
  ensureConversationSubfolderWorkspace,
  resolveAgentExecutionRootFromRecord,
  resolveAgentWorkspacePathFromRecord,
  resolveSubfolderProcessCwd,
} from './agent-workspaces.js';
import { listRuntimeAgentEnvVarBindings } from './agent-env-vars.js';
import {
  createAgentRun,
  completeAgentRun,
  failAgentRunCompletionSideEffect,
  getAgentRun,
} from './agent-runs.js';
import {
  createAgentChatTurn,
  findAgentChatTurnForUserMessage,
  getAgentChatTurn,
  listAgentChatTurns,
  markAgentChatTurnCompleted,
  markAgentChatTurnFailed,
  markAgentChatTurnQueued,
  markAgentChatTurnRunning,
  markAgentChatTurnStopped,
  updateAgentChatTurn,
  type AgentChatTurnType,
} from './agent-chat-turns.js';
import { getFallbackModelConfig } from './project-settings.js';

const STORAGE_DIR = path.resolve(env.DATA_DIR, 'storage');

export const RUNS_DIR = path.resolve(env.DATA_DIR, 'agent-runs');
const AGENT_CHAT_QUEUE_RETRY_BASE_MS = 1000;
const AGENT_CHAT_QUEUE_RETRY_MAX_MS = 30000;
const AGENT_CHAT_QUEUE_DEFAULT_MAX_ATTEMPTS = 4;
const OPENWORK_CHILD_ENV_BLOCKLIST = new Set([
  'BACKUP_CRON',
  'BACKUP_DIR',
  'BACKUP_ENABLED',
  'BACKUP_RETENTION_DAYS',
  'BODY_LIMIT_BYTES',
  'CORS_ORIGIN',
  'DATA_DIR',
  'EMAIL_SYNC_CRON',
  'EMAIL_SYNC_ENABLED',
  'HOST',
  'INSTAGRAM_APP_SECRET',
  'INSTAGRAM_WEBHOOK_BASE_URL',
  'JWT_ACCESS_EXPIRES_IN',
  'JWT_REFRESH_EXPIRES_IN',
  'JWT_SECRET',
  'MAX_CONCURRENT_AGENTS',
  'PORT',
  'PROJECTS_DIR',
  'PROJECT_PORT',
  'RATE_LIMIT_AGENT_PROMPT_MAX',
  'RATE_LIMIT_AGENT_PROMPT_WINDOW_S',
  'RATE_LIMIT_API_MAX',
  'RATE_LIMIT_API_WINDOW_MS',
  'RATE_LIMIT_AUTH_MAX',
  'RATE_LIMIT_AUTH_WINDOW_MS',
  'RATE_LIMIT_GLOBAL_MAX',
  'RATE_LIMIT_GLOBAL_WINDOW_MS',
  'SECRET_ENCRYPTION_KEY',
  'TELEGRAM_MANAGED_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_BASE_URL',
  'TLS_CERT_PATH',
  'TLS_KEY_PATH',
  'TRUST_PROXY',
  'UPLOAD_DIR',
  'WHATSAPP_WEBHOOK_BASE_URL',
  'WORKSPACE_API_KEY',
  'WORKSPACE_API_URL',
]);

interface AgentChatErrorOptions {
  code: string;
  statusCode: 400 | 404 | 409;
  message: string;
  hint?: string;
}

export class AgentChatError extends Error {
  readonly code: string;
  readonly statusCode: 400 | 404 | 409;
  readonly hint?: string;

  constructor(options: AgentChatErrorOptions) {
    super(options.message);
    this.name = 'AgentChatError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.hint = options.hint;
  }

  static badRequest(code: string, message: string, hint?: string) {
    return new AgentChatError({ code, statusCode: 400, message, hint });
  }

  static notFound(code: string, message: string, hint?: string) {
    return new AgentChatError({ code, statusCode: 404, message, hint });
  }

  static conflict(code: string, message: string, hint?: string) {
    return new AgentChatError({ code, statusCode: 409, message, hint });
  }
}

// ---------------------------------------------------------------------------
// Global agent concurrency limiter
// ---------------------------------------------------------------------------

/** Patterns that indicate external API rate limiting in agent stderr output */
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /overloaded/i,
  /capacity/i,
  /retry.?after/i,
  /throttl/i,
];

function isRateLimitError(stderr: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(stderr));
}

const PERMANENT_QUEUE_ERROR_PATTERNS = [
  /CLI is not installed or not available on the server PATH/i,
  /Command ".+" is not installed or not available on the server PATH/i,
  /spawn .+ ENOENT/i,
  /Queued execution item is missing its durable turn/i,
  /Queued execution item references a terminal or superseded turn/i,
];

function isPermanentQueueError(errorMessage: string): boolean {
  return PERMANENT_QUEUE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

const CHAT_ERROR_SUMMARY_MAX_LENGTH = 240;

function summarizeQueueErrorForChat(errorMessage: string): string {
  const trimmed = errorMessage.trim();
  if (!trimmed) return 'Run failed';

  const firstNonEmptyLine =
    trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? trimmed;

  const compactLine = firstNonEmptyLine.replace(/\s+/g, ' ').trim();
  if (compactLine.length <= CHAT_ERROR_SUMMARY_MAX_LENGTH) {
    return compactLine;
  }

  return `${compactLine.slice(0, CHAT_ERROR_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Global concurrency gate — tracks how many remote runner jobs are running
 * across all conversations. When at capacity, new runs are deferred until a
 * slot opens up.
 */
let globalRunningCount = 0;
const concurrencyWaiters: Array<() => void> = [];

function getMaxConcurrentAgents(): number {
  if (env.MAX_CONCURRENT_AGENTS === 0) return Number.MAX_SAFE_INTEGER;
  return env.MAX_CONCURRENT_AGENTS;
}

function acquireConcurrencySlot(): boolean {
  if (globalRunningCount < getMaxConcurrentAgents()) {
    globalRunningCount++;
    return true;
  }
  return false;
}

function waitForConcurrencySlot(): Promise<void> {
  if (acquireConcurrencySlot()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    concurrencyWaiters.push(() => {
      globalRunningCount++;
      resolve();
    });
  });
}

function releaseConcurrencySlot() {
  globalRunningCount--;
  if (globalRunningCount < 0) globalRunningCount = 0;
  // Wake the next waiter if there's capacity
  while (concurrencyWaiters.length > 0 && globalRunningCount < getMaxConcurrentAgents()) {
    const waiter = concurrencyWaiters.shift();
    if (waiter) {
      waiter();
    }
  }
}

/** Backoff delay (ms) when a run fails due to rate limiting */
function rateLimitBackoffMs(attempt: number): number {
  // 5s, 15s, 30s, 60s — longer than normal retries since rate limits need real cooldown
  const base = 5000;
  const delay = Math.min(base * Math.pow(2, attempt), 60000);
  // Add jitter (±25%)
  return delay * (0.75 + Math.random() * 0.5);
}

export function getGlobalRunningAgentCount(): number {
  return globalRunningCount;
}

export function getMaxConcurrentAgentLimit(): number {
  return getMaxConcurrentAgents();
}
const AGENT_CHAT_QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CHAT_MESSAGE_IMAGES = 10;

interface QueueDrainTimer {
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
}

type TreePathMessage = Record<string, unknown> & {
  _siblingIndex?: number;
  _siblingCount?: number;
  _siblingIds?: string[];
};

type QueueExecutionMode = 'append_prompt' | 'respond_to_message';

const ROOT_BRANCH_KEY = '__root__';

function inferRunnerProvider(model: string): RunnerProvider | null {
  const modelLower = model.trim().toLowerCase();
  if (modelLower.includes('claude')) return 'claude';
  if (modelLower.includes('codex')) return 'codex';
  if (modelLower.includes('qwen')) return 'qwen';
  if (modelLower.includes('cursor')) return 'cursor';
  if (modelLower.includes('opencode')) return 'opencode';
  return null;
}

function getFileSizeBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function inferAttachmentMimeType(filePath: string, fallback = 'application/octet-stream'): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
  };
  return mimeTypes[ext] ?? fallback;
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript'
  );
}

function createRunnerAttachmentFromPath(
  type: RunnerAttachment['type'],
  attachmentPath: string,
  source?: {
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
    manifest?: Record<string, unknown>;
  },
): RunnerAttachment {
  const mimeType = source?.mimeType ?? inferAttachmentMimeType(attachmentPath);
  return {
    type,
    path: attachmentPath,
    filename: source?.filename ?? path.basename(attachmentPath),
    mimeType,
    sizeBytes: source?.sizeBytes ?? getFileSizeBytes(attachmentPath),
    textExtraction: {
      status: isTextLikeMimeType(mimeType) ? 'available' : 'not_applicable',
      ...(isTextLikeMimeType(mimeType) ? { textPath: attachmentPath } : {}),
    },
    ...(source?.manifest ? { manifest: source.manifest } : {}),
  };
}

export function buildRunnerJobIntent(params: {
  runId: string;
  agentId: string;
  workspaceId: string;
  agent: AgentProcessOptions['agent'];
  prompt: string;
  workDir: string;
  childEnv: Record<string, string | undefined>;
  attachments?: RunnerAttachment[];
  imagePaths?: string[];
  filePaths?: string[];
}): RunnerJobIntent {
  const provider = inferRunnerProvider(params.agent.model);
  if (!provider) {
    throw new Error(`Unsupported remote runner model/provider: ${params.agent.model}`);
  }

  return {
    runId: params.runId,
    agentId: params.agentId,
    agentKind: 'dev_agent',
    provider,
    modelPreference: {
      displayName: params.agent.model,
      modelId: params.agent.modelId,
      thinkingLevel: params.agent.thinkingLevel,
    },
    prompt: params.prompt,
    workspace: {
      type: 'local_path',
      path: params.workDir,
      workspaceId: params.workspaceId,
    },
    attachments: params.attachments ?? [
      ...(params.imagePaths ?? []).map((attachmentPath) =>
        createRunnerAttachmentFromPath('image', attachmentPath),
      ),
      ...(params.filePaths ?? []).map((attachmentPath) =>
        createRunnerAttachmentFromPath('file', attachmentPath),
      ),
    ],
    allowedOperations: {
      tools: [provider],
      approvalMode: 'dangerous',
      env: true,
      secrets: true,
      network: true,
      shell: true,
    },
    environment: {
      variables: Object.entries(params.childEnv)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, value]) => ({
          name,
          value,
          source: 'runtime',
          secret: true,
        })),
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    return null;
  }
}

export type ConversationWorkspaceMode = 'shared' | 'subfolder';

/**
 * Exposes workspace fields for API clients. Conversations without persisted workspace metadata
 * are treated as shared (legacy and default).
 */
export function parseConversationWorkspaceFields(raw: unknown): {
  workspaceMode: ConversationWorkspaceMode;
  workspaceRelativePath?: string;
  workspaceSeedMode?: string;
} {
  const meta = parseMetadata(raw);
  if (meta?.workspaceMode === 'subfolder') {
    return {
      workspaceMode: 'subfolder',
      workspaceRelativePath:
        typeof meta.workspaceRelativePath === 'string' ? meta.workspaceRelativePath : undefined,
      workspaceSeedMode:
        typeof meta.workspaceSeedMode === 'string' ? meta.workspaceSeedMode : 'symlink',
    };
  }
  return { workspaceMode: 'shared' };
}

function ensureConversationWorkspaceMetadata(
  agentId: string,
  conversation: Record<string, unknown> | null | undefined,
): {
  workspaceMode: ConversationWorkspaceMode;
  workspaceRelativePath?: string;
  workspaceSeedMode?: string;
} {
  const parsed = parseConversationWorkspaceFields(conversation?.metadata);
  if (!conversation || typeof conversation.id !== 'string') return parsed;
  if (parsed.workspaceMode === 'subfolder') return parsed;

  const agent = getAgent(agentId);
  if (agent?.separateFolderPerChat !== true) return parsed;

  const meta = parseMetadata(conversation.metadata) ?? {};
  const nextMeta = {
    ...meta,
    agentId,
    workspaceMode: 'subfolder',
    workspaceRelativePath: `conversations/${conversation.id}`,
    workspaceSeedMode: 'symlink',
  };
  store.update('conversations', conversation.id, { metadata: JSON.stringify(nextMeta) });
  return parseConversationWorkspaceFields(nextMeta);
}

function isBackgroundTriggerConversationRecord(r: Record<string, unknown>): boolean {
  const meta = parseMetadata(r.metadata);
  if (!meta) return false;

  if (typeof meta.cronJobId === 'string' && meta.cronJobId.length > 0) return true;
  if (typeof meta.cardId === 'string' && meta.cardId.length > 0) return true;

  const trigger = typeof meta.trigger === 'string' ? meta.trigger : null;

  return trigger === 'cron_job' || trigger === 'card_assignment';
}

function isAgentConversation(r: Record<string, unknown>, agentId: string): boolean {
  if (r.channelType !== 'agent') return false;
  const meta = parseMetadata(r.metadata);
  return meta?.agentId === agentId;
}

/**
 * List all conversations belonging to an agent, sorted by lastMessageAt desc.
 */
export function listAgentConversations(agentId: string, limit = 50, offset = 0) {
  const all = store
    .getAll('conversations')
    .filter(
      (r: Record<string, unknown>) =>
        isAgentConversation(r, agentId) && !isBackgroundTriggerConversationRecord(r),
    );

  const sorted = all.sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt as string).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt as string).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime();
  });

  const entries = sorted.slice(offset, offset + limit).map((conv) => {
    const conversationId = conv.id as string;
    const busy = isAgentBusy(agentId, conversationId);
    const rawQueuedCount = getQueuedAppendPromptCount(agentId, conversationId);
    const hasFailed = conversationHasActiveExecutionFailure(agentId, conversationId);
    // If agent is not busy, the first queued item will be picked up immediately
    // by the drain timer, so don't count it as "queued behind".
    const queuedCount = busy ? rawQueuedCount : Math.max(0, rawQueuedCount - 1);
    const isBusy = busy || hasPendingExecutionItems(agentId, conversationId);
    return {
      ...conv,
      ...parseConversationWorkspaceFields(conv.metadata),
      isBusy,
      queuedCount,
      hasFailed,
    };
  });
  return { entries, total: all.length };
}

export function getAgentConversation(agentId: string, conversationId: string) {
  const conversation = validateConversationOwnership(conversationId, agentId);
  if (!conversation) return null;

  const busy = isAgentBusy(agentId, conversationId);
  const rawQueuedCount = getQueuedAppendPromptCount(agentId, conversationId);
  const hasFailed = conversationHasActiveExecutionFailure(agentId, conversationId);
  const queuedCount = busy ? rawQueuedCount : Math.max(0, rawQueuedCount - 1);
  const isBusy = busy || hasPendingExecutionItems(agentId, conversationId);

  return {
    ...conversation,
    ...parseConversationWorkspaceFields(conversation.metadata),
    isBusy,
    queuedCount,
    hasFailed,
  };
}

/**
 * List recent agent chat conversations across ALL agents, sorted by lastMessageAt desc.
 * Returns agent metadata alongside each conversation.
 */
export async function listRecentAgentConversations(limit = 10) {
  const agents = await listAgents();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const all = store.getAll('conversations').filter((r: Record<string, unknown>) => {
    if (r.channelType !== 'agent') return false;
    if (isBackgroundTriggerConversationRecord(r)) return false;
    const meta = parseMetadata(r.metadata);
    return !!meta?.agentId && agentMap.has(meta.agentId as string);
  });

  const sorted = all.sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt as string).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt as string).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime();
  });

  const entries = sorted.slice(0, limit).map((conv) => {
    const meta = parseMetadata(conv.metadata);
    const agentId = meta?.agentId as string;
    const agent = agentMap.get(agentId)!;
    return {
      id: conv.id,
      subject: conv.subject ?? null,
      lastMessageAt: conv.lastMessageAt ?? null,
      isUnread: conv.isUnread ?? false,
      updatedAt: conv.updatedAt,
      createdAt: conv.createdAt,
      agentId,
      agentName: agent.name,
      agentAvatarIcon: agent.avatarIcon ?? null,
      agentAvatarBgColor: agent.avatarBgColor ?? null,
      agentAvatarLogoColor: agent.avatarLogoColor ?? null,
      ...parseConversationWorkspaceFields(conv.metadata),
    };
  });

  return { entries };
}

/**
 * Search messages across all agent chat conversations by content.
 * Returns matches with snippet + agent/conversation metadata so UI can preview
 * and jump to the exact message in its conversation.
 */
export async function searchAgentMessages(query: string, limit = 20) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return { entries: [] };
  const lowerQuery = normalizedQuery.toLowerCase();

  const agents = await listAgents();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // Build map of conversationId -> { agentId, conversation }
  const convMap = new Map<string, { agentId: string; conversation: Record<string, unknown> }>();
  for (const conv of store.getAll('conversations').filter((r) => r.channelType === 'agent')) {
    if (isBackgroundTriggerConversationRecord(conv)) continue;
    const meta = parseMetadata(conv.metadata);
    const agentId = meta?.agentId as string | undefined;
    if (!agentId || !agentMap.has(agentId)) continue;
    convMap.set(conv.id as string, { agentId, conversation: conv });
  }

  const SNIPPET_BEFORE = 40;
  const SNIPPET_AFTER = 120;

  type SearchEntry = {
    messageId: string;
    conversationId: string;
    agentId: string;
    agentName: string;
    agentAvatarIcon: string | null;
    agentAvatarBgColor: string | null;
    agentAvatarLogoColor: string | null;
    conversationSubject: string | null;
    snippet: string;
    matchStart: number;
    matchLength: number;
    direction: string;
    createdAt: string;
  };

  const matches: SearchEntry[] = [];

  for (const msg of store.getAll('messages')) {
    const conversationId = msg.conversationId as string | undefined;
    if (!conversationId) continue;
    const convInfo = convMap.get(conversationId);
    if (!convInfo) continue;
    if (msg.type === 'system') continue; // skip progress updates
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;
    const idx = content.toLowerCase().indexOf(lowerQuery);
    if (idx === -1) continue;

    const start = Math.max(0, idx - SNIPPET_BEFORE);
    const end = Math.min(content.length, idx + lowerQuery.length + SNIPPET_AFTER);
    let snippet = content.slice(start, end);
    let matchStart = idx - start;
    if (start > 0) {
      snippet = '…' + snippet;
      matchStart += 1;
    }
    if (end < content.length) snippet = snippet + '…';

    const agent = agentMap.get(convInfo.agentId)!;
    matches.push({
      messageId: msg.id as string,
      conversationId,
      agentId: convInfo.agentId,
      agentName: agent.name,
      agentAvatarIcon: agent.avatarIcon ?? null,
      agentAvatarBgColor: agent.avatarBgColor ?? null,
      agentAvatarLogoColor: agent.avatarLogoColor ?? null,
      conversationSubject: (convInfo.conversation.subject as string | null | undefined) ?? null,
      snippet,
      matchStart,
      matchLength: lowerQuery.length,
      direction: (msg.direction as string) ?? '',
      createdAt: (msg.createdAt as string) ?? '',
    });
  }

  matches.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });

  return { entries: matches.slice(0, limit) };
}

/**
 * Create a new conversation for an agent.
 */
export function createAgentConversation(agentId: string, subject?: string) {
  const agent = getAgent(agentId);
  const useSubfolder = agent?.separateFolderPerChat === true;
  const conversationId = crypto.randomUUID();
  const meta: Record<string, unknown> = {
    agentId,
  };
  if (useSubfolder) {
    meta.workspaceMode = 'subfolder';
    meta.workspaceRelativePath = `conversations/${conversationId}`;
    meta.workspaceSeedMode = 'symlink';
  }
  const created = store.insert('conversations', {
    id: conversationId,
    contactId: 'system',
    channelType: 'agent',
    status: 'open',
    subject: subject ?? null,
    externalId: null,
    isUnread: false,
    lastMessageAt: null,
    metadata: JSON.stringify(meta),
  });
  if (useSubfolder) {
    const agent = getAgent(agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }
    const agentRecord = agent as unknown as Record<string, unknown>;
    const contextRoot = resolveAgentWorkspacePathFromRecord(agentRecord, agentId);
    const executionRoot = resolveAgentExecutionRootFromRecord(agentRecord, agentId);
    ensureConversationSubfolderWorkspace(contextRoot, executionRoot, conversationId);
  }
  return {
    ...created,
    ...parseConversationWorkspaceFields(created.metadata),
  };
}

/**
 * Validate that a conversation belongs to the given agent.
 * Returns the conversation or null.
 */
export function validateConversationOwnership(
  conversationId: string,
  agentId: string,
): Record<string, unknown> | null {
  const conv = store.getById('conversations', conversationId);
  if (!conv) return null;
  if (isBackgroundTriggerConversationRecord(conv)) return null;
  const meta = parseMetadata(conv.metadata);
  if (meta?.agentId !== agentId) return null;
  return conv;
}

/**
 * Delete a conversation and all its messages.
 */
export async function deleteAgentConversation(conversationId: string) {
  return store.transaction(async () => {
    deleteAllMessagesForConversation(conversationId);
    deleteAllMessageDraftsForConversation(conversationId);
    clearConversationQueue(conversationId);
    await clearAgentRunConversationReferences(conversationId);
    return store.delete('conversations', conversationId);
  });
}

/**
 * Rename a conversation.
 */
export function renameAgentConversation(conversationId: string, subject: string) {
  return store.update('conversations', conversationId, { subject });
}

/**
 * Mark a conversation as read.
 */
export function markAgentConversationRead(conversationId: string) {
  return store.update('conversations', conversationId, { isUnread: false });
}

// ---------------------------------------------------------------------------
// Conversation tree helpers
// ---------------------------------------------------------------------------

/**
 * Check if a conversation has tree-mode enabled (any message has parentId set).
 */
function isTreeEnabledConversation(conversationId: string): boolean {
  return (
    listMessagesByConversationId(conversationId, {
      order: 'asc',
      limit: 1,
      where: (r) => r.parentId != null,
    }).length > 0
  );
}

function listConversationMessages(conversationId: string): Record<string, unknown>[] {
  const messages = listMessagesByConversationId(conversationId, { order: 'asc' }) as Record<
    string,
    unknown
  >[];
  return dedupeFinalRunResponseMessages(messages);
}

function getFinalRunResponseId(message: Record<string, unknown>): string | null {
  if (message.direction !== 'inbound') return null;
  const metadata = parseMetadata(message.metadata);
  const runId = typeof metadata?.runId === 'string' ? metadata.runId : null;
  if (!runId) return null;
  if (metadata?.agentChatUpdate === true && metadata?.isFinal === false) return null;
  return runId;
}

function getFinalRunResponseKey(message: Record<string, unknown>): string | null {
  const runId = getFinalRunResponseId(message);
  if (!runId) return null;
  return `${runId}:${(message.parentId as string | null) ?? ROOT_BRANCH_KEY}`;
}

function dedupeFinalRunResponseMessages(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = getFinalRunResponseKey(message);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findExistingFinalRunResponse(
  conversationId: string,
  parentId: string | null,
  runId: string,
): Record<string, unknown> | null {
  return (
    listConversationMessages(conversationId).find((message) => {
      if (((message.parentId as string | null) ?? null) !== parentId) return false;
      return getFinalRunResponseId(message) === runId;
    }) ?? null
  );
}

function pruneDuplicateFinalRunResponses(
  conversationId: string,
  parentId: string | null,
  runId: string,
): Record<string, unknown> | null {
  const matches = (
    listMessagesByConversationId(conversationId, { order: 'asc' }) as Record<string, unknown>[]
  ).filter((message) => {
    if (((message.parentId as string | null) ?? null) !== parentId) return false;
    return getFinalRunResponseId(message) === runId;
  });
  if (matches.length === 0) return null;

  const [keep, ...duplicates] = matches;
  for (const duplicate of duplicates) {
    if (typeof duplicate.id === 'string') {
      store.delete('messages', duplicate.id);
    }
  }
  return keep ?? null;
}

function buildChildrenMap(
  messages: Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const childrenMap = new Map<string, Record<string, unknown>[]>();
  for (const msg of messages) {
    const parentId = (msg.parentId as string | null) ?? ROOT_BRANCH_KEY;
    const siblings = childrenMap.get(parentId);
    if (siblings) siblings.push(msg);
    else childrenMap.set(parentId, [msg]);
  }
  return childrenMap;
}

function isNonFinalAgentUpdateMessage(message: Record<string, unknown>): boolean {
  if (message.type !== 'system') return false;
  const metadata = parseMetadata(message.metadata);
  return metadata?.agentChatUpdate === true && metadata?.isFinal === false;
}

function getSelectableBranchChildren(
  childrenMap: Map<string, Record<string, unknown>[]>,
  parentId: string,
): Record<string, unknown>[] {
  return (childrenMap.get(parentId) ?? []).filter(
    (message) => !isNonFinalAgentUpdateMessage(message),
  );
}

function getSelectableReplyChildren(
  childrenMap: Map<string, Record<string, unknown>[]>,
  parentId: string,
): Record<string, unknown>[] {
  const replyChildren = getSelectableBranchChildren(childrenMap, parentId).filter(
    (message) => message.direction !== 'outbound',
  );
  const seenFinalRunIds = new Set<string>();
  return replyChildren.filter((message) => {
    const metadata = parseMetadata(message.metadata);
    const runId = typeof metadata?.runId === 'string' ? metadata.runId : null;
    if (!runId) return true;
    if (metadata?.agentChatUpdate === true && metadata?.isFinal === false) return true;
    if (seenFinalRunIds.has(runId)) return false;
    seenFinalRunIds.add(runId);
    return true;
  });
}

function getUserBranchSelectionKey(previousUserMessageId: string | null): string {
  return `user:${previousUserMessageId ?? ROOT_BRANCH_KEY}`;
}

function getReplyBranchSelectionKey(userMessageId: string): string {
  return `reply:${userMessageId}`;
}

function withSelectedSiblingMetadata(
  message: Record<string, unknown>,
  siblings: Record<string, unknown>[],
): TreePathMessage {
  if (siblings.length <= 1) {
    return { ...message };
  }

  const selectedIndex = siblings.findIndex((sibling) => sibling.id === message.id);
  if (selectedIndex === -1) return { ...message };

  return {
    ...message,
    _siblingIndex: selectedIndex,
    _siblingCount: siblings.length,
    _siblingIds: siblings.map((sibling) => sibling.id as string),
  };
}

/**
 * Get active branches map from conversation metadata.
 */
function getActiveBranches(conversationId: string): Record<string, string> {
  const conv = store.getById('conversations', conversationId);
  if (!conv) return {};
  const meta = parseMetadata(conv.metadata);
  return (meta?.activeBranches as Record<string, string>) ?? {};
}

/**
 * Update active branches in conversation metadata.
 */
function setActiveBranches(conversationId: string, activeBranches: Record<string, string>) {
  const conv = store.getById('conversations', conversationId);
  if (!conv) return;
  const meta = parseMetadata(conv.metadata) ?? {};
  meta.activeBranches = activeBranches;
  store.update('conversations', conversationId, { metadata: JSON.stringify(meta) });
}

/**
 * Retroactively assign parentIds to all messages in a linear conversation,
 * converting it to tree mode. Each message becomes a child of the previous one.
 */
function ensureConversationTree(conversationId: string): void {
  if (isTreeEnabledConversation(conversationId)) return;

  const allMessages = listMessagesByConversationId(conversationId, { order: 'asc' });

  let prevId: string | null = null;
  for (const msg of allMessages) {
    store.update('messages', msg.id as string, { parentId: prevId });
    prevId = msg.id as string;
  }
}

/**
 * Walk the conversation tree following active branches and return the active path.
 * For non-tree conversations, returns all messages in chronological order.
 */
export function getActiveMessagePath(conversationId: string): TreePathMessage[] {
  const allMessages = listConversationMessages(conversationId);

  if (allMessages.length === 0) return [];

  const activeBranches = getActiveBranches(conversationId);
  const childrenMap = buildChildrenMap(allMessages);
  const userMessages = allMessages.filter((message) => message.direction === 'outbound');
  const userVariantsByPreviousMessageId = new Map<string | null, Record<string, unknown>[]>();
  for (const message of userMessages) {
    const previousUserMessageId = getPreviousUserMessageIdForConversationMessage(
      conversationId,
      message,
    );
    const variants = userVariantsByPreviousMessageId.get(previousUserMessageId);
    if (variants) variants.push(message);
    else userVariantsByPreviousMessageId.set(previousUserMessageId, [message]);
  }

  const path: TreePathMessage[] = [];
  let previousUserMessageId: string | null = null;

  while (true) {
    const userVariants = userVariantsByPreviousMessageId.get(previousUserMessageId) ?? [];
    if (userVariants.length === 0) break;

    const activeUserId = activeBranches[getUserBranchSelectionKey(previousUserMessageId)];
    const selectedUser =
      userVariants.find((variant) => variant.id === activeUserId) ??
      userVariants[userVariants.length - 1];
    path.push(withSelectedSiblingMetadata(selectedUser, userVariants));

    const selectedUserId = selectedUser.id as string;
    const replyVariants = getSelectableReplyChildren(childrenMap, selectedUserId);
    if (replyVariants.length > 0) {
      const activeReplyId = activeBranches[getReplyBranchSelectionKey(selectedUserId)];
      const selectedReply =
        replyVariants.find((variant) => variant.id === activeReplyId) ??
        replyVariants[replyVariants.length - 1];
      path.push(withSelectedSiblingMetadata(selectedReply, replyVariants));
    }

    previousUserMessageId = selectedUserId;
  }

  return path;
}

function getOutboundAnchorForInboundMessage(
  conversationId: string,
  message: Record<string, unknown>,
  messagesById: Map<string, Record<string, unknown>>,
): string | null {
  let parentId = (message.parentId as string | null) ?? null;
  while (parentId) {
    const parent = messagesById.get(parentId);
    if (!parent) break;
    if (parent.direction === 'outbound') {
      return parentId;
    }
    parentId = (parent.parentId as string | null) ?? null;
  }
  return findPreviousOutboundAncestor(conversationId, (message.parentId as string | null) ?? null);
}

/**
 * Serialize every message in a conversation (all branches), with sibling metadata
 * matching the active-path API shape.
 */
export function serializeAllConversationMessageEntries(
  conversationId: string,
): Record<string, unknown>[] {
  const allMessages = listConversationMessages(conversationId);
  if (allMessages.length === 0) return [];

  const messagesById = new Map<string, Record<string, unknown>>(
    allMessages.map((m) => [String(m.id), m]),
  );
  const childrenMap = buildChildrenMap(allMessages);
  const userMessages = allMessages.filter((message) => message.direction === 'outbound');
  const userVariantsByPreviousMessageId = new Map<string | null, Record<string, unknown>[]>();
  for (const message of userMessages) {
    const previousUserMessageId = getPreviousUserMessageIdForConversationMessage(
      conversationId,
      message,
    );
    const variants = userVariantsByPreviousMessageId.get(previousUserMessageId);
    if (variants) variants.push(message);
    else userVariantsByPreviousMessageId.set(previousUserMessageId, [message]);
  }
  for (const [, variants] of userVariantsByPreviousMessageId) {
    variants.sort(compareMessagesChronologically);
  }

  const rows: Record<string, unknown>[] = [];
  for (const msg of allMessages) {
    let siblings: Record<string, unknown>[];
    if (msg.direction === 'outbound') {
      const prevId = getPreviousUserMessageIdForConversationMessage(conversationId, msg);
      siblings = userVariantsByPreviousMessageId.get(prevId) ?? [msg];
    } else {
      const anchorUserId = getOutboundAnchorForInboundMessage(conversationId, msg, messagesById);
      siblings = anchorUserId ? getSelectableReplyChildren(childrenMap, anchorUserId) : [msg];
      if (siblings.length === 0) {
        siblings = [msg];
      }
    }

    const enriched = withSelectedSiblingMetadata(msg, siblings) as TreePathMessage;
    const { _siblingIndex, _siblingCount, _siblingIds, ...rest } = enriched;
    rows.push({
      ...rest,
      previousUserMessageId: getPreviousUserMessageIdForConversationMessage(conversationId, msg),
      siblingIndex: _siblingIndex,
      siblingCount: _siblingCount,
      siblingIds: _siblingIds,
    });
  }

  rows.sort(compareMessagesChronologically);
  return rows;
}

function getMessagePathToLeaf(conversationId: string, leafMessageId: string): TreePathMessage[] {
  const allMessages = listConversationMessages(conversationId);
  if (allMessages.length === 0) return [];
  const messagesById = new Map(allMessages.map((message) => [message.id as string, message]));
  const leaf = messagesById.get(leafMessageId);
  if (!leaf) return [];
  const childrenMap = buildChildrenMap(allMessages);
  const userMessages = allMessages.filter((message) => message.direction === 'outbound');
  const userVariantsByPreviousMessageId = new Map<string | null, Record<string, unknown>[]>();
  for (const message of userMessages) {
    const previousUserMessageId = getPreviousUserMessageIdForPromptPath(
      conversationId,
      message,
    );
    const variants = userVariantsByPreviousMessageId.get(previousUserMessageId);
    if (variants) variants.push(message);
    else userVariantsByPreviousMessageId.set(previousUserMessageId, [message]);
  }

  const targetUser =
    leaf.direction === 'outbound'
      ? leaf
      : typeof leaf.parentId === 'string'
        ? (messagesById.get(leaf.parentId as string) ?? null)
        : null;
  if (!targetUser || targetUser.direction !== 'outbound') return [];

  const userLineage: Record<string, unknown>[] = [];
  let currentUser: Record<string, unknown> | null = targetUser;
  while (currentUser) {
    userLineage.push(currentUser);
    const previousUserMessageId = getPreviousUserMessageIdForPromptPath(
      conversationId,
      currentUser,
    );
    currentUser = previousUserMessageId ? (messagesById.get(previousUserMessageId) ?? null) : null;
  }

  const path: TreePathMessage[] = [];
  for (const userMessage of userLineage.reverse()) {
    const previousUserMessageId = getPreviousUserMessageIdForPromptPath(
      conversationId,
      userMessage,
    );
    const userVariants = userVariantsByPreviousMessageId.get(previousUserMessageId) ?? [];
    path.push(withSelectedSiblingMetadata(userMessage, userVariants));

    const replyVariants = getSelectableReplyChildren(childrenMap, userMessage.id as string);
    if (replyVariants.length === 0) continue;

    if (userMessage.id === targetUser.id) {
      if (leaf.direction === 'inbound') {
        path.push(withSelectedSiblingMetadata(leaf, replyVariants));
      }
      break;
    }

    path.push(withSelectedSiblingMetadata(replyVariants[replyVariants.length - 1], replyVariants));
  }

  return path;
}

/**
 * Get the leaf (last message) of the active path.
 */
function getActivePathLeaf(conversationId: string): Record<string, unknown> | null {
  const path = getActiveMessagePath(conversationId);
  return path.length > 0 ? path[path.length - 1] : null;
}

function getCurrentConversationLeafId(conversationId: string): string | null {
  const messages = listConversationMessages(conversationId);
  if (messages.length === 0) return null;

  if (!messages.some((message) => message.parentId != null)) {
    const latest = messages[messages.length - 1];
    return typeof latest?.id === 'string' ? (latest.id as string) : null;
  }

  const leaf = getActivePathLeaf(conversationId);
  return leaf && typeof leaf.id === 'string' ? (leaf.id as string) : null;
}

function findPreviousOutboundAncestor(
  conversationId: string,
  startingParentId: string | null,
): string | null {
  let currentParentId = startingParentId;
  while (currentParentId) {
    const current = store.getById('messages', currentParentId);
    if (!current || current.conversationId !== conversationId) break;
    if (current.direction === 'outbound') {
      return current.id as string;
    }
    currentParentId = (current.parentId as string | null) ?? null;
  }
  return null;
}

function getPreviousUserMessageIdForPromptPath(
  conversationId: string,
  message: Record<string, unknown>,
): string | null {
  const stored =
    typeof message.previousUserMessageId === 'string'
      ? (message.previousUserMessageId as string)
      : null;
  if (stored) return stored;

  const turnParent = resolvePreviousUserMessageIdFromTurnParent(conversationId, message);
  if (turnParent.found) return turnParent.previousUserMessageId;

  if (message.direction === 'outbound' && typeof message.parentId === 'string') {
    const parentMessage = store.getById('messages', message.parentId as string);
    if (
      parentMessage &&
      parentMessage.conversationId === conversationId &&
      parentMessage.direction === 'outbound'
    ) {
      return getPreviousUserMessageIdForPromptPath(conversationId, parentMessage);
    }
  }

  return findPreviousOutboundAncestor(conversationId, (message.parentId as string | null) ?? null);
}

export function getPreviousUserMessageIdForConversationMessage(
  conversationId: string,
  message: Record<string, unknown>,
): string | null {
  const stored =
    typeof message.previousUserMessageId === 'string'
      ? (message.previousUserMessageId as string)
      : null;
  if (stored) return stored;

  const turnParent = resolvePreviousUserMessageIdFromTurnParent(conversationId, message);
  if (turnParent.found) return turnParent.previousUserMessageId;

  if (message.direction === 'outbound' && typeof message.parentId === 'string') {
    const parentMessage = store.getById('messages', message.parentId as string);
    if (
      parentMessage &&
      parentMessage.conversationId === conversationId &&
      parentMessage.direction === 'outbound'
    ) {
      return getPreviousUserMessageIdForConversationMessage(conversationId, parentMessage);
    }
  }

  return findPreviousOutboundAncestor(conversationId, (message.parentId as string | null) ?? null);
}

function resolvePreviousUserMessageIdFromTurnParent(
  conversationId: string,
  message: Record<string, unknown>,
): { found: boolean; previousUserMessageId: string | null } {
  const messageId = typeof message.id === 'string' ? message.id : null;
  if (!messageId) return { found: false, previousUserMessageId: null };
  const turn = findLatestTurnForConversationMessage(conversationId, messageId);
  if (!turn) return { found: false, previousUserMessageId: null };
  const parentTurnId = typeof turn.parentTurnId === 'string' ? turn.parentTurnId : null;
  const supersedesTurnId =
    typeof turn.supersedesTurnId === 'string' ? turn.supersedesTurnId : null;
  if (!parentTurnId && !supersedesTurnId) {
    return { found: false, previousUserMessageId: null };
  }
  if (!parentTurnId) return { found: true, previousUserMessageId: null };
  const parentTurn = store.getById('agentChatTurns', parentTurnId);
  return {
    found: true,
    previousUserMessageId:
      typeof parentTurn?.userMessageId === 'string' ? parentTurn.userMessageId : null,
  };
}

function findLatestTurnForConversationMessage(
  conversationId: string,
  messageId: string,
): Record<string, unknown> | null {
  const matches = store
    .getAll('agentChatTurns')
    .filter(
      (turn) =>
        turn.conversationId === conversationId &&
        (turn.userMessageId === messageId || turn.assistantMessageId === messageId),
    )
    .sort((a, b) => {
      const aTime = typeof a.createdAt === 'string' ? new Date(a.createdAt).getTime() : 0;
      const bTime = typeof b.createdAt === 'string' ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });
  return matches[matches.length - 1] ?? null;
}

function resolveEditedMessageParentId(
  conversationId: string,
  original: Record<string, unknown>,
): string | null {
  const originalMessageId = typeof original.id === 'string' ? original.id : null;
  let turn = originalMessageId
    ? findLatestTurnForConversationMessage(conversationId, originalMessageId)
    : null;
  const visitedTurnIds = new Set<string>();
  let baseMessage: Record<string, unknown> | null = null;

  while (turn && typeof turn.supersedesTurnId === 'string') {
    if (visitedTurnIds.has(turn.supersedesTurnId)) break;
    visitedTurnIds.add(turn.supersedesTurnId);

    const superseded = store.getById('agentChatTurns', turn.supersedesTurnId);
    const supersededMessageId =
      typeof superseded?.userMessageId === 'string' ? superseded.userMessageId : null;
    const supersededMessage = supersededMessageId
      ? store.getById('messages', supersededMessageId)
      : null;
    if (
      supersededMessage &&
      supersededMessage.conversationId === conversationId &&
      supersededMessage.direction === 'outbound'
    ) {
      baseMessage = supersededMessage;
    }
    turn = superseded ?? null;
  }

  const parentSource = baseMessage ?? original;
  return typeof parentSource.parentId === 'string' ? parentSource.parentId : null;
}

function resolvePreviousUserMessageId(
  conversationId: string,
  previousUserMessageId: string | null,
): string | null {
  if (!previousUserMessageId) return null;
  const message = store.getById('messages', previousUserMessageId);
  if (message && message.conversationId === conversationId) {
    if (message.direction !== 'outbound') {
      throw AgentChatError.badRequest(
        'previous_user_message_invalid',
        'Previous user message must be a user message',
      );
    }
    return previousUserMessageId;
  }

  const pendingQueuedMessage = store
    .getAll(AGENT_CHAT_QUEUE_COLLECTION)
    .find(
      (record: Record<string, unknown>) =>
        record.conversationId === conversationId &&
        record.queuedMessageId === previousUserMessageId &&
        getQueueItemMode(record) === 'append_prompt' &&
        (record.status === 'queued' || record.status === 'processing'),
    );
  if (pendingQueuedMessage) {
    return previousUserMessageId;
  }

  throw AgentChatError.notFound(
    'previous_user_message_not_found',
    'Previous user message not found',
  );
}

function getContinuationParentIdForPreviousUserMessage(
  conversationId: string,
  previousUserMessageId: string | null,
): string | null {
  const normalizedPreviousUserMessageId = resolvePreviousUserMessageId(
    conversationId,
    previousUserMessageId,
  );
  if (!normalizedPreviousUserMessageId) return null;
  const previousUserMessage = store.getById('messages', normalizedPreviousUserMessageId);
  if (!previousUserMessage || previousUserMessage.conversationId !== conversationId) {
    return null;
  }

  let currentId = normalizedPreviousUserMessageId;
  while (true) {
    const activeChildren = getSelectableReplyChildren(
      buildChildrenMap(listConversationMessages(conversationId)),
      currentId,
    );
    if (activeChildren.length === 0) {
      return currentId;
    }

    const activeChildId = getActiveBranchSelection(
      conversationId,
      getReplyBranchSelectionKey(currentId),
    );
    const selectedChild =
      activeChildren.find((child) => child.id === activeChildId) ??
      activeChildren[activeChildren.length - 1];
    if (!selectedChild) {
      return currentId;
    }
    currentId = selectedChild.id as string;
  }
}

function setActiveBranchSelection(
  conversationId: string,
  parentId: string | null,
  messageId: string,
): void {
  const activeBranches = getActiveBranches(conversationId);
  activeBranches[parentId ?? ROOT_BRANCH_KEY] = messageId;
  setActiveBranches(conversationId, activeBranches);
}

function getActiveBranchSelection(conversationId: string, parentId: string | null): string | null {
  const activeBranches = getActiveBranches(conversationId);
  const selected = activeBranches[parentId ?? ROOT_BRANCH_KEY];
  return typeof selected === 'string' ? selected : null;
}

function shouldAutoSelectNewChild(
  conversationId: string,
  parentId: string | null,
  currentLeafId: string | null,
): boolean {
  if ((parentId ?? null) === (currentLeafId ?? null)) return true;
  return !getActiveBranchSelection(conversationId, parentId);
}

function activateMessagePath(conversationId: string, leafMessageId: string): void {
  const messages = listConversationMessages(conversationId);
  const messagesById = new Map(messages.map((message) => [message.id as string, message]));
  const leaf = messagesById.get(leafMessageId);
  if (!leaf) return;

  const targetUser =
    leaf.direction === 'outbound'
      ? leaf
      : typeof leaf.parentId === 'string'
        ? (messagesById.get(leaf.parentId as string) ?? null)
        : null;
  if (!targetUser || targetUser.direction !== 'outbound') return;

  const userLineage: Record<string, unknown>[] = [];
  let currentUser: Record<string, unknown> | null = targetUser;
  while (currentUser) {
    userLineage.push(currentUser);
    const previousUserMessageId = getPreviousUserMessageIdForConversationMessage(
      conversationId,
      currentUser,
    );
    currentUser = previousUserMessageId ? (messagesById.get(previousUserMessageId) ?? null) : null;
  }

  for (const userMessage of userLineage.reverse()) {
    setActiveBranchSelection(
      conversationId,
      getUserBranchSelectionKey(
        getPreviousUserMessageIdForConversationMessage(conversationId, userMessage),
      ),
      userMessage.id as string,
    );
  }

  if (leaf.direction === 'inbound') {
    setActiveBranchSelection(
      conversationId,
      getReplyBranchSelectionKey(targetUser.id as string),
      leaf.id as string,
    );
  }
}

function getConversationAgentId(conversationId: string): string | null {
  const conversation = store.getById('conversations', conversationId);
  const metadata = parseMetadata(conversation?.metadata);
  return typeof metadata?.agentId === 'string' ? metadata.agentId : null;
}

function activateTurnPathForMessage(conversationId: string, messageId: string): boolean {
  const agentId = getConversationAgentId(conversationId);
  if (!agentId) return false;
  const turn = findLatestTurnForConversationMessage(conversationId, messageId);
  const turnId = typeof turn?.id === 'string' ? turn.id : null;
  return activateTurnPath(conversationId, agentId, turnId);
}

function activateTurnPath(conversationId: string, agentId: string, turnId: string | null): boolean {
  if (!turnId) return false;

  const turns = listAgentChatTurns(agentId, conversationId);
  const turnsById = new Map(turns.map((record) => [String(record.id), record]));
  const turn = turnId ? (turnsById.get(turnId) ?? null) : null;
  if (!turn) return false;

  const lineage: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let current: Record<string, unknown> | null = turn;
  while (current) {
    const currentId = typeof current.id === 'string' ? current.id : null;
    if (!currentId || visited.has(currentId)) break;
    visited.add(currentId);
    lineage.push(current);
    const parentTurnId: string | null =
      typeof current.parentTurnId === 'string' ? (current.parentTurnId as string) : null;
    current = parentTurnId ? (turnsById.get(parentTurnId) ?? null) : null;
  }

  const activeBranches = getActiveBranches(conversationId);
  for (const branchTurn of lineage.reverse()) {
    const branchTurnId = typeof branchTurn.id === 'string' ? branchTurn.id : null;
    if (!branchTurnId) continue;
    const parentTurnId: string | null =
      typeof branchTurn.parentTurnId === 'string' ? (branchTurn.parentTurnId as string) : null;
    activeBranches[`turn:${parentTurnId ?? ROOT_BRANCH_KEY}`] = branchTurnId;
  }
  setActiveBranches(conversationId, activeBranches);
  return true;
}

export function activateMessagePathForSearchResult(
  conversationId: string,
  messageId: string,
): void {
  const message = store.getById('messages', messageId);
  if (!message || message.conversationId !== conversationId) {
    throw AgentChatError.notFound('message_not_found', 'Message not found');
  }

  if (!activateTurnPathForMessage(conversationId, messageId)) {
    throw AgentChatError.notFound('turn_not_found', 'Message has no durable chat turn');
  }
}

/**
 * Edit a user message and create a new branch.
 * Returns the newly created message.
 */
export function editMessageAndBranch(
  conversationId: string,
  messageId: string,
  newContent: string,
  options: {
    newMessageId?: string | null;
    previousUserMessageId?: string | null;
    attachments?: unknown[] | null;
    keepStoragePaths?: string[] | null;
  } = {},
): Record<string, unknown> {
  // Ensure tree mode
  ensureConversationTree(conversationId);

  const original = store.getById('messages', messageId);
  if (!original) throw AgentChatError.notFound('message_not_found', 'Message not found');
  if (original.conversationId !== conversationId) {
    throw AgentChatError.notFound('message_not_found', 'Message not found');
  }
  if (original.direction !== 'outbound') {
    throw AgentChatError.badRequest(
      'message_edit_not_supported',
      'Only user messages can be edited',
    );
  }
  if (original.type !== 'text' && original.type !== 'image' && original.type !== 'file') {
    throw AgentChatError.badRequest(
      'message_edit_not_supported',
      'Only text, image, and file messages can be edited',
    );
  }

  const derivedPreviousUserMessageId = getPreviousUserMessageIdForConversationMessage(
    conversationId,
    original,
  );
  const previousUserMessageId = resolvePreviousUserMessageId(
    conversationId,
    derivedPreviousUserMessageId,
  );
  const parentId = resolveEditedMessageParentId(conversationId, original);
  const originalAttachments =
    original.type === 'image' || original.type === 'file'
      ? cloneAttachmentRecords(parseAttachments(original.attachments))
      : [];
  const hasKeepStoragePaths = Array.isArray(options.keepStoragePaths);
  const keepStoragePathSet = hasKeepStoragePaths ? new Set(options.keepStoragePaths) : null;
  const retainedOriginalAttachments =
    keepStoragePathSet === null
      ? originalAttachments
      : originalAttachments.filter(
          (attachment) =>
            typeof attachment.storagePath === 'string' &&
            keepStoragePathSet.has(attachment.storagePath),
        );
  const appendedAttachments =
    Array.isArray(options.attachments) && options.attachments.length > 0
      ? cloneAttachmentRecords(options.attachments as Array<Record<string, unknown>>)
      : [];
  const combinedAttachments =
    original.type === 'image' || original.type === 'file'
      ? [...retainedOriginalAttachments, ...appendedAttachments]
      : appendedAttachments;
  if (combinedAttachments.length > MAX_CHAT_MESSAGE_IMAGES) {
    throw AgentChatError.badRequest(
      'message_attachment_limit_exceeded',
      `A message can contain up to ${MAX_CHAT_MESSAGE_IMAGES} images`,
    );
  }

  const normalizedAttachments = combinedAttachments.length > 0 ? combinedAttachments : null;
  const nextType = normalizedAttachments
    ? normalizedAttachments.every((attachment) => attachment.type === 'image')
      ? 'image'
      : 'file'
    : 'text';
  const trimmedContent = newContent.trim();
  if (nextType === 'text' && !trimmedContent) {
    throw AgentChatError.badRequest(
      'edited_message_content_required',
      'Edited message content is required',
    );
  }

  // Create new sibling message
  const msg = store.insert('messages', {
    id: options.newMessageId ?? undefined,
    conversationId,
    direction: 'outbound',
    type: nextType,
    content: trimmedContent,
    status: 'sent',
    attachments: normalizedAttachments,
    metadata: null,
    parentId,
    previousUserMessageId,
  });

  // Make the edited branch the selected visible path across its full lineage.
  activateMessagePath(conversationId, msg.id as string);

  store.update('conversations', conversationId, {
    lastMessageAt: new Date().toISOString(),
  });

  return msg;
}

/**
 * Switch the active branch at a given message (select a different sibling).
 */
export function switchBranchTurn(conversationId: string, turnId: string): void {
  const agentId = getConversationAgentId(conversationId);
  if (!agentId) throw AgentChatError.notFound('turn_not_found', 'Turn not found');
  const turn = listAgentChatTurns(agentId, conversationId).find(
    (candidate) => candidate.id === turnId,
  );
  if (!turn) throw AgentChatError.notFound('turn_not_found', 'Turn not found');
  const parentTurnId = typeof turn.parentTurnId === 'string' ? turn.parentTurnId : null;
  const siblings = listAgentChatTurns(agentId, conversationId)
    .filter(
      (candidate) => ((candidate.parentTurnId as string | null) ?? null) === parentTurnId,
    )
    .filter((candidate) => typeof candidate.userMessageId === 'string');

  if (siblings.length <= 1 || !siblings.some((candidate) => candidate.id === turnId)) {
    throw AgentChatError.badRequest(
      'invalid_branch_choice',
      'Turn is not a valid branch choice',
    );
  }

  activateTurnPath(conversationId, agentId, turnId);
}

export function switchBranch(conversationId: string, messageId: string): void {
  const msg = store.getById('messages', messageId);
  if (!msg) throw AgentChatError.notFound('message_not_found', 'Message not found');
  if (msg.conversationId !== conversationId) {
    throw AgentChatError.notFound('message_not_found', 'Message not found');
  }

  const turn = findLatestTurnForConversationMessage(conversationId, messageId);
  const agentId = getConversationAgentId(conversationId);
  const parentTurnId = typeof turn?.parentTurnId === 'string' ? turn.parentTurnId : null;
  const siblings = agentId
    ? listAgentChatTurns(agentId, conversationId)
        .filter(
          (candidate) => ((candidate.parentTurnId as string | null) ?? null) === parentTurnId,
        )
        .filter((candidate) => typeof candidate.userMessageId === 'string')
    : [];
  if (
    !turn ||
    siblings.length <= 1 ||
    !siblings.some((candidate) => candidate.userMessageId === messageId)
  ) {
    throw AgentChatError.badRequest(
      'invalid_branch_choice',
      'Message is not a valid branch choice',
    );
  }

  activateTurnPathForMessage(conversationId, messageId);
}

// ---------------------------------------------------------------------------
// Save messages
// ---------------------------------------------------------------------------

type AgentConversationMessageType = 'text' | 'system' | 'file';

interface SaveAgentMessageParams {
  id?: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  type?: AgentConversationMessageType | 'image';
  metadata?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
  parentId?: string | null;
  previousUserMessageId?: string | null;
  updateActiveBranch?: boolean;
}

export function saveAgentConversationMessage(params: SaveAgentMessageParams) {
  const metadata = params.metadata ? JSON.stringify(params.metadata) : null;
  const treeEnabled = isTreeEnabledConversation(params.conversationId);
  const isProgressUpdate =
    params.type === 'system' &&
    params.metadata?.agentChatUpdate === true &&
    params.metadata?.isFinal === false;
  const updateActiveBranch = params.updateActiveBranch ?? true;
  const canAdvanceActiveBranch =
    updateActiveBranch && (treeEnabled || params.parentId !== undefined) && !isProgressUpdate;

  // Resolve parentId: explicit value, or auto-compute from active path leaf
  let parentId: string | null = null;
  if (params.parentId !== undefined) {
    parentId = params.parentId;
  } else if (params.previousUserMessageId !== undefined) {
    parentId = getContinuationParentIdForPreviousUserMessage(
      params.conversationId,
      params.previousUserMessageId ?? null,
    );
  } else if (treeEnabled) {
    const leaf = getActivePathLeaf(params.conversationId);
    parentId = leaf ? (leaf.id as string) : null;
  }
  const previousUserMessageId =
    params.direction === 'outbound'
      ? params.previousUserMessageId !== undefined
        ? resolvePreviousUserMessageId(params.conversationId, params.previousUserMessageId ?? null)
        : findPreviousOutboundAncestor(params.conversationId, parentId)
      : null;
  const currentLeafId = canAdvanceActiveBranch
    ? getCurrentConversationLeafId(params.conversationId)
    : null;

  const runId = typeof params.metadata?.runId === 'string' ? params.metadata.runId : null;
  if (params.direction === 'inbound' && runId && !isProgressUpdate) {
    const existingRunResponse = findExistingFinalRunResponse(
      params.conversationId,
      parentId,
      runId,
    );
    if (existingRunResponse) {
      return existingRunResponse;
    }
  }

  const msg = store.insert('messages', {
    id: params.id,
    conversationId: params.conversationId,
    direction: params.direction,
    type: params.type ?? 'text',
    content: params.content,
    status: params.direction === 'outbound' ? 'sent' : 'delivered',
    attachments: params.attachments ?? null,
    metadata,
    parentId,
    previousUserMessageId,
  });

  const markUnread = params.direction === 'inbound' && params.type !== 'system';
  store.update('conversations', params.conversationId, {
    lastMessageAt: new Date().toISOString(),
    isUnread: markUnread,
  });

  const finalRunResponse =
    runId && params.direction === 'inbound' && !isProgressUpdate
      ? pruneDuplicateFinalRunResponses(params.conversationId, parentId, runId)
      : msg;
  const branchMessage = finalRunResponse ?? msg;

  if (canAdvanceActiveBranch) {
    if (params.direction === 'outbound') {
      const selectionKey = getUserBranchSelectionKey(previousUserMessageId);
      setActiveBranchSelection(params.conversationId, selectionKey, branchMessage.id as string);
    } else if (parentId) {
      const selectionKey = getReplyBranchSelectionKey(parentId);
      if (shouldAutoSelectNewChild(params.conversationId, selectionKey, currentLeafId)) {
        setActiveBranchSelection(params.conversationId, selectionKey, branchMessage.id as string);
      }
    }
  }

  if (params.direction === 'outbound') {
    autoTitleIfNeeded(
      params.conversationId,
      buildAutoTitleFromMessage(params.content, params.type ?? 'text', params.attachments),
    );
  }

  return branchMessage;
}

function saveMessage(conversationId: string, direction: 'inbound' | 'outbound', content: string) {
  return saveAgentConversationMessage({
    conversationId,
    direction,
    content,
    type: 'text',
    metadata: null,
  });
}

function getQueueItemAnchorMessageId(queueItem: Record<string, unknown>): string | null {
  const queuedMessageId =
    typeof queueItem.queuedMessageId === 'string' ? (queueItem.queuedMessageId as string) : null;
  if (queuedMessageId) return queuedMessageId;

  return typeof queueItem.targetMessageId === 'string'
    ? (queueItem.targetMessageId as string)
    : null;
}

function getQueueItemDependencyId(queueItem: Record<string, unknown>): string | null {
  return typeof queueItem.dependsOnQueueItemId === 'string'
    ? (queueItem.dependsOnQueueItemId as string)
    : null;
}

function findPendingBranchDependencyForAppendPrompt(
  agentId: string,
  conversationId: string,
  previousUserMessageId: string | null,
  continuationParentId: string | null,
): Record<string, unknown> | null {
  const pendingItems = listConversationQueueItems(agentId, conversationId).filter((item) =>
    isPendingQueueItem(item),
  );

  if (previousUserMessageId) {
    const queuedMessageDependency =
      [...pendingItems]
        .reverse()
        .find(
          (item) =>
            getQueueItemMode(item) === 'append_prompt' &&
            item.queuedMessageId === previousUserMessageId,
        ) ?? null;
    if (queuedMessageDependency) {
      return queuedMessageDependency;
    }
  }

  if (!continuationParentId) {
    return (
      [...pendingItems].reverse().find((item) => getQueueItemMode(item) === 'append_prompt') ?? null
    );
  }

  return (
    [...pendingItems].reverse().find((item) => {
      const mode = getQueueItemMode(item);
      if (mode === 'respond_to_message') {
        return item.targetMessageId === continuationParentId;
      }

      return item.queuedMessageId === continuationParentId;
    }) ?? null
  );
}

function resolveQueuedPromptParentId(
  conversationId: string,
  options: {
    previousUserMessageId: string | null;
    continuationParentId: string | null;
    dependsOnQueueItemId: string | null;
  },
): string | null {
  const getConversationMessageId = (messageId: unknown): string | null => {
    if (typeof messageId !== 'string') return null;
    const message = store.getById('messages', messageId);
    if (!message || message.conversationId !== conversationId) return null;
    return messageId;
  };

  let parentId =
    options.previousUserMessageId !== null
      ? getContinuationParentIdForPreviousUserMessage(conversationId, options.previousUserMessageId)
      : getConversationMessageId(options.continuationParentId);

  if (options.dependsOnQueueItemId) {
    const dependency = store.getById(AGENT_CHAT_QUEUE_COLLECTION, options.dependsOnQueueItemId);
    if (dependency && dependency.conversationId === conversationId) {
      parentId =
        getConversationMessageId(dependency.responseMessageId) ??
        getConversationMessageId(getQueueItemAnchorMessageId(dependency)) ??
        parentId;
    }
  }

  return parentId ?? getCurrentConversationLeafId(conversationId);
}

/** When the client omits previousUserMessageId, infer it from the resolved append parent so message and turn lineage stay aligned. */
function previousUserMessageIdForAppendParent(
  conversationId: string,
  parentId: string | null,
  previousUserMessageId: string | null,
): string | null {
  if (previousUserMessageId != null) return previousUserMessageId;
  if (!parentId) return null;
  return findPreviousOutboundAncestor(conversationId, parentId);
}

function ensureQueuedPromptMessage(
  queueItemId: string,
  queueItem: Record<string, unknown>,
  conversationId: string,
  prompt: string,
): Record<string, unknown> {
  const existingMessageId =
    typeof queueItem.queuedMessageId === 'string' ? (queueItem.queuedMessageId as string) : null;
  if (existingMessageId) {
    const existingMessage = store.getById('messages', existingMessageId);
    if (existingMessage && existingMessage.conversationId === conversationId) {
      return existingMessage;
    }
  }

  const previousUserMessageId =
    typeof queueItem.previousUserMessageId === 'string' || queueItem.previousUserMessageId === null
      ? ((queueItem.previousUserMessageId as string | null | undefined) ?? null)
      : null;
  const parentId = resolveQueuedPromptParentId(conversationId, {
    previousUserMessageId,
    continuationParentId:
      typeof queueItem.continuationParentId === 'string'
        ? (queueItem.continuationParentId as string)
        : null,
    dependsOnQueueItemId:
      typeof queueItem.dependsOnQueueItemId === 'string'
        ? (queueItem.dependsOnQueueItemId as string)
        : null,
  });

  if (parentId) {
    activateMessagePath(conversationId, parentId);
  }

  const queuedAttachments = parseAttachments(queueItem.attachments);
  const effectivePreviousUserMessageId = previousUserMessageIdForAppendParent(
    conversationId,
    parentId,
    previousUserMessageId,
  );
  const userMessage = saveAgentConversationMessage({
    id:
      typeof queueItem.queuedMessageId === 'string'
        ? (queueItem.queuedMessageId as string)
        : undefined,
    conversationId,
    direction: 'outbound',
    content: prompt,
    type: getMessageTypeForAttachments(queuedAttachments),
    metadata: null,
    attachments: queuedAttachments.length > 0 ? queuedAttachments : null,
    parentId,
    previousUserMessageId: effectivePreviousUserMessageId,
  });
  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    queuedMessageId: userMessage.id,
  });
  return userMessage;
}

// ---------------------------------------------------------------------------
// Auto-title helper
// ---------------------------------------------------------------------------

function buildAutoTitleFromMessage(
  content: string,
  type: AgentConversationMessageType | 'image',
  attachments?: unknown[] | null,
): string | null {
  const trimmed = content.trim();
  if (trimmed) {
    return trimmed;
  }

  if (type !== 'image' && type !== 'file') {
    return null;
  }

  const parsedAttachments = parseAttachments(attachments);
  const imageNames = parsedAttachments
    .filter((attachment) => attachment.type === 'image' && typeof attachment.fileName === 'string')
    .map((attachment) => attachment.fileName as string);
  const fileNames = parsedAttachments
    .filter((attachment) => attachment.type !== 'image' && typeof attachment.fileName === 'string')
    .map((attachment) => attachment.fileName as string);

  if (imageNames.length > 0 && fileNames.length === 0) {
    if (imageNames.length === 1) return `Image: ${imageNames[0]}`;
    return `Images: ${imageNames.slice(0, 2).join(', ')}${imageNames.length > 2 ? ', ...' : ''}`;
  }

  if (fileNames.length > 0 && imageNames.length === 0) {
    if (fileNames.length === 1) return `File: ${fileNames[0]}`;
    return `Files: ${fileNames.slice(0, 2).join(', ')}${fileNames.length > 2 ? ', ...' : ''}`;
  }

  if (imageNames.length > 0 || fileNames.length > 0) {
    const names = [...imageNames, ...fileNames];
    return `Attachments: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ', ...' : ''}`;
  }

  return type === 'image' ? 'Image upload' : 'File upload';
}

function autoTitleIfNeeded(conversationId: string, prompt: string | null) {
  const conv = store.getById('conversations', conversationId);
  if (!conv || conv.subject || !prompt) return;

  const text = prompt.slice(0, 60);
  const subject = text.length < prompt.length ? text + '...' : text;
  store.update('conversations', conversationId, { subject });
}

// ---------------------------------------------------------------------------
// Conversation history builder
// ---------------------------------------------------------------------------

function parseAttachments(raw: unknown): Array<Record<string, unknown>> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function cloneAttachmentRecords(
  attachments: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return attachments.map((attachment) => ({ ...attachment }));
}

function getMessageTypeForAttachments(
  attachments: Array<Record<string, unknown>>,
): AgentConversationMessageType | 'image' {
  if (attachments.length === 0) return 'text';
  return attachments.every((attachment) => attachment.type === 'image') ? 'image' : 'file';
}

function storageDiskPath(storagePath: string): string {
  return path.resolve(STORAGE_DIR, '.' + storagePath);
}

interface ConversationAttachmentDiskPaths {
  imagePaths: string[];
  filePaths: string[];
  attachments: RunnerAttachment[];
}

/** Returns disk paths for attachments across the full active path in chronological order. */
export function getConversationAttachmentDiskPaths(
  conversationId: string,
  leafMessageId?: string,
): ConversationAttachmentDiskPaths {
  const activePath = leafMessageId
    ? getMessagePathToLeaf(conversationId, leafMessageId)
    : isTreeEnabledConversation(conversationId)
      ? getActiveMessagePath(conversationId)
      : listConversationMessages(conversationId);

  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const runnerAttachments: RunnerAttachment[] = [];
  const seenStoragePaths = new Set<string>();
  for (const message of activePath) {
    const attachments = parseAttachments(message.attachments);
    for (const att of attachments) {
      if (typeof att.storagePath !== 'string' || seenStoragePaths.has(att.storagePath)) {
        continue;
      }
      seenStoragePaths.add(att.storagePath);
      const diskPath = storageDiskPath(att.storagePath);
      if (!fs.existsSync(diskPath)) continue;
      const type = att.type === 'image' ? 'image' : 'file';
      const manifest: Record<string, unknown> = { storagePath: att.storagePath };
      if (typeof att.localPath === 'string') manifest.localPath = att.localPath;
      if (att.metadata && typeof att.metadata === 'object' && !Array.isArray(att.metadata)) {
        manifest.metadata = att.metadata;
      }
      runnerAttachments.push(
        createRunnerAttachmentFromPath(type, diskPath, {
          filename: typeof att.fileName === 'string' ? att.fileName : undefined,
          mimeType: typeof att.mimeType === 'string' ? att.mimeType : undefined,
          sizeBytes: typeof att.fileSize === 'number' ? att.fileSize : undefined,
          manifest,
        }),
      );
      if (type === 'image') imagePaths.push(diskPath);
      else filePaths.push(diskPath);
    }
  }
  return { imagePaths, filePaths, attachments: runnerAttachments };
}

function describeAttachmentLabel(attachments: Array<Record<string, unknown>>): string | null {
  const imageNames = attachments
    .filter((attachment) => attachment.type === 'image' && typeof attachment.fileName === 'string')
    .map((attachment) => attachment.fileName as string);
  const fileNames = attachments
    .filter((attachment) => attachment.type !== 'image' && typeof attachment.fileName === 'string')
    .map((attachment) => attachment.fileName as string);

  const parts: string[] = [];
  if (imageNames.length === 1) {
    parts.push(`Image: ${imageNames[0]}`);
  } else if (imageNames.length > 1) {
    parts.push(`Images: ${imageNames.join(', ')}`);
  }
  if (fileNames.length === 1) {
    parts.push(`File: ${fileNames[0]}`);
  } else if (fileNames.length > 1) {
    parts.push(`Files: ${fileNames.join(', ')}`);
  }

  return parts.length > 0 ? `[${parts.join(' | ')}]` : null;
}

function formatMessageForPrompt(msg: Record<string, unknown>): string {
  const role = msg.direction === 'outbound' ? 'User' : 'Assistant';
  const content = (msg.content as string) || '';

  const attachments = parseAttachments(msg.attachments);
  if (attachments.length > 0) {
    const attachmentLabel = describeAttachmentLabel(attachments) ?? '[Attachment]';
    return content ? `${role}: ${attachmentLabel}\n${content}` : `${role}: ${attachmentLabel}`;
  }

  return `${role}: ${content}`;
}

/**
 * Build the full prompt string from conversation history.
 * If currentPrompt is provided, it is appended as the latest User turn (for text messages).
 * If omitted, the history itself is the complete conversation (used when image is the last turn).
 */
function buildPromptWithHistory(
  agentId: string,
  conversationId: string,
  currentPrompt?: string,
  leafMessageId?: string,
  options: { turnId?: string | null } = {},
): string {
  const history = leafMessageId
    ? getMessagePathToLeaf(conversationId, leafMessageId)
    : isTreeEnabledConversation(conversationId)
      ? getActiveMessagePath(conversationId)
      : listConversationMessages(conversationId);

  const triggerContext = buildTriggerContext('chat', {
    agentId,
    conversationId,
    chatTurnId: options.turnId ?? undefined,
    latestUserMessageId: leafMessageId,
  });

  const lines: string[] = [];
  for (const msg of history) {
    const metadata = parseMetadata(msg.metadata);
    const isProgressUpdate = metadata?.agentChatUpdate === true && metadata?.isFinal === false;
    if (isProgressUpdate) continue;

    lines.push(formatMessageForPrompt(msg));
  }

  if (currentPrompt) {
    lines.push(`User: ${currentPrompt}`);
  }

  const latestUserMessage = currentPrompt
    ? `User: ${currentPrompt}`
    : formatLatestUserMessageForPrompt(history);
  const latestUserSection = latestUserMessage
    ? `Latest User Message\n${latestUserMessage}\n\n`
    : '';

  return `${triggerContext}${latestUserSection}Continue the conversation below. Only respond to the latest User message.\n\n${lines.join('\n\n')}`;
}

function formatLatestUserMessageForPrompt(history: Record<string, unknown>[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const msg = history[index];
    if (msg?.direction === 'outbound') {
      return formatMessageForPrompt(msg);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared subprocess environment builder
// ---------------------------------------------------------------------------

type TriggerType = 'chat' | 'cron_job' | 'card_assignment';

interface AgentProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  runStartedAt: number;
}

function getTerminalRunErrorMessage(runId: string | null): string | null {
  if (!runId) return null;
  const terminalRun = getAgentRun(runId);
  if (terminalRun?.status !== 'error') return null;
  return (
    (typeof terminalRun.errorMessage === 'string' && terminalRun.errorMessage.trim()) ||
    'Agent run did not produce a clean completion.'
  );
}

interface AgentProcessOptions {
  agentId: string;
  agent: {
    name: string;
    model: string;
    modelId: string | null;
    thinkingLevel: 'low' | 'medium' | 'high' | null;
    apiKeyId: string;
    workspaceApiKey: string | null;
    avatarIcon?: string | null;
    avatarBgColor?: string | null;
    avatarLogoColor?: string | null;
    groupId?: string | null;
  };
  runKey: string;
  prompt: string;
  attachments?: RunnerAttachment[];
  imagePaths?: string[];
  filePaths?: string[];
  triggerType: TriggerType;
  triggerRef?: { conversationId?: string; cardId?: string; cronJobId?: string };
  responseParentId?: string | null;
  turnId?: string | null;
  onStdoutChunk?: (text: string) => void;
  onRunCreated?: (runId: string) => void;
  onExit: (result: AgentProcessResult) => void;
  onSpawnError: (error: Error) => void;
}

function buildTriggerContext(
  trigger: TriggerType,
  fields: Record<string, string | undefined>,
): string {
  const lines = ['Trigger Context', `trigger: ${trigger}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value) lines.push(`${key}: ${value}`);
  }
  lines.push('End Trigger Context', '');
  return `${lines.join('\n')}\n`;
}

async function buildChildEnv(
  agentId: string,
  agent: { apiKeyId: string; workspaceApiKey: string | null },
): Promise<Record<string, string | undefined>> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of OPENWORK_CHILD_ENV_BLOCKLIST) {
    if (key in childEnv) {
      delete childEnv[key];
    }
  }
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  delete childEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

  if (agent.apiKeyId) {
    const apiKey = await getApiKeyRecord(agent.apiKeyId);
    if (apiKey) {
      childEnv.ANTHROPIC_API_KEY = childEnv.ANTHROPIC_API_KEY || '';
      childEnv.OPENAI_API_KEY = childEnv.OPENAI_API_KEY || '';
    }
  }

  if (agent.workspaceApiKey) {
    const protocol = env.TLS_CERT_PATH ? 'https' : 'http';
    const host = env.HOST === '0.0.0.0' ? 'localhost' : env.HOST;
    childEnv.WORKSPACE_API_URL = `${protocol}://${host}:${env.PORT}`;
    childEnv.WORKSPACE_API_KEY = agent.workspaceApiKey;
  }

  for (const entry of await listRuntimeAgentEnvVarBindings(agentId)) {
    childEnv[entry.key] = entry.value;
  }

  // Provide the projects output directory so agents never build inside the agent data dir
  const projectsDir = path.resolve(env.PROJECTS_DIR);
  fs.mkdirSync(projectsDir, { recursive: true });
  childEnv.PROJECTS_DIR = projectsDir;

  return childEnv;
}

function markAgentLastActivity(agentId: string) {
  store.update('agents', agentId, {
    lastActivity: new Date().toISOString(),
  });
}

function listAgentApiUpdates(conversationId: string, runStartedAt: number) {
  return listMessagesByConversationId(conversationId, {
    order: 'asc',
    where: (r) =>
      r.direction === 'inbound' &&
      new Date(String(r.createdAt)).getTime() >= runStartedAt &&
      parseMetadata(r.metadata)?.agentChatUpdate === true,
  }) as Record<string, unknown>[];
}

function findFinalAgentApiMessage(messages: Record<string, unknown>[]) {
  return (
    [...messages].reverse().find((msg) => parseMetadata(msg.metadata)?.isFinal === true) ?? null
  );
}

function listConversationInboundMessages(conversationId: string, sinceMs: number) {
  return listMessagesByConversationId(conversationId, {
    order: 'asc',
    where: (r) => r.direction === 'inbound' && new Date(String(r.createdAt)).getTime() >= sinceMs,
  }) as Record<string, unknown>[];
}

function findExistingFinalMessageFromRun(
  conversationId: string,
  runStartedAt: number,
  expectedContent: string | null,
  options?: { responseParentId?: string | null; runId?: string | null },
): Record<string, unknown> | null {
  const inboundMessages = listConversationInboundMessages(conversationId, runStartedAt);
  if (inboundMessages.length === 0) return null;

  if (options?.runId) {
    const runMatch = [...inboundMessages].reverse().find((msg) => {
      const meta = parseMetadata(msg.metadata);
      return meta?.runId === options.runId;
    });
    if (runMatch) return runMatch;
  }

  const candidateMessages = inboundMessages.filter((msg) => {
    if (msg.type !== 'text') return false;
    const meta = parseMetadata(msg.metadata);
    if (meta?.agentChatUpdate === true && meta?.isFinal === false) return false;
    if (Object.prototype.hasOwnProperty.call(options ?? {}, 'responseParentId')) {
      return ((msg.parentId as string | null) ?? null) === (options?.responseParentId ?? null);
    }
    return true;
  });

  if (candidateMessages.length === 0) return null;

  if (expectedContent && expectedContent.trim().length > 0) {
    const contentMatch = [...candidateMessages].reverse().find((msg) => {
      return ((msg.content as string) || '').trim() === expectedContent.trim();
    });
    if (contentMatch) return contentMatch;
  }

  return [...candidateMessages].reverse()[0] ?? null;
}

function saveAgentRunResponse(
  conversationId: string,
  content: string,
  parentId?: string | null,
  metadata?: Record<string, unknown> | null,
  options?: { updateActiveBranch?: boolean },
): Record<string, unknown> {
  // Enrich metadata with model info from the run record
  let enrichedMetadata = metadata;
  const runId = metadata?.runId as string | null | undefined;
  if (runId) {
    const run = store.getById('agent_runs', runId);
    if (run) {
      enrichedMetadata = { ...metadata };
      if (run.model) (enrichedMetadata as Record<string, unknown>).model = run.model;
      if (run.modelId) (enrichedMetadata as Record<string, unknown>).modelId = run.modelId;
    }
  }
  return saveAgentConversationMessage({
    conversationId,
    direction: 'inbound',
    content,
    type: 'text',
    parentId,
    metadata: enrichedMetadata,
    updateActiveBranch: options?.updateActiveBranch,
  });
}

function attachRunIdToMessage(
  message: Record<string, unknown>,
  runId: string | null,
): Record<string, unknown> {
  if (!runId || typeof message.id !== 'string') return message;
  const current = parseMetadata(message.metadata) ?? {};
  if (current.runId === runId && current.model !== undefined) return message;
  const next: Record<string, unknown> = { ...current, runId };
  // Attach model info from the run record so chat messages show provider/model
  const run = store.getById('agent_runs', runId);
  if (run) {
    if (run.model) next.model = run.model;
    if (run.modelId) next.modelId = run.modelId;
  }
  const updated = store.update('messages', message.id, {
    metadata: JSON.stringify(next),
  });
  return updated ?? { ...message, metadata: JSON.stringify(next) };
}

function resolveFinalMessageForCompletedRun(
  conversationId: string,
  runStartedAt: number,
  rawStdout: string,
  responseParentId?: string | null,
  runId?: string | null,
  options?: { updateActiveBranch?: boolean },
): Record<string, unknown> | null {
  const updatesFromApi = listAgentApiUpdates(conversationId, runStartedAt);
  const finalApiMessage = findFinalAgentApiMessage(updatesFromApi);
  if (finalApiMessage) return attachRunIdToMessage(finalApiMessage, runId ?? null);

  const stdoutText = extractFinalResponseText(rawStdout);
  const existingFinal = findExistingFinalMessageFromRun(
    conversationId,
    runStartedAt,
    stdoutText || null,
    {
      responseParentId: responseParentId ?? null,
      runId: runId ?? null,
    },
  );
  if (existingFinal) return attachRunIdToMessage(existingFinal, runId ?? null);

  if (stdoutText) {
    return saveAgentRunResponse(
      conversationId,
      stdoutText,
      responseParentId,
      {
        runId: runId ?? null,
      },
      {
        updateActiveBranch: options?.updateActiveBranch,
      },
    );
  }
  if (updatesFromApi.length > 0) {
    return attachRunIdToMessage(updatesFromApi[updatesFromApi.length - 1], runId ?? null);
  }
  return null;
}

async function persistFailedCardAssignmentStartupRun(params: {
  agentId: string;
  agent: AgentProcessOptions['agent'];
  cardId: string;
  prompt: string;
  errorMessage: string;
  onRunCreated?: (runId: string) => void;
}): Promise<string | null> {
  const run = createAgentRun({
    agentId: params.agentId,
    agentName: params.agent.name,
    avatarIcon: params.agent.avatarIcon ?? null,
    avatarBgColor: params.agent.avatarBgColor ?? null,
    avatarLogoColor: params.agent.avatarLogoColor ?? null,
    model: params.agent.model ?? null,
    modelId: params.agent.modelId ?? null,
    triggerType: 'card_assignment',
    cardId: params.cardId,
    triggerPrompt: params.prompt,
    executor: 'remote',
    status: 'running',
  });
  const runId = String(run.id);
  params.onRunCreated?.(runId);
  await failAgentRunCompletionSideEffect(runId, params.errorMessage, {
    stderr: params.errorMessage,
  });
  return runId;
}

// Track active remote runner jobs per run key so parallel chats/tasks can run.
const remoteRunKeys = new Set<string>();
const queueProcessors = new Set<string>();
const queueDrainTimers = new Map<string, QueueDrainTimer>();
let queueDrainTransactionLock: Promise<void> = Promise.resolve();

function processKey(
  agentId: string,
  conversationId: string,
  targetMessageId?: string | null,
): string {
  if (targetMessageId) return `${agentId}:${conversationId}:msg:${targetMessageId}`;
  return `${agentId}:${conversationId}`;
}

function hasLivePersistedChatRun(
  agentId: string,
  conversationId: string,
  targetMessageId?: string | null,
): boolean {
  const runs = findLivePersistedChatRuns(
    targetMessageId === undefined
      ? { agentId, conversationId }
      : { agentId, conversationId, targetMessageId },
  );
  // Any persisted chat run still marked running should keep the conversation "busy" so the
  // Agents sidebar matches /agent-runs and the chat view (which lists running rows without
  // filtering on executor). Legacy rows may omit `executor`; schema default is remote.
  return runs.length > 0;
}

function hasRunningProcessForTargetMessage(
  agentId: string,
  conversationId: string,
  targetMessageId: string,
): boolean {
  if (remoteRunKeys.has(processKey(agentId, conversationId, targetMessageId))) {
    return true;
  }
  return hasLivePersistedChatRun(agentId, conversationId, targetMessageId);
}

/** Check if ANY process is running for a given conversation (across all branches). */
function hasRunningProcessForConversation(agentId: string, conversationId: string): boolean {
  const prefix = `${agentId}:${conversationId}`;
  for (const key of remoteRunKeys) {
    if (key === prefix || key.startsWith(`${prefix}:`)) return true;
  }
  if (hasLivePersistedChatRun(agentId, conversationId)) return true;
  return false;
}

function queueKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

function parseIsoDateMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getQueueItemRunId(item: Record<string, unknown> | null | undefined): string | null {
  return nonEmptyString(item?.runId) ?? nonEmptyString(item?.lastRunId);
}

function getQueueItemTurnId(item: Record<string, unknown> | null | undefined): string | null {
  return nonEmptyString(item?.turnId);
}

function getTurnUserMessageId(turn: Record<string, unknown> | null | undefined): string | null {
  return nonEmptyString(turn?.userMessageId);
}

function runStatusToRecoveredTurnStatus(
  run: Record<string, unknown>,
): 'queued' | 'running' | 'completed' | 'failed' | 'stopped' {
  if (run.killedByUser === true || run.errorMessage === 'Killed by user') return 'stopped';
  if (run.status === 'queued') return 'queued';
  if (run.status === 'running') return 'running';
  if (run.status === 'completed') return 'completed';
  return 'failed';
}

function isRunMarkedKilledByUser(runId: string | null): boolean {
  if (!runId) return false;
  const run = store.getById('agent_runs', runId);
  if (!run) return false;
  return run.killedByUser === true || run.errorMessage === 'Killed by user';
}

function isCurrentRunKilledByUser(runId: string | null, errorMessage?: string | null): boolean {
  return isRunMarkedKilledByUser(runId) || errorMessage === 'Killed by user';
}

function shouldAttemptFallbackRetry(options: {
  runId: string | null;
  errorMessage?: string | null;
  isFallback: boolean;
  hasFallback: boolean;
}): boolean {
  if (options.isFallback || !options.hasFallback) return false;
  return !isCurrentRunKilledByUser(options.runId, options.errorMessage);
}

function listConversationQueueItems(
  agentId: string,
  conversationId: string,
): Record<string, unknown>[] {
  return listConversationChatQueueItems(agentId, conversationId) as Record<string, unknown>[];
}

function sanitizeQueueItemForChat(
  item: Record<string, unknown>,
  queuePosition: number | null = null,
): Record<string, unknown> {
  const turnId = getQueueItemTurnId(item);
  const turn = turnId ? getAgentChatTurn(turnId) : null;
  const runId = getQueueItemRunId(item);
  const base = {
    ...item,
    turnId,
    turnStatus: nonEmptyString(turn?.status),
    queuePosition,
    execution: {
      turnId,
      queue: {
        id: nonEmptyString(item.id),
        status: nonEmptyString(item.status) ?? 'queued',
        position: queuePosition,
        runId,
        attempts: typeof item.attempts === 'number' ? item.attempts : null,
        maxAttempts: typeof item.maxAttempts === 'number' ? item.maxAttempts : null,
        nextAttemptAt: nonEmptyString(item.nextAttemptAt),
        startedAt: nonEmptyString(item.startedAt),
        completedAt: nonEmptyString(item.completedAt),
        usedFallback: item.usedFallback === true,
        fallbackModel: nonEmptyString(item.fallbackModel),
      },
      run: runId ? { id: runId, turnId } : null,
    },
  };

  if (typeof item.errorMessage !== 'string' || !item.errorMessage) {
    return base;
  }

  if (item.status !== 'failed' && item.status !== 'queued') {
    return base;
  }

  const summarizedError = summarizeQueueErrorForChat(item.errorMessage);
  if (summarizedError === item.errorMessage) {
    return base;
  }

  return {
    ...base,
    errorMessage: summarizedError,
  };
}

function getQueueItemMode(item: Record<string, unknown>): QueueExecutionMode {
  return (item.mode as QueueExecutionMode | undefined) ?? 'append_prompt';
}

function isPendingQueueItem(item: Record<string, unknown>): boolean {
  return item.status === 'queued' || item.status === 'processing';
}

function reconcileTerminalProcessingExecutionItems(agentId: string, conversationId: string) {
  const processingItems = listConversationQueueItems(agentId, conversationId).filter(
    (item) => item.status === 'processing',
  );
  for (const item of processingItems) {
    recoverInterruptedQueueItemFromRun(item);
  }
}

function hasPendingExecutionItems(agentId: string, conversationId: string): boolean {
  reconcileTerminalProcessingExecutionItems(agentId, conversationId);
  return listConversationQueueItems(agentId, conversationId).some((item) =>
    isPendingQueueItem(item),
  );
}

function getQueuedAppendPromptCount(agentId: string, conversationId: string): number {
  return countQueuedAppendPromptsForConversation(agentId, conversationId);
}

function conversationHasActiveExecutionFailure(agentId: string, conversationId: string): boolean {
  return listConversationQueueItems(agentId, conversationId).some(
    (item) => item.status === 'failed',
  );
}

function clearQueueDrainTimerForKey(key: string) {
  const existing = queueDrainTimers.get(key);
  if (!existing) return;
  clearTimeout(existing.timer);
  queueDrainTimers.delete(key);
}

function scheduleQueueDrain(agentId: string, conversationId: string, delayMs: number) {
  const key = queueKey(agentId, conversationId);
  const safeDelay = Math.max(0, delayMs);
  const dueAt = Date.now() + safeDelay;
  const existing = queueDrainTimers.get(key);
  if (existing && existing.dueAt <= dueAt) return;

  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    queueDrainTimers.delete(key);
    void drainConversationQueue(agentId, conversationId);
  }, safeDelay);
  timer.unref();
  queueDrainTimers.set(key, { timer, dueAt });
}

async function withQueueDrainTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const previous = queueDrainTransactionLock;
  let release!: () => void;
  queueDrainTransactionLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// runAgentProcess — dispatches runner jobs and writes logs to files
// ---------------------------------------------------------------------------

/**
 * Working directory for an agent CLI process: repo-backed agents execute from the repository
 * root, while the agent folder remains the source of AGENTS/skills context. Subfolder-mode chats
 * use `conversations/<id>/` under that execution root (materialized before spawn).
 */
export function resolveAgentChatProcessWorkingDirectory(
  agentId: string,
  conversationId: string | undefined,
): string {
  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }
  const agentRecord = agent as unknown as Record<string, unknown>;
  const executionRoot = resolveAgentExecutionRootFromRecord(agentRecord, agentId);
  if (!conversationId) return executionRoot;
  const conv = store.getById('conversations', conversationId);
  const { workspaceMode, workspaceRelativePath } = ensureConversationWorkspaceMetadata(
    agentId,
    conv,
  );
  if (workspaceMode !== 'subfolder') return executionRoot;
  const agentWorkspaceRoot = resolveAgentWorkspacePathFromRecord(agentRecord, agentId);
  ensureConversationSubfolderWorkspace(agentWorkspaceRoot, executionRoot, conversationId);
  return resolveSubfolderProcessCwd(
    executionRoot,
    conversationId,
    workspaceMode,
    workspaceRelativePath,
  );
}

function buildRemoteRunnerEnv(childEnv: Record<string, string | undefined>) {
  const safeEnv: Record<string, string | undefined> = {};
  const safeKeys = new Set([
    'WORKSPACE_API_URL',
    'WORKSPACE_API_KEY',
    'PROJECT_PORT',
    'PROJECTS_DIR',
    'PWD',
  ]);

  for (const key of safeKeys) {
    if (childEnv[key] !== undefined) {
      safeEnv[key] = childEnv[key];
    }
  }

  for (const [key, value] of Object.entries(childEnv)) {
    if (value !== undefined && value !== '' && process.env[key] !== value) {
      safeEnv[key] = value;
    }
  }

  return safeEnv;
}

function resolveRemoteRunnerRoutingScope(agent: {
  groupId?: string | null;
}): { userId: string; workspaceId: string } | null {
  const scopes = runnerRoutingScopesForAgentGroup(agent.groupId);
  return scopes[0] ?? null;
}

function resolveRemoteRunnerWorkspaceId(agent: { groupId?: string | null }): string | null {
  return resolveRemoteRunnerRoutingScope(agent)?.workspaceId ?? null;
}

function resolveAgentRemoteRunnerWorkspaceId(agentId: string): string | null {
  const agent = getAgent(agentId);
  return agent ? resolveRemoteRunnerWorkspaceId(agent) : null;
}

function resolveAgentRemoteRunnerRoutingScope(
  agentId: string,
): { userId: string; workspaceId: string } | null {
  const agent = getAgent(agentId);
  return agent ? resolveRemoteRunnerRoutingScope(agent) : null;
}

function resolveAgentRemoteRunnerProvider(agentId: string): RunnerProvider | null {
  const agent = getAgent(agentId);
  return agent?.model ? inferRunnerProvider(agent.model) : null;
}

function getAgentRunnerWorkspaceIdOrThrow(agentId: string): string {
  const workspaceId = resolveAgentRemoteRunnerWorkspaceId(agentId);
  if (!workspaceId) {
    throw AgentChatError.conflict(
      'agent_runner_workspace_missing',
      'This agent is not assigned to a workspace with a runner. Add the agent to a workspace, then try again.',
    );
  }
  return workspaceId;
}

function getAgentRunnerProviderOrThrow(agentId: string): RunnerProvider {
  const agent = getAgent(agentId);
  const provider = agent?.model ? inferRunnerProvider(agent.model) : null;
  if (!provider) {
    throw AgentChatError.conflict(
      'agent_runner_provider_missing',
      'This agent does not have a supported remote runner provider configured. Choose a Codex, Claude, Qwen, Cursor, or OpenCode model, then try again.',
      'Update the agent model/provider before starting a runner-backed job.',
    );
  }
  return provider;
}

async function runAgentProcess(options: AgentProcessOptions): Promise<string> {
  // Wait for a global concurrency slot before dispatching
  await waitForConcurrencySlot();
  let allocatedPort: number | null = null;

  try {
    if (options.triggerType === 'chat') {
      const turnId = options.turnId ?? null;
      const conversationId = options.triggerRef?.conversationId ?? null;
      const turn = turnId ? getAgentChatTurn(turnId) : null;
      if (
        !turn ||
        turn.agentId !== options.agentId ||
        turn.conversationId !== conversationId
      ) {
        throw new Error('Chat execution requires a durable turn linked to this conversation');
      }
      if (turn.status === 'stopped' || turn.status === 'failed' || turn.status === 'superseded') {
        throw new Error('Chat execution cannot start for a terminal or superseded turn');
      }
    }

    const routingScope = resolveRemoteRunnerRoutingScope(options.agent);
    const remoteWorkspaceId = routingScope?.workspaceId ?? null;
    const remoteRunnerUserId = routingScope?.userId ?? null;
    const provider = inferRunnerProvider(options.agent.model);
    if (!provider) {
      throw new Error(`Unsupported remote runner model/provider: ${options.agent.model}`);
    }
    if (
      !remoteWorkspaceId ||
      !remoteRunnerUserId ||
      !hasAvailableRemoteAgentRunner(remoteRunnerUserId, remoteWorkspaceId, provider)
    ) {
      throw new Error(
        getRemoteAgentRunnerUnavailableMessage(remoteRunnerUserId, remoteWorkspaceId, provider),
      );
    }

    const workDir = resolveAgentChatProcessWorkingDirectory(
      options.agentId,
      options.triggerRef?.conversationId,
    );
    const childEnv = await buildChildEnv(options.agentId, options.agent);

    // Allocate a random port so the agent's project never conflicts with others
    allocatedPort = await allocatePort();
    const projectPort = allocatedPort;
    childEnv.PROJECT_PORT = String(projectPort);
    childEnv.PWD = workDir;

    // Record the agent run first to get runId for log directory
    const agentRun = createAgentRun({
      agentId: options.agentId,
      agentName: options.agent.name,
      avatarIcon: options.agent.avatarIcon ?? null,
      avatarBgColor: options.agent.avatarBgColor ?? null,
      avatarLogoColor: options.agent.avatarLogoColor ?? null,
      model: options.agent.model ?? null,
      modelId: options.agent.modelId ?? null,
      triggerType: options.triggerType,
      conversationId: options.triggerRef?.conversationId,
      cardId: options.triggerRef?.cardId,
      cronJobId: options.triggerRef?.cronJobId,
      triggerPrompt: options.prompt,
      responseParentId: options.responseParentId ?? null,
      turnId: options.turnId ?? null,
      executor: 'remote',
      status: 'queued',
    });
    const runId = agentRun.id as string;
    options.onRunCreated?.(runId);

    // Create run log directory
    const runLogDir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(runLogDir, { recursive: true });

    const stdoutPath = path.join(runLogDir, 'stdout.log');
    const stderrPath = path.join(runLogDir, 'stderr.log');
    fs.closeSync(fs.openSync(stdoutPath, 'w'));
    fs.closeSync(fs.openSync(stderrPath, 'w'));

    store.update('agent_runs', runId, {
      status: 'running',
      stdoutPath,
      stderrPath,
      executor: 'remote',
      pid: null,
    });

    remoteRunKeys.add(options.runKey);
    const runStartedAt = Date.now();
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' });
    const runnerIntent = buildRunnerJobIntent({
      runId,
      agentId: options.agentId,
      workspaceId: remoteWorkspaceId,
      agent: options.agent,
      prompt: options.prompt,
      workDir,
      childEnv: buildRemoteRunnerEnv(childEnv),
      attachments: options.attachments,
      imagePaths: options.imagePaths,
      filePaths: options.filePaths,
    });

    void dispatchRemoteAgentJob(
      {
        userId: remoteRunnerUserId,
        workspaceId: remoteWorkspaceId,
        intent: runnerIntent,
      },
      {
        onStdout: (text) => {
          stdoutStream.write(text);
          options.onStdoutChunk?.(text);
        },
        onStderr: (text) => {
          stderrStream.write(text);
        },
      },
    )
      .then(async (result) => {
        stdoutStream.end();
        stderrStream.end();
        remoteRunKeys.delete(options.runKey);
        releasePort(projectPort);
        releaseConcurrencySlot();
        markAgentLastActivity(options.agentId);

        const hasError = (result.code ?? 1) !== 0;
        const errorMsg = hasError
          ? `Remote runner exited with code ${result.code ?? 'unknown'}`
          : null;
        await completeAgentRun(runId, errorMsg, {
          stdout: result.stdout,
          stderr: result.stderr,
        }).catch((err) => {
          console.error(`[agent-chat] completeAgentRun failed for ${runId}:`, err);
        });
        options.onExit({
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          runStartedAt,
        });
      })
      .catch((err: Error) => {
        stdoutStream.end();
        stderrStream.end();
        remoteRunKeys.delete(options.runKey);
        releasePort(projectPort);
        releaseConcurrencySlot();
        const resultLogs =
          err instanceof RemoteAgentJobError
            ? { stdout: err.stdout, stderr: err.stderr || err.message }
            : { stderr: err.message };
        void completeAgentRun(runId, err.message, resultLogs).catch((e) => {
          console.error(`[agent-chat] completeAgentRun failed for ${runId}:`, e);
        });
        options.onSpawnError(err);
      });

    return runId;
  } catch (err) {
    if (allocatedPort !== null) {
      releasePort(allocatedPort);
    }
    releaseConcurrencySlot();
    throw err;
  }
}

function readRunStdout(run: Record<string, unknown>): string {
  if (typeof run.stdout === 'string' && run.stdout.length > 0) return run.stdout;
  if (typeof run.stdoutPath !== 'string' || !run.stdoutPath) return '';
  try {
    return fs.readFileSync(run.stdoutPath, 'utf-8');
  } catch {
    return '';
  }
}

export function recoverCompletedChatRunsOnStartup(): number {
  const completedChatRuns = store
    .getAll('agent_runs')
    .filter(
      (r: Record<string, unknown>) =>
        r.triggerType === 'chat' &&
        r.status === 'completed' &&
        typeof r.conversationId === 'string' &&
        !isRunMarkedKilledByUser(typeof r.id === 'string' ? r.id : null),
    )
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        parseIsoDateMs(a.startedAt) - parseIsoDateMs(b.startedAt),
    );

  let recoveredCount = 0;

  for (const run of completedChatRuns) {
    const runId = typeof run.id === 'string' ? run.id : null;
    const conversationId = typeof run.conversationId === 'string' ? run.conversationId : null;
    if (!runId || !conversationId) continue;

    const runStartedAtMs = parseIsoDateMs(run.startedAt);
    const runStartedAt = Number.isFinite(runStartedAtMs) ? runStartedAtMs : Date.now();
    const rawStdout = readRunStdout(run);
    const responseParentId =
      typeof run.responseParentId === 'string' ? (run.responseParentId as string) : null;

    const existingFinal = findExistingFinalMessageFromRun(
      conversationId,
      runStartedAt,
      extractFinalResponseText(rawStdout) || null,
      {
        responseParentId,
        runId,
      },
    );
    if (existingFinal) continue;

    const recoveredMessage = resolveFinalMessageForCompletedRun(
      conversationId,
      runStartedAt,
      rawStdout,
      responseParentId,
      runId,
      { updateActiveBranch: false },
    );

    if (recoveredMessage) {
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    console.log(
      `[agent-chat] Recovered ${recoveredCount} missing chat message${recoveredCount === 1 ? '' : 's'} from completed runs`,
    );
  }

  return recoveredCount;
}

// ---------------------------------------------------------------------------
// Execute prompt (chat)
// ---------------------------------------------------------------------------

export interface ExecutePromptCallbacks {
  onRunCreated?: (runId: string) => void;
  onFallbackStarted?: (model: string) => void;
  onDone: (message: Record<string, unknown>) => void;
  onError: (error: string) => void;
}

function attachFallbackMetadataToMessage(
  message: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
  if (typeof message.id !== 'string') return message;
  const current = parseMetadata(message.metadata) ?? {};
  const next = { ...current, fallbackRetry: true, fallbackModel };
  const updated = store.update('messages', message.id, {
    metadata: JSON.stringify(next),
  });
  return updated ?? { ...message, metadata: JSON.stringify(next) };
}

function wrapChatExecuteCallbacks(callbacks: ExecutePromptCallbacks): ExecutePromptCallbacks {
  let fallbackModelName: string | null = null;
  return {
    onRunCreated: callbacks.onRunCreated,
    onFallbackStarted: (model: string) => {
      fallbackModelName = model;
      callbacks.onFallbackStarted?.(model);
    },
    onDone: (message) => {
      const finalMessage =
        fallbackModelName !== null
          ? attachFallbackMetadataToMessage(message, fallbackModelName)
          : message;
      callbacks.onDone(finalMessage);
    },
    onError: callbacks.onError,
  };
}

function spawnChatProcess(
  agentId: string,
  conversationId: string,
  fullPrompt: string,
  attachmentPaths: ConversationAttachmentDiskPaths,
  callbacks: ExecutePromptCallbacks,
  options?: {
    isFallback?: boolean;
    responseParentId?: string | null;
    targetMessageId?: string | null;
    turnId?: string | null;
  },
) {
  const isFallback = options?.isFallback ?? false;
  const responseParentId = options?.responseParentId ?? null;
  const targetMessageId = options?.targetMessageId ?? null;
  const turnId = options?.turnId ?? null;

  void Promise.all([prepareAgentWorkspaceAccess(agentId), getFallbackModelConfig()])
    .then(([agent, globalFallback]) => {
      if (!agent) {
        callbacks.onError('Agent not found');
        return;
      }

      // If this is a fallback retry, override agent model with global fallback settings
      const effectiveAgent = isFallback ? applyFallbackModel(agent, globalFallback) : agent;
      if (isFallback && !effectiveAgent) {
        callbacks.onError('Fallback model is not configured');
        return;
      }

      const key = processKey(agentId, conversationId, targetMessageId);
      const hasImages = attachmentPaths.imagePaths.length > 0;
      const hasFiles = attachmentPaths.filePaths.length > 0;
      let spawnedRunId: string | null = null;

      void runAgentProcess({
        agentId,
        agent: effectiveAgent!,
        runKey: key,
        prompt: fullPrompt,
        attachments:
          attachmentPaths.attachments.length > 0 ? attachmentPaths.attachments : undefined,
        imagePaths: hasImages ? attachmentPaths.imagePaths : undefined,
        filePaths: hasFiles ? attachmentPaths.filePaths : undefined,
        triggerType: 'chat',
        triggerRef: { conversationId },
        responseParentId,
        turnId,
        onRunCreated: (runId) => {
          spawnedRunId = runId;
          callbacks.onRunCreated?.(runId);
        },
        onExit: ({ code, stdout, stderr, runStartedAt }) => {
          if (isRunMarkedKilledByUser(spawnedRunId)) {
            callbacks.onError('Killed by user');
            return;
          }

          const terminalRunError = getTerminalRunErrorMessage(spawnedRunId);
          if (terminalRunError) {
            if (!isFallback) {
              const fallback = globalFallback;
              if (fallback) {
                console.log(
                  `[agent-chat] Primary model failed for agent ${agentId}: ${terminalRunError}. Retrying with fallback model "${fallback.model}"...`,
                );
                callbacks.onFallbackStarted?.(fallback.model);
                spawnChatProcess(agentId, conversationId, fullPrompt, attachmentPaths, callbacks, {
                  isFallback: true,
                  responseParentId,
                  targetMessageId,
                  turnId,
                });
                return;
              }
            }
            callbacks.onError(terminalRunError);
            return;
          }

          if ((code ?? 1) !== 0 && !stdout.trim()) {
            // Primary model failed — attempt fallback if configured and not already a fallback
            if (!isFallback) {
              const fallback = globalFallback;
              if (fallback) {
                const errMsg = stderr.trim() || `Process exited with code ${code}`;
                console.log(
                  `[agent-chat] Primary model failed for agent ${agentId}: ${errMsg}. Retrying with fallback model "${fallback.model}"...`,
                );
                callbacks.onFallbackStarted?.(fallback.model);
                spawnChatProcess(agentId, conversationId, fullPrompt, attachmentPaths, callbacks, {
                  isFallback: true,
                  responseParentId,
                  targetMessageId,
                  turnId,
                });
                return;
              }
            }
            const errMsg = stderr.trim() || `Process exited with code ${code}`;
            callbacks.onError(errMsg);
            return;
          }

          const updatesFromApi = listAgentApiUpdates(conversationId, runStartedAt);
          const finalApiMessage = findFinalAgentApiMessage(updatesFromApi);
          // extractFinalResponseText handles both plain text and stream-json output gracefully.
          const stdoutText = extractFinalResponseText(stdout);

          let msg: Record<string, unknown>;
          if (finalApiMessage) {
            msg = attachRunIdToMessage(finalApiMessage, spawnedRunId);
          } else if (stdoutText) {
            msg = saveAgentRunResponse(conversationId, stdoutText, responseParentId, {
              runId: spawnedRunId,
            });
          } else if (updatesFromApi.length > 0) {
            msg = attachRunIdToMessage(updatesFromApi[updatesFromApi.length - 1], spawnedRunId);
          } else {
            msg = saveAgentRunResponse(conversationId, '(empty response)', responseParentId, {
              runId: spawnedRunId,
            });
          }

          callbacks.onDone(msg);
        },
        onSpawnError: (err) => {
          if (isCurrentRunKilledByUser(spawnedRunId, err.message)) {
            callbacks.onError('Killed by user');
            return;
          }

          // Primary model failed before runner execution completed — attempt fallback
          if (!isFallback) {
            const fallback = globalFallback;
            if (
              fallback &&
              shouldAttemptFallbackRetry({
                runId: spawnedRunId,
                errorMessage: err.message,
                isFallback,
                hasFallback: true,
              })
            ) {
              console.log(
                `[agent-chat] Primary model runner dispatch failed for agent ${agentId}: ${err.message}. Retrying with fallback model "${fallback.model}"...`,
              );
              callbacks.onFallbackStarted?.(fallback.model);
              spawnChatProcess(agentId, conversationId, fullPrompt, attachmentPaths, callbacks, {
                isFallback: true,
                responseParentId,
                targetMessageId,
                turnId,
              });
              return;
            }
          }
          callbacks.onError(err.message);
        },
      }).catch((err: unknown) => {
        callbacks.onError((err as Error).message);
      });
    })
    .catch((error: unknown) => {
      callbacks.onError((error as Error).message);
    });
}

export const __agentChatTestUtils = {
  buildPromptWithHistory,
  shouldAttemptFallbackRetry,
  getPreviousUserMessageIdForPromptPath,
};

/**
 * Returns a copy of the agent config with the model overridden by the global fallback model.
 * Returns null if no fallback model is configured.
 */
function applyFallbackModel(
  agent: NonNullable<Awaited<ReturnType<typeof prepareAgentWorkspaceAccess>>>,
  projectFallback: { model: string; modelId: string | null } | null,
): typeof agent | null {
  if (!projectFallback?.model) return null;
  return {
    ...agent,
    model: projectFallback.model,
    modelId: projectFallback.modelId,
  };
}

export function executePrompt(
  agentId: string,
  prompt: string,
  conversationId: string,
  options: {
    onRunCreated?: (runId: string) => void;
    onFallbackStarted?: (model: string) => void;
    turnId?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(agentId);
    if (!agent) {
      reject(AgentChatError.notFound('agent_not_found', 'Agent not found'));
      return;
    }

    if (hasRunningProcessForConversation(agentId, conversationId)) {
      reject(
        AgentChatError.conflict(
          'conversation_processing_in_progress',
          'Agent is already processing a prompt',
        ),
      );
      return;
    }

    // Build prompt with conversation history BEFORE saving, so current message isn't duplicated
    const fullPrompt = buildPromptWithHistory(agentId, conversationId, prompt, undefined, {
      turnId: options.turnId ?? null,
    });

    // Save user message
    const userMessage = saveMessage(conversationId, 'outbound', prompt);
    const existingTurnId = options.turnId ?? null;
    const executionTurn =
      existingTurnId && getAgentChatTurn(existingTurnId)
        ? getAgentChatTurn(existingTurnId)
        : createAgentChatTurn({
            agentId,
            conversationId,
            userMessageId: userMessage.id as string,
            source: 'direct_prompt',
            metadata: { mode: 'direct_prompt' },
          });
    const turnId = nonEmptyString(executionTurn?.id);

    spawnChatProcess(
      agentId,
      conversationId,
      fullPrompt,
      { imagePaths: [], filePaths: [], attachments: [] },
      wrapChatExecuteCallbacks({
        onRunCreated: options.onRunCreated,
        onFallbackStarted: options.onFallbackStarted,
        onDone: resolve,
        onError: (error) => reject(new Error(error)),
      }),
      {
        responseParentId: userMessage.id as string,
        turnId,
      },
    );
  });
}

function executeRespondToMessage(
  agentId: string,
  conversationId: string,
  parentMessageId: string,
  options: {
    onRunCreated?: (runId: string) => void;
    onFallbackStarted?: (model: string) => void;
    turnId?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(agentId);
    if (!agent) {
      reject(AgentChatError.notFound('agent_not_found', 'Agent not found'));
      return;
    }

    if (hasRunningProcessForTargetMessage(agentId, conversationId, parentMessageId)) {
      reject(
        AgentChatError.conflict(
          'message_processing_in_progress',
          'Agent is already processing this message',
        ),
      );
      return;
    }

    const parentMessage = store.getById('messages', parentMessageId);
    if (!parentMessage || parentMessage.conversationId !== conversationId) {
      reject(AgentChatError.notFound('message_not_found', 'Message not found'));
      return;
    }
    const existingTurnId = options.turnId ?? null;
    const existingTurn =
      existingTurnId && getAgentChatTurn(existingTurnId)
        ? getAgentChatTurn(existingTurnId)
        : findAgentChatTurnForUserMessage(agentId, conversationId, parentMessageId);
    const executionTurn =
      existingTurn ??
      createAgentChatTurn({
        agentId,
        conversationId,
        userMessageId: parentMessageId,
        source: 'direct_response',
        turnType: 'response',
        metadata: { mode: 'direct_response' },
      });
    const turnId = nonEmptyString(executionTurn?.id);

    const fullPrompt = buildPromptWithHistory(agentId, conversationId, undefined, parentMessageId, {
      turnId,
    });
    const attachmentPaths = getConversationAttachmentDiskPaths(conversationId, parentMessageId);

    spawnChatProcess(
      agentId,
      conversationId,
      fullPrompt,
      attachmentPaths,
      wrapChatExecuteCallbacks({
        onRunCreated: options.onRunCreated,
        onFallbackStarted: options.onFallbackStarted,
        onDone: resolve,
        onError: (error) => reject(new Error(error)),
      }),
      {
        responseParentId: parentMessageId,
        targetMessageId: parentMessageId,
        turnId,
      },
    );
  });
}

/**
 * Trigger the agent to respond to the latest message already in the conversation
 * (used after an attachment upload — the upload message is the user's turn, no new text needed).
 */
export function executeRespondToLastMessage(
  agentId: string,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const leaf = getActivePathLeaf(conversationId);
  if (!leaf || typeof leaf.id !== 'string') {
    return Promise.reject(
      AgentChatError.badRequest(
        'response_target_missing',
        'Conversation has no message to respond to',
      ),
    );
  }
  return executeRespondToMessage(agentId, conversationId, leaf.id as string);
}

export function isAgentBusy(agentId: string, conversationId: string): boolean {
  return hasRunningProcessForConversation(agentId, conversationId);
}

export function canRespondToMessageStartImmediately(
  agentId: string,
  conversationId: string,
  targetMessageId: string,
): boolean {
  const scope = resolveAgentRemoteRunnerRoutingScope(agentId);
  const provider = resolveAgentRemoteRunnerProvider(agentId);
  if (
    !scope ||
    !provider ||
    !hasAvailableRemoteAgentRunner(scope.userId, scope.workspaceId, provider)
  ) {
    return false;
  }
  if (hasRunningProcessForTargetMessage(agentId, conversationId, targetMessageId)) {
    return false;
  }
  return getGlobalRunningAgentCount() < getMaxConcurrentAgents();
}

function clearConversationQueue(conversationId: string) {
  deleteChatQueueItemsForConversation(conversationId);

  for (const [key, entry] of queueDrainTimers) {
    const [, queuedConversationId] = key.split(':');
    if (queuedConversationId !== conversationId) continue;
    clearTimeout(entry.timer);
    queueDrainTimers.delete(key);
  }
}

function getQueueItemRetryDelayMs(attempt: number): number {
  return Math.min(
    AGENT_CHAT_QUEUE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    AGENT_CHAT_QUEUE_RETRY_MAX_MS,
  );
}

function getNextQueueReadyDelay(agentId: string, conversationId: string): number | null {
  const queueItems = listConversationQueueItems(agentId, conversationId).filter(
    (item) => item.status === 'queued',
  );
  if (queueItems.length === 0) return null;

  const now = Date.now();
  let earliest = Number.POSITIVE_INFINITY;
  for (const item of queueItems) {
    const nextAttemptAtMs = parseIsoDateMs(item.nextAttemptAt);
    if (!Number.isFinite(nextAttemptAtMs)) return 0;
    if (nextAttemptAtMs <= now) return 0;
    earliest = Math.min(earliest, nextAttemptAtMs);
  }

  if (!Number.isFinite(earliest)) return 0;
  return Math.max(0, earliest - now);
}

function normalizeQueueAttemptCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.floor(parsed);
}

function normalizeQueueMaxAttempts(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return AGENT_CHAT_QUEUE_DEFAULT_MAX_ATTEMPTS;
  return Math.floor(parsed);
}

function markQueueItemCompleted(queueItemId: string, finalMessage: Record<string, unknown> | null) {
  const item = store.getById(AGENT_CHAT_QUEUE_COLLECTION, queueItemId);
  const turnId = typeof item?.turnId === 'string' ? (item.turnId as string) : null;
  const runId =
    typeof item?.runId === 'string'
      ? (item.runId as string)
      : typeof item?.lastRunId === 'string'
        ? (item.lastRunId as string)
        : null;
  const assistantMessageId =
    finalMessage && typeof finalMessage.id === 'string'
      ? (finalMessage.id as string)
      : ((finalMessage?.id as string | undefined) ?? null);
  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    nextAttemptAt: null,
    errorMessage: null,
    runId: null,
    responseMessageId: assistantMessageId,
  });
  markAgentChatTurnCompleted(turnId, { assistantMessageId, runId });
}

function markQueueItemCancelledByUser(queueItemId: string, errorMessage = 'Cancelled by user') {
  const item = store.getById(AGENT_CHAT_QUEUE_COLLECTION, queueItemId);
  const turnId = typeof item?.turnId === 'string' ? (item.turnId as string) : null;
  const runId =
    typeof item?.runId === 'string'
      ? (item.runId as string)
      : typeof item?.lastRunId === 'string'
        ? (item.lastRunId as string)
        : null;
  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    nextAttemptAt: null,
    runId: null,
    errorMessage,
  });
  markAgentChatTurnStopped(turnId, { runId, errorMessage });
}

function retryOrFailQueueItem(
  queueItemId: string,
  queueItem: Record<string, unknown>,
  agentId: string,
  errorMessage: string,
  attemptsUsed: number,
) {
  const chatErrorSummary = summarizeQueueErrorForChat(errorMessage);

  if (isPermanentQueueError(errorMessage)) {
    store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      nextAttemptAt: null,
      runId: null,
      errorMessage: chatErrorSummary,
    });
    const turnId = typeof queueItem.turnId === 'string' ? (queueItem.turnId as string) : null;
    markAgentChatTurnFailed(turnId, {
      runId: typeof queueItem.runId === 'string' ? (queueItem.runId as string) : null,
      errorMessage: chatErrorSummary,
    });
    return;
  }

  const rateLimited = isRateLimitError(errorMessage);
  // Rate-limited runs get extra attempts and longer backoff
  const maxAttempts = rateLimited
    ? Math.max(normalizeQueueMaxAttempts(queueItem.maxAttempts), 8)
    : normalizeQueueMaxAttempts(queueItem.maxAttempts);

  if (attemptsUsed < maxAttempts) {
    const retryDelayMs = rateLimited
      ? rateLimitBackoffMs(attemptsUsed)
      : getQueueItemRetryDelayMs(attemptsUsed);

    if (rateLimited) {
      console.log(
        `[agent-chat] Rate limit detected for agent ${agentId}, attempt ${attemptsUsed}/${maxAttempts}. ` +
          `Retrying in ${Math.round(retryDelayMs / 1000)}s`,
      );
    }

    store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
      status: 'queued',
      completedAt: null,
      errorMessage: rateLimited
        ? `Rate limited — retrying (attempt ${attemptsUsed}/${maxAttempts})`
        : chatErrorSummary,
      runId: null,
      nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString(),
      usedFallback: false,
      fallbackModel: null,
    });
    markAgentChatTurnQueued(
      typeof queueItem.turnId === 'string' ? (queueItem.turnId as string) : null,
    );
    return;
  }

  const displayError = rateLimited
    ? `Rate limited by external API after ${maxAttempts} retries. Please try again later.`
    : chatErrorSummary;

  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    nextAttemptAt: null,
    runId: null,
    errorMessage: displayError,
  });
  markAgentChatTurnFailed(
    typeof queueItem.turnId === 'string' ? (queueItem.turnId as string) : null,
    {
      runId: typeof queueItem.runId === 'string' ? (queueItem.runId as string) : null,
      errorMessage: displayError,
    },
  );
}

function recoverInterruptedQueueItemFromRun(queueItem: Record<string, unknown>): boolean {
  // Startup recovery guard only. Remove this legacy queue/run-to-turn repair
  // after 2026-08-01 once deployed databases have validated durable turns.
  const queueItemId = typeof queueItem.id === 'string' ? queueItem.id : null;
  const agentId = typeof queueItem.agentId === 'string' ? queueItem.agentId : null;
  const conversationId =
    typeof queueItem.conversationId === 'string' ? queueItem.conversationId : null;
  const runId = typeof queueItem.runId === 'string' ? queueItem.runId : null;
  if (!queueItemId || !agentId || !conversationId || !runId) return false;

  const run = store.getById('agent_runs', runId);
  if (!run) return false;
  if (run.triggerType !== 'chat') return false;
  if (run.agentId !== agentId || run.conversationId !== conversationId) return false;
  const runTurnId = nonEmptyString(run.turnId);
  const queueTurnId = getQueueItemTurnId(queueItem);
  const userMessageId =
    nonEmptyString(queueItem.queuedMessageId) ??
    nonEmptyString(queueItem.targetMessageId) ??
    nonEmptyString(run.responseParentId);
  const linkedTurn =
    (queueTurnId ? getAgentChatTurn(queueTurnId) : null) ??
    (runTurnId ? getAgentChatTurn(runTurnId) : null) ??
    (userMessageId ? findAgentChatTurnForUserMessage(agentId, conversationId, userMessageId) : null);
  const turn =
    linkedTurn ??
    createAgentChatTurn({
      agentId,
      conversationId,
      userMessageId,
      status: runStatusToRecoveredTurnStatus(run),
      runId,
      source: 'legacy_recovery',
      turnType: getQueueItemMode(queueItem) === 'respond_to_message' ? 'response' : 'follow_up',
      metadata: { recoveredFrom: 'processing_queue_item', queueItemId },
      startedAt: nonEmptyString(run.startedAt),
      completedAt: nonEmptyString(run.finishedAt),
      createdAt: nonEmptyString(queueItem.createdAt) ?? nonEmptyString(run.startedAt) ?? undefined,
    });
  const turnId = nonEmptyString(turn.id);
  if (!turnId || turn.agentId !== agentId || turn.conversationId !== conversationId) return false;
  if (runTurnId && runTurnId !== turnId) return false;
  if (queueTurnId && queueTurnId !== turnId) return false;
  if (queueItem.turnId !== turnId) {
    store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, { turnId });
  }
  if (run.turnId !== turnId) {
    store.update('agent_runs', runId, { turnId });
  }
  if (isRunMarkedKilledByUser(runId)) {
    markQueueItemCancelledByUser(queueItemId);
    return true;
  }

  const runStatus = run.status;
  if (runStatus === 'running') return false;
  if (turn.status === 'stopped' || turn.status === 'failed' || turn.status === 'superseded') {
    const errorMessage =
      turn.status === 'stopped'
        ? 'Cancelled by user'
        : turn.status === 'superseded'
          ? 'Skipped superseded queued turn during recovery'
          : nonEmptyString(run.errorMessage) ?? 'Recovered run failed after backend restart';
    if (turn.status === 'stopped') {
      markQueueItemCancelledByUser(queueItemId, errorMessage);
    } else {
      store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        nextAttemptAt: null,
        runId: null,
        errorMessage,
      });
      markAgentChatTurnFailed(turnId, { runId, errorMessage });
    }
    return true;
  }

  if (runStatus === 'completed') {
    const runStartedAtMs = parseIsoDateMs(run.startedAt);
    const runStartedAt = Number.isFinite(runStartedAtMs) ? runStartedAtMs : Date.now();
    const rawStdout = typeof run.stdout === 'string' ? run.stdout : '';
    const responseParentId =
      typeof run.responseParentId === 'string' ? (run.responseParentId as string) : null;
    const finalMessage = resolveFinalMessageForCompletedRun(
      conversationId,
      runStartedAt,
      rawStdout,
      responseParentId,
      runId,
    );

    if (finalMessage) {
      markQueueItemCompleted(queueItemId, finalMessage);
      return true;
    }
  }

  const attemptsUsed = normalizeQueueAttemptCount(queueItem.attempts);
  const errorMessage =
    typeof run.errorMessage === 'string' && run.errorMessage
      ? run.errorMessage
      : runStatus === 'completed'
        ? 'Recovered run completed without a response'
        : 'Recovered run failed after backend restart';
  retryOrFailQueueItem(queueItemId, queueItem, agentId, errorMessage, attemptsUsed);
  return true;
}

/**
 * Shared logic for processing a single queue item after it has been marked as 'processing'.
 * Returns the final message on success, throws on failure.
 */
async function processQueueItem(
  readyItemId: string,
  readyItem: Record<string, unknown>,
  agentId: string,
  conversationId: string,
  mode: QueueExecutionMode,
  prompt: string,
  targetMessageId: string | null,
): Promise<void> {
  let spawnedRunId: string | null = null;
  try {
    const turnId = typeof readyItem.turnId === 'string' ? (readyItem.turnId as string) : null;
    const turn = turnId ? getAgentChatTurn(turnId) : null;
    if (!turn || turn.agentId !== agentId || turn.conversationId !== conversationId) {
      throw AgentChatError.notFound(
        'queue_turn_missing',
        'Queued execution item is missing its durable turn',
      );
    }
    if (turn.status === 'stopped' || turn.status === 'failed' || turn.status === 'superseded') {
      throw AgentChatError.conflict(
        'queue_turn_not_startable',
        'Queued execution item references a terminal or superseded turn',
      );
    }
    let effectiveTargetId = targetMessageId;
    if (mode === 'append_prompt') {
      const promptMessage = ensureQueuedPromptMessage(
        readyItemId,
        readyItem,
        conversationId,
        prompt,
      );
      effectiveTargetId =
        typeof promptMessage.id === 'string' ? (promptMessage.id as string) : null;
      updateAgentChatTurn(turnId, { userMessageId: effectiveTargetId });
    }

    if (!effectiveTargetId) {
      throw AgentChatError.notFound('queue_target_missing', 'Queued message target is missing');
    }
    markAgentChatTurnRunning(turnId, { userMessageId: effectiveTargetId });

    const onRunCreated = (runId: string) => {
      spawnedRunId = runId;
      store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
        runId,
        lastRunId: runId,
      });
      markAgentChatTurnRunning(turnId, { runId, userMessageId: effectiveTargetId });
    };
    const onFallbackStarted = (model: string) => {
      store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
        usedFallback: true,
        fallbackModel: model,
      });
    };
    const finalMessage = await executeRespondToMessage(agentId, conversationId, effectiveTargetId, {
      onRunCreated,
      onFallbackStarted,
      turnId,
    });
    const latestItem = store.getById(AGENT_CHAT_QUEUE_COLLECTION, readyItemId);
    if (!latestItem || latestItem.status !== 'processing') return;
    markQueueItemCompleted(readyItemId, finalMessage);
  } catch (err) {
    const latestItem = store.getById(AGENT_CHAT_QUEUE_COLLECTION, readyItemId);
    if (!latestItem || latestItem.status !== 'processing') return;

    const activeRunId =
      typeof latestItem.runId === 'string' && latestItem.runId ? latestItem.runId : spawnedRunId;
    if (isRunMarkedKilledByUser(activeRunId)) {
      markQueueItemCancelledByUser(readyItemId);
      return;
    }

    const errorMessage =
      err instanceof Error ? err.message : 'Failed to process queued chat message';
    const attemptsUsed = normalizeQueueAttemptCount(latestItem.attempts);
    retryOrFailQueueItem(readyItemId, latestItem, agentId, errorMessage, attemptsUsed);
  }
}

function getQueuedItemBlockedDependency(
  queueItems: Record<string, unknown>[],
  queueItem: Record<string, unknown>,
): Record<string, unknown> | null {
  const dependencyId = getQueueItemDependencyId(queueItem);
  if (!dependencyId) return null;

  const dependency = queueItems.find((item) => item.id === dependencyId) ?? null;
  if (!dependency) return null;
  return isPendingQueueItem(dependency) ? dependency : null;
}

function canStartQueuedItemNow(
  agentId: string,
  conversationId: string,
  queueItems: Record<string, unknown>[],
  queueItem: Record<string, unknown>,
  now: number,
): boolean {
  if (queueItem.status !== 'queued') return false;

  const nextAttemptAtMs = parseIsoDateMs(queueItem.nextAttemptAt);
  if (Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > now) {
    return false;
  }

  if (getQueuedItemBlockedDependency(queueItems, queueItem)) {
    return false;
  }

  const scope = resolveAgentRemoteRunnerRoutingScope(agentId);
  const provider = resolveAgentRemoteRunnerProvider(agentId);
  if (
    !scope ||
    !provider ||
    !hasAvailableRemoteAgentRunner(scope.userId, scope.workspaceId, provider)
  ) {
    return false;
  }

  const mode = getQueueItemMode(queueItem);
  if (mode === 'append_prompt') {
    const hasProcessingAppendPrompt = queueItems.some(
      (item) =>
        item.id !== queueItem.id &&
        item.status === 'processing' &&
        getQueueItemMode(item) === 'append_prompt',
    );
    if (hasProcessingAppendPrompt) return false;
  }

  if (mode === 'respond_to_message') {
    const targetMessageId =
      typeof queueItem.targetMessageId === 'string' ? (queueItem.targetMessageId as string) : null;
    if (!targetMessageId) return true;
    return !hasRunningProcessForTargetMessage(agentId, conversationId, targetMessageId);
  }

  const queuedMessageId =
    typeof queueItem.queuedMessageId === 'string' ? (queueItem.queuedMessageId as string) : null;
  if (!queuedMessageId) return true;
  return !hasRunningProcessForTargetMessage(agentId, conversationId, queuedMessageId);
}

async function drainConversationQueue(agentId: string, conversationId: string): Promise<void> {
  const key = queueKey(agentId, conversationId);
  if (queueProcessors.has(key)) return;

  queueProcessors.add(key);
  try {
    while (true) {
      type ChatClaim = {
        readyItemId: string;
        readyItem: Record<string, unknown>;
        mode: QueueExecutionMode;
        prompt: string;
        targetMessageId: string | null;
      };

      const txResult = await withQueueDrainTransaction(() =>
        store.transaction(async () => {
          await store.lockAgentChatQueueConversation(agentId, conversationId);
          const queueItems = listConversationQueueItems(agentId, conversationId) as Record<
            string,
            unknown
          >[];
          if (!resolveAgentRemoteRunnerWorkspaceId(agentId)) {
            const nowIso = new Date().toISOString();
            for (const item of queueItems) {
              if (item.status !== 'queued' || typeof item.id !== 'string') continue;
              store.update(AGENT_CHAT_QUEUE_COLLECTION, item.id, {
                status: 'failed',
                completedAt: nowIso,
                nextAttemptAt: null,
                runId: null,
                errorMessage:
                  'This agent is not assigned to a workspace with a runner. Add the agent to a workspace, then try again.',
              });
              markAgentChatTurnFailed(
                typeof item.turnId === 'string' ? (item.turnId as string) : null,
                {
                  errorMessage:
                    'This agent is not assigned to a workspace with a runner. Add the agent to a workspace, then try again.',
                },
              );
            }
            return { kind: 'idle' as const, hasQueuedItems: false };
          }
          const now = Date.now();
          const readyItems = queueItems.filter((item) =>
            canStartQueuedItemNow(agentId, conversationId, queueItems, item, now),
          );

          if (readyItems.length === 0) {
            const hasQueuedItems = queueItems.some((item) => item.status === 'queued');
            return { kind: 'idle' as const, hasQueuedItems };
          }

          const claims: ChatClaim[] = [];
          const claimableItems = readyItems.slice(0, 1);
          for (const readyItem of claimableItems) {
            if (getGlobalRunningAgentCount() >= getMaxConcurrentAgents()) {
              return { kind: 'global_limit' as const, claims };
            }

            const readyItemId = readyItem.id as string;
            const attempts = Number(readyItem.attempts ?? 0);
            const mode = (readyItem.mode as QueueExecutionMode | undefined) ?? 'append_prompt';
            const prompt = typeof readyItem.prompt === 'string' ? readyItem.prompt.trim() : '';
            const targetMessageId =
              typeof readyItem.targetMessageId === 'string'
                ? (readyItem.targetMessageId as string)
                : null;

            const hasQueuedAttachments = parseAttachments(readyItem.attachments).length > 0;
            if (mode === 'append_prompt' && !prompt && !hasQueuedAttachments) {
              store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
                status: 'failed',
                completedAt: new Date().toISOString(),
                nextAttemptAt: null,
                runId: null,
                errorMessage: 'Queued prompt is empty',
              });
              markAgentChatTurnFailed(
                typeof readyItem.turnId === 'string' ? (readyItem.turnId as string) : null,
                { errorMessage: 'Queued prompt is empty' },
              );
              continue;
            }
            if (mode === 'respond_to_message' && !targetMessageId) {
              store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
                status: 'failed',
                completedAt: new Date().toISOString(),
                nextAttemptAt: null,
                runId: null,
                errorMessage: 'Queued branch target is missing',
              });
              markAgentChatTurnFailed(
                typeof readyItem.turnId === 'string' ? (readyItem.turnId as string) : null,
                { errorMessage: 'Queued branch target is missing' },
              );
              continue;
            }

            store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
              status: 'processing',
              attempts: attempts + 1,
              startedAt: new Date().toISOString(),
              runId: null,
              errorMessage: null,
              completedAt: null,
              usedFallback: false,
              fallbackModel: null,
            });
            markAgentChatTurnRunning(
              typeof readyItem.turnId === 'string' ? (readyItem.turnId as string) : null,
            );

            const latest =
              store.getById(AGENT_CHAT_QUEUE_COLLECTION, readyItemId) ??
              ({
                ...readyItem,
                status: 'processing',
                attempts: attempts + 1,
              } as Record<string, unknown>);
            claims.push({ readyItemId, readyItem: latest, mode, prompt, targetMessageId });
          }

          return { kind: 'claimed' as const, claims };
        }),
      );

      if (txResult.kind === 'idle') {
        if (!txResult.hasQueuedItems) {
          clearQueueDrainTimerForKey(key);
          return;
        }
        const nextDelayMs = getNextQueueReadyDelay(agentId, conversationId);
        scheduleQueueDrain(
          agentId,
          conversationId,
          nextDelayMs === null ? 1000 : Math.max(nextDelayMs, 1000),
        );
        return;
      }

      if (txResult.kind === 'global_limit') {
        for (const c of txResult.claims) {
          void processQueueItem(
            c.readyItemId,
            c.readyItem,
            agentId,
            conversationId,
            c.mode,
            c.prompt,
            c.targetMessageId,
          ).finally(() => {
            scheduleQueueDrain(agentId, conversationId, 0);
          });
        }
        scheduleQueueDrain(agentId, conversationId, 2000);
        return;
      }

      for (const c of txResult.claims) {
        void processQueueItem(
          c.readyItemId,
          c.readyItem,
          agentId,
          conversationId,
          c.mode,
          c.prompt,
          c.targetMessageId,
        ).finally(() => {
          scheduleQueueDrain(agentId, conversationId, 0);
        });
      }
      continue;
    }
  } finally {
    queueProcessors.delete(key);
  }
}

function pruneChatQueueHistory() {
  deleteTerminalChatQueueItemsBeyondRetention({
    terminalStatuses: ['completed', 'failed', 'cancelled'],
    retentionMs: AGENT_CHAT_QUEUE_RETENTION_MS,
    nowMs: Date.now(),
  });
}

export function getAgentQueuedPromptCount(agentId: string, conversationId: string): number {
  return getQueuedAppendPromptCount(agentId, conversationId);
}

export function cancelProcessingQueueItemForRun(
  runId: string,
  errorMessage = 'Cancelled by user',
): boolean {
  const item = findChatQueueItemProcessingForRunId(runId);
  if (!item || typeof item.id !== 'string') return false;

  markQueueItemCancelledByUser(item.id, errorMessage);
  if (typeof item.agentId === 'string' && typeof item.conversationId === 'string') {
    scheduleQueueDrain(item.agentId, item.conversationId, 0);
  }
  return true;
}

export interface InitializeAgentChatQueueOptions {
  preserveActiveProcessing?: boolean;
}

export async function initializeAgentChatQueue(options: InitializeAgentChatQueueOptions = {}) {
  const { preserveActiveProcessing = false } = options;
  const nowIso = new Date().toISOString();
  const interruptedItems = await listChatQueueItemsWithStatusNative('processing');

  for (const item of interruptedItems) {
    const hasKeys = typeof item.agentId === 'string' && typeof item.conversationId === 'string';
    const shouldPreserve =
      preserveActiveProcessing &&
      hasKeys &&
      isAgentBusy(item.agentId as string, item.conversationId as string);
    if (shouldPreserve) continue;

    const recoveredFromRun = recoverInterruptedQueueItemFromRun(item);
    if (recoveredFromRun) continue;

    const turnId = getQueueItemTurnId(item);
    const turn = turnId ? getAgentChatTurn(turnId) : null;
    if (
      !turn ||
      turn.agentId !== item.agentId ||
      turn.conversationId !== item.conversationId ||
      turn.status === 'stopped' ||
      turn.status === 'failed' ||
      turn.status === 'superseded'
    ) {
      store.update(AGENT_CHAT_QUEUE_COLLECTION, item.id as string, {
        status: turn?.status === 'stopped' ? 'cancelled' : 'failed',
        nextAttemptAt: null,
        completedAt: nowIso,
        runId: null,
        errorMessage: !turn
          ? 'Recovered queue item is missing its durable turn'
          : turn.status === 'superseded'
            ? 'Recovered queue item references a superseded turn'
            : turn.status === 'stopped'
              ? 'Cancelled by user'
              : 'Recovered queue item references a failed turn',
      });
      continue;
    }

    store.update(AGENT_CHAT_QUEUE_COLLECTION, item.id as string, {
      status: 'queued',
      nextAttemptAt: nowIso,
      completedAt: null,
      runId: null,
      errorMessage:
        typeof item.errorMessage === 'string' && item.errorMessage
          ? item.errorMessage
          : 'Recovered from backend restart',
    });
  }

  pruneChatQueueHistory();

  const pendingItems = await listChatQueueItemsWithStatusNative('queued');
  const keys = new Set<string>();
  for (const item of pendingItems) {
    if (typeof item.agentId !== 'string' || typeof item.conversationId !== 'string') continue;
    keys.add(queueKey(item.agentId, item.conversationId));
  }

  let index = 0;
  for (const key of keys) {
    const [agentId, conversationId] = key.split(':');
    if (!agentId || !conversationId) continue;
    scheduleQueueDrain(agentId, conversationId, index * 250);
    index++;
  }
}

export function scheduleQueuedAgentChatDrains() {
  const keys = new Set<string>();
  for (const item of store.getAll(AGENT_CHAT_QUEUE_COLLECTION)) {
    if (item.status !== 'queued') continue;
    if (typeof item.agentId !== 'string' || typeof item.conversationId !== 'string') continue;
    keys.add(queueKey(item.agentId, item.conversationId));
  }

  for (const key of keys) {
    const [agentId, conversationId] = key.split(':');
    if (!agentId || !conversationId) continue;
    scheduleQueueDrain(agentId, conversationId, 0);
  }
}

function assertAgentRunnerAvailableForQueue(agentId: string): void {
  const runnerWorkspaceId = getAgentRunnerWorkspaceIdOrThrow(agentId);
  const runnerProvider = getAgentRunnerProviderOrThrow(agentId);
  const runnerScope = resolveAgentRemoteRunnerRoutingScope(agentId);
  if (
    !runnerScope ||
    !hasConnectedRemoteAgentRunner(runnerScope.userId, runnerWorkspaceId) ||
    !hasAvailableRemoteAgentRunner(runnerScope.userId, runnerWorkspaceId, runnerProvider)
  ) {
    throw AgentChatError.conflict(
      'agent_runner_unavailable',
      getRemoteAgentRunnerUnavailableMessage(
        runnerScope?.userId,
        runnerWorkspaceId,
        runnerProvider,
      ),
    );
  }
}

export interface EnqueueAgentPromptResult {
  queueItem: Record<string, unknown>;
  userMessage: Record<string, unknown> | null;
  queuedCount: number;
}

export function enqueueAgentPrompt(
  agentId: string,
  conversationId: string,
  prompt: string,
  options: {
    mode?: QueueExecutionMode;
    targetMessageId?: string | null;
    queuedMessageId?: string | null;
    previousUserMessageId?: string | null;
    createdById?: string | null;
    source?: string;
    turnType?: AgentChatTurnType;
    supersedesMessageId?: string | null;
    attachments?: unknown[] | null;
    metadata?: Record<string, unknown>;
  } = {},
): EnqueueAgentPromptResult {
  const trimmedPrompt = prompt.trim();
  const mode = options.mode ?? 'append_prompt';
  const appendPromptAttachments = cloneAttachmentRecords(parseAttachments(options.attachments));
  if (!trimmedPrompt && mode !== 'respond_to_message' && appendPromptAttachments.length === 0) {
    throw AgentChatError.badRequest('prompt_required', 'Prompt is required');
  }
  const targetMessageId = options.targetMessageId ?? null;
  let queuedMessageId = options.queuedMessageId ?? null;
  const previousUserMessageId = resolvePreviousUserMessageId(
    conversationId,
    options.previousUserMessageId ?? null,
  );
  let turnParentUserMessageId = previousUserMessageId;
  if (mode === 'respond_to_message') {
    if (!targetMessageId) {
      throw AgentChatError.badRequest('target_message_required', 'Target message is required');
    }
    const targetMessage = store.getById('messages', targetMessageId);
    if (!targetMessage || targetMessage.conversationId !== conversationId) {
      throw AgentChatError.notFound('target_message_not_found', 'Target message not found');
    }
  }
  if (previousUserMessageId) {
    const parentTurn = findAgentChatTurnForUserMessage(agentId, conversationId, previousUserMessageId);
    if (!parentTurn) {
      throw AgentChatError.conflict(
        'parent_turn_missing',
        'The parent chat turn is missing. Run the agent chat turn migration before appending to this conversation.',
      );
    }
  }

  let userMessage: Record<string, unknown> | null = null;
  let continuationParentId: string | null = null;
  let dependsOnQueueItemId: string | null = null;
  if (mode === 'append_prompt') {
    continuationParentId = getContinuationParentIdForPreviousUserMessage(
      conversationId,
      previousUserMessageId,
    );
    const dependency = findPendingBranchDependencyForAppendPrompt(
      agentId,
      conversationId,
      previousUserMessageId,
      continuationParentId,
    );
    if (dependency && typeof dependency.id === 'string') {
      dependsOnQueueItemId = dependency.id as string;
    }

    const existingQueuedMessage = queuedMessageId
      ? store.getById('messages', queuedMessageId)
      : null;
    if (existingQueuedMessage) {
      if (
        existingQueuedMessage.conversationId !== conversationId ||
        existingQueuedMessage.direction !== 'outbound'
      ) {
        throw AgentChatError.badRequest(
          'queued_message_id_invalid',
          'Queued message id must refer to a user message in this conversation',
        );
      }
      userMessage = existingQueuedMessage;
      turnParentUserMessageId = previousUserMessageIdForAppendParent(
        conversationId,
        typeof existingQueuedMessage.parentId === 'string'
          ? (existingQueuedMessage.parentId as string)
          : null,
        previousUserMessageId,
      );
    } else {
      const parentId = resolveQueuedPromptParentId(conversationId, {
        previousUserMessageId,
        continuationParentId,
        dependsOnQueueItemId,
      });
      if (parentId) {
        activateMessagePath(conversationId, parentId);
      }
      const effectivePreviousUserMessageId = previousUserMessageIdForAppendParent(
        conversationId,
        parentId,
        previousUserMessageId,
      );
      turnParentUserMessageId = effectivePreviousUserMessageId;
      userMessage = saveAgentConversationMessage({
        id: queuedMessageId ?? undefined,
        conversationId,
        direction: 'outbound',
        content: trimmedPrompt,
        type: getMessageTypeForAttachments(appendPromptAttachments),
        metadata: null,
        attachments: appendPromptAttachments.length > 0 ? appendPromptAttachments : null,
        parentId,
        previousUserMessageId: effectivePreviousUserMessageId,
      });
    }
    queuedMessageId =
      typeof userMessage.id === 'string' ? (userMessage.id as string) : queuedMessageId;
  }

  pruneChatQueueHistory();

  const turnUserMessageId = mode === 'respond_to_message' ? targetMessageId : queuedMessageId;
  const supersededTurn = options.supersedesMessageId
    ? findAgentChatTurnForUserMessage(agentId, conversationId, options.supersedesMessageId)
    : null;
  if (options.supersedesMessageId && !supersededTurn) {
    throw AgentChatError.conflict(
      'superseded_turn_missing',
      'The edited chat turn is missing. Run the agent chat turn migration before editing this conversation.',
    );
  }
  const turnType =
    options.turnType ??
    (supersededTurn ? 'edit' : mode === 'respond_to_message' ? 'response' : 'follow_up');
  const turn = createAgentChatTurn({
    agentId,
    conversationId,
    parentUserMessageId: turnParentUserMessageId,
    userMessageId: turnUserMessageId,
    source: options.source ?? 'user',
    createdById: options.createdById ?? null,
    turnType,
    supersedesTurnId: typeof supersededTurn?.id === 'string' ? (supersededTurn.id as string) : null,
    metadata: {
      mode,
      targetMessageId,
      queuedMessageId,
      ...(options.metadata ?? {}),
    },
  });
  const turnId = typeof turn.id === 'string' ? (turn.id as string) : null;
  activateTurnPath(conversationId, agentId, turnId);

  try {
    assertAgentRunnerAvailableForQueue(agentId);
  } catch (err) {
    markAgentChatTurnFailed(turnId, {
      errorMessage: err instanceof Error ? err.message : 'Agent runner unavailable',
    });
    throw err;
  }

  const queueItem = store.insert(AGENT_CHAT_QUEUE_COLLECTION, {
    agentId,
    conversationId,
    mode,
    prompt: trimmedPrompt,
    targetMessageId,
    status: 'queued',
    attempts: 0,
    maxAttempts: AGENT_CHAT_QUEUE_DEFAULT_MAX_ATTEMPTS,
    turnId,
    runId: null,
    lastRunId: null,
    continuationParentId,
    dependsOnQueueItemId,
    previousUserMessageId: turnParentUserMessageId,
    queuedMessageId,
    responseMessageId: null,
    errorMessage: null,
    attachments:
      mode === 'append_prompt' && appendPromptAttachments.length > 0
        ? appendPromptAttachments
        : null,
    nextAttemptAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    usedFallback: false,
    fallbackModel: null,
  });

  scheduleQueueDrain(agentId, conversationId, 0);

  // Only append prompts belong to the visible conversation queue. Branch edits
  // run independently and should not inflate the queue badge.
  const rawCount = getQueuedAppendPromptCount(agentId, conversationId);
  const effectiveCount = isAgentBusy(agentId, conversationId)
    ? rawCount
    : Math.max(0, rawCount - 1);

  return {
    queueItem,
    userMessage,
    queuedCount: effectiveCount,
  };
}

export interface EnqueueAgentResponseToMessageResult extends EnqueueAgentPromptResult {
  targetMessageId: string;
  willQueueBehind: boolean;
}

export function enqueueAgentResponseToMessage(
  agentId: string,
  conversationId: string,
  options: {
    targetMessageId?: string | null;
    createdById?: string | null;
    source?: string;
    turnType?: AgentChatTurnType;
    metadata?: Record<string, unknown>;
  } = {},
): EnqueueAgentResponseToMessageResult {
  const targetMessageId =
    options.targetMessageId ??
    (() => {
      const activePath = getActiveMessagePath(conversationId);
      const leaf = activePath.length > 0 ? activePath[activePath.length - 1] : null;
      return typeof leaf?.id === 'string' ? (leaf.id as string) : null;
    })();

  if (!targetMessageId) {
    throw AgentChatError.badRequest(
      'response_target_missing',
      'Conversation has no message to respond to',
    );
  }

  const willQueueBehind = !canRespondToMessageStartImmediately(
    agentId,
    conversationId,
    targetMessageId,
  );
  const queued = enqueueAgentPrompt(agentId, conversationId, '', {
    mode: 'respond_to_message',
    targetMessageId,
    createdById: options.createdById ?? null,
    source: options.source,
    turnType: options.turnType,
    metadata: options.metadata,
  });

  return {
    ...queued,
    targetMessageId,
    willQueueBehind,
  };
}

// ---------------------------------------------------------------------------
// Queue management (view / edit / delete / reorder)
// ---------------------------------------------------------------------------

export function getConversationQueueItems(agentId: string, conversationId: string) {
  return listConversationQueueItems(agentId, conversationId).filter(
    (item) => item.status === 'queued',
  );
}

export function getConversationExecutionItems(agentId: string, conversationId: string) {
  reconcileTerminalProcessingExecutionItems(agentId, conversationId);

  let position = 0;
  return listConversationQueueItems(agentId, conversationId).map((item) => {
    const isLive = item.status === 'queued' || item.status === 'processing';
    const queuePosition = isLive ? ++position : null;
    return sanitizeQueueItemForChat(item, queuePosition);
  });
}

export function updateQueueItem(
  itemId: string,
  agentId: string,
  conversationId: string,
  updates: {
    prompt?: string;
    attachments?: unknown[] | null;
    keepStoragePaths?: string[] | null;
  },
) {
  const item = store.getById(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  if (!item || item.agentId !== agentId || item.conversationId !== conversationId) {
    throw AgentChatError.notFound('queue_item_not_found', 'Queue item not found');
  }
  if (item.status !== 'queued') {
    throw AgentChatError.conflict(
      'queue_item_not_editable',
      'Only queued execution items can be edited',
    );
  }

  const mode = getQueueItemMode(item);
  const patch: Record<string, unknown> = {};
  const hasPromptUpdate = updates.prompt !== undefined;
  const hasAttachmentUpdate =
    Array.isArray(updates.attachments) || Array.isArray(updates.keepStoragePaths);
  const trimmedPrompt = hasPromptUpdate ? (updates.prompt ?? '').trim() : null;
  let targetMessageId: string | null = null;

  if (updates.prompt !== undefined) {
    if (mode === 'append_prompt') {
      patch.prompt = trimmedPrompt;
    }
  }

  if (mode === 'append_prompt') {
    targetMessageId =
      typeof item.queuedMessageId === 'string' ? (item.queuedMessageId as string) : null;
  } else if (hasPromptUpdate || hasAttachmentUpdate) {
    targetMessageId =
      typeof item.targetMessageId === 'string' ? (item.targetMessageId as string) : null;
    if (!targetMessageId) {
      throw AgentChatError.notFound('queue_target_missing', 'Queued message target is missing');
    }
  }

  const targetMessage = targetMessageId ? store.getById('messages', targetMessageId) : null;
  if (mode === 'respond_to_message' && (hasPromptUpdate || hasAttachmentUpdate) && !targetMessage) {
    throw AgentChatError.notFound('queue_target_missing', 'Queued message target is missing');
  }
  if (targetMessageId && targetMessage && targetMessage.conversationId !== conversationId) {
    throw AgentChatError.notFound('queue_target_missing', 'Queued message target is missing');
  }
  if (targetMessage && targetMessage.direction !== 'outbound') {
    throw AgentChatError.badRequest(
      'queue_target_not_editable',
      'Queued item attachments can only be updated on user messages',
    );
  }

  const originalAttachments = targetMessage
    ? cloneAttachmentRecords(parseAttachments(targetMessage.attachments))
    : cloneAttachmentRecords(parseAttachments(item.attachments));
  const keepStoragePathSet = Array.isArray(updates.keepStoragePaths)
    ? new Set(updates.keepStoragePaths)
    : null;
  const retainedAttachments =
    keepStoragePathSet === null
      ? originalAttachments
      : originalAttachments.filter(
          (attachment) =>
            typeof attachment.storagePath === 'string' &&
            keepStoragePathSet.has(attachment.storagePath),
        );
  const appendedAttachments = Array.isArray(updates.attachments)
    ? cloneAttachmentRecords(updates.attachments as Array<Record<string, unknown>>)
    : [];
  const combinedAttachments = hasAttachmentUpdate
    ? [...retainedAttachments, ...appendedAttachments]
    : originalAttachments;
  if (combinedAttachments.length > MAX_CHAT_MESSAGE_IMAGES) {
    throw AgentChatError.badRequest(
      'message_attachment_limit_exceeded',
      `A message can contain up to ${MAX_CHAT_MESSAGE_IMAGES} attachments`,
    );
  }

  const nextContent =
    trimmedPrompt !== null
      ? trimmedPrompt
      : targetMessage && typeof targetMessage.content === 'string'
        ? targetMessage.content.trim()
        : typeof item.prompt === 'string'
          ? item.prompt.trim()
          : '';
  if (!nextContent && combinedAttachments.length === 0) {
    throw AgentChatError.badRequest(
      'queued_message_content_required',
      'Queued message content or attachments are required',
    );
  }

  const normalizedAttachments = combinedAttachments.length > 0 ? combinedAttachments : null;
  if (hasAttachmentUpdate || (!targetMessage && normalizedAttachments)) {
    patch.attachments = normalizedAttachments;
  }

  let updatedMessage: Record<string, unknown> | null = null;
  if (targetMessage) {
    const messagePatch: Record<string, unknown> = {};
    if (trimmedPrompt !== null) {
      messagePatch.content = trimmedPrompt;
    }
    if (hasAttachmentUpdate) {
      messagePatch.attachments = normalizedAttachments;
      messagePatch.type = getMessageTypeForAttachments(combinedAttachments);
    }
    if (Object.keys(messagePatch).length > 0) {
      updatedMessage = store.update('messages', targetMessageId!, messagePatch) ?? null;
    }
  }

  if (Object.keys(patch).length === 0) {
    return updatedMessage ? (store.getById(AGENT_CHAT_QUEUE_COLLECTION, itemId) ?? item) : item;
  }

  return store.update(AGENT_CHAT_QUEUE_COLLECTION, itemId, patch);
}

export function retryQueueItem(itemId: string, agentId: string, conversationId: string) {
  const item = store.getById(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  if (!item || item.agentId !== agentId || item.conversationId !== conversationId) {
    throw AgentChatError.notFound('queue_item_not_found', 'Execution item not found');
  }
  if (item.status !== 'failed' && item.status !== 'cancelled') {
    throw AgentChatError.conflict(
      'queue_item_not_retryable',
      'Only failed or cancelled execution items can be retried',
    );
  }

  const updated = store.update(AGENT_CHAT_QUEUE_COLLECTION, itemId, {
    status: 'queued',
    attempts: 0,
    runId: null,
    errorMessage: null,
    nextAttemptAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    responseMessageId: null,
    usedFallback: false,
    fallbackModel: null,
  });
  markAgentChatTurnQueued(typeof item.turnId === 'string' ? (item.turnId as string) : null);
  scheduleQueueDrain(agentId, conversationId, 0);
  return updated;
}

function removeActiveBranchReferences(
  conversationId: string,
  ids: { turnId?: string | null; userMessageId?: string | null },
) {
  const conversation = store.getById('conversations', conversationId);
  if (!conversation) return;
  const metadata = parseMetadata(conversation.metadata) ?? {};
  const activeBranches = metadata.activeBranches;
  if (!activeBranches || typeof activeBranches !== 'object' || Array.isArray(activeBranches)) {
    return;
  }

  const nextBranches: Record<string, string> = {};
  let changed = false;
  for (const [key, value] of Object.entries(activeBranches as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const referencesDeletedTurn =
      ids.turnId && (value === ids.turnId || key === `turn:${ids.turnId}`);
    const referencesDeletedMessage =
      ids.userMessageId && (value === ids.userMessageId || key === `user:${ids.userMessageId}`);
    if (referencesDeletedTurn || referencesDeletedMessage) {
      changed = true;
      continue;
    }
    nextBranches[key] = value;
  }

  if (!changed) return;
  store.update('conversations', conversationId, {
    metadata: { ...metadata, activeBranches: nextBranches },
  });
}

function deleteNotStartedQueuedTurn(
  itemId: string,
  item: Record<string, unknown>,
  agentId: string,
  conversationId: string,
): boolean {
  if (item.status !== 'queued') return false;
  if (getQueueItemRunId(item)) return false;

  const turnId = getQueueItemTurnId(item);
  const turn = turnId ? getAgentChatTurn(turnId) : null;
  if (!turnId) return false;
  if (!turn || turn.agentId !== agentId || turn.conversationId !== conversationId) return false;
  if (turn.status !== 'queued') return false;
  if (nonEmptyString(turn.runId) || nonEmptyString(turn.assistantMessageId)) return false;

  const parentTurnId = nonEmptyString(turn.parentTurnId);
  const parentTurn = parentTurnId ? getAgentChatTurn(parentTurnId) : null;
  const parentUserMessageId = getTurnUserMessageId(parentTurn);
  const userMessageId = getTurnUserMessageId(turn);

  for (const childTurn of store.getAll('agentChatTurns')) {
    if (childTurn.parentTurnId !== turnId || typeof childTurn.id !== 'string') continue;
    store.update('agentChatTurns', childTurn.id, { parentTurnId });
  }

  if (userMessageId) {
    for (const message of store.getAll('messages')) {
      if (typeof message.id !== 'string' || message.conversationId !== conversationId) continue;
      const patch: Record<string, unknown> = {};
      if (message.previousUserMessageId === userMessageId) {
        patch.previousUserMessageId = parentUserMessageId;
      }
      if (message.parentId === userMessageId) {
        patch.parentId = parentUserMessageId;
      }
      if (Object.keys(patch).length > 0) {
        store.update('messages', message.id, patch);
      }
    }
  }

  for (const queue of store.getAll(AGENT_CHAT_QUEUE_COLLECTION)) {
    if (typeof queue.id !== 'string' || queue.conversationId !== conversationId) continue;
    const patch: Record<string, unknown> = {};
    if (queue.dependsOnQueueItemId === itemId) patch.dependsOnQueueItemId = null;
    if (userMessageId && queue.previousUserMessageId === userMessageId) {
      patch.previousUserMessageId = parentUserMessageId;
    }
    if (userMessageId && queue.continuationParentId === userMessageId) {
      patch.continuationParentId = parentUserMessageId;
    }
    if (Object.keys(patch).length > 0) {
      store.update(AGENT_CHAT_QUEUE_COLLECTION, queue.id, patch);
    }
  }

  store.delete(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  store.delete('agentChatTurns', turnId);
  if (userMessageId) {
    const message = store.getById('messages', userMessageId);
    if (message?.conversationId === conversationId && message.direction === 'outbound') {
      store.delete('messages', userMessageId);
    }
  }
  removeActiveBranchReferences(conversationId, { turnId, userMessageId });
  return true;
}

export function deleteQueueItem(itemId: string, agentId: string, conversationId: string) {
  const item = store.getById(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  if (!item || item.agentId !== agentId || item.conversationId !== conversationId) {
    throw AgentChatError.notFound('queue_item_not_found', 'Queue item not found');
  }
  if (item.status !== 'queued' && item.status !== 'failed' && item.status !== 'cancelled') {
    throw AgentChatError.conflict(
      'queue_item_not_deletable',
      'Only queued, failed, or cancelled execution items can be removed',
    );
  }

  if (deleteNotStartedQueuedTurn(itemId, item, agentId, conversationId)) {
    return true;
  }

  markAgentChatTurnStopped(typeof item.turnId === 'string' ? (item.turnId as string) : null, {
    runId:
      typeof item.runId === 'string'
        ? (item.runId as string)
        : typeof item.lastRunId === 'string'
          ? (item.lastRunId as string)
          : null,
    errorMessage: 'Removed from queue',
  });
  store.delete(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  return true;
}

export function clearAgentConversationQueue(agentId: string, conversationId: string): number {
  const items = getConversationQueueItems(agentId, conversationId);
  const count = items.filter((i) => i.status === 'queued').length;
  for (const item of items) {
    if (typeof item.id === 'string' && deleteNotStartedQueuedTurn(item.id, item, agentId, conversationId)) {
      continue;
    }
    markAgentChatTurnStopped(typeof item.turnId === 'string' ? (item.turnId as string) : null, {
      errorMessage: 'Removed from queue',
    });
  }
  for (const item of items) {
    if (typeof item.id === 'string') {
      store.delete(AGENT_CHAT_QUEUE_COLLECTION, item.id);
    }
  }
  return count;
}

export function reorderQueueItems(
  agentId: string,
  conversationId: string,
  orderedIds: string[],
): boolean {
  const items = getConversationQueueItems(agentId, conversationId);
  const itemMap = new Map(items.map((i) => [i.id as string, i]));

  // Validate all IDs belong to current queued items
  for (const id of orderedIds) {
    if (!itemMap.has(id)) {
      throw AgentChatError.badRequest(
        'queue_reorder_invalid_ids',
        'Queue reorder payload contains unknown item IDs',
      );
    }
  }
  if (orderedIds.length !== items.length) {
    throw AgentChatError.badRequest(
      'queue_reorder_incomplete',
      'Queue reorder payload must include every queued item exactly once',
    );
  }

  // Assign new createdAt timestamps to enforce ordering
  const baseTime = Date.now();
  for (let i = 0; i < orderedIds.length; i++) {
    const item = itemMap.get(orderedIds[i]);
    const createdAt = new Date(baseTime + i).toISOString();
    store.update(AGENT_CHAT_QUEUE_COLLECTION, orderedIds[i], {
      createdAt,
    });
    if (typeof item?.turnId === 'string') {
      updateAgentChatTurn(item.turnId, { createdAt });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Execute cron task (cron job trigger)
// ---------------------------------------------------------------------------

export function executeCronTask(agentId: string, job: { id: string; prompt: string }) {
  const key = `${agentId}:cron:${job.id}`;
  if (remoteRunKeys.has(key)) {
    // Previous run still in progress — skip this invocation
    return;
  }

  const triggerContext = buildTriggerContext('cron_job', {
    agentId,
    cronJobId: job.id,
  });

  const prompt =
    `${triggerContext}` +
    `You have been triggered by a scheduled cron job.\n` +
    `This is a background automation run, not a chat conversation. Do not call /api/agents/:id/chat/messages.\n` +
    `Use OpenWork API endpoints for all platform state changes. Do not edit platform persistence files or database artifacts directly.\n\n` +
    `**Task:** ${job.prompt}\n\n` +
    `Complete this task.`;

  void Promise.all([prepareAgentWorkspaceAccess(agentId), getFallbackModelConfig()])
    .then(([agent, globalFallback]) => {
      if (!agent) return;

      const spawnCronRun = (effectiveAgent: typeof agent, isFallback: boolean) => {
        void runAgentProcess({
          agentId,
          agent: effectiveAgent,

          runKey: key,
          prompt,
          triggerType: 'cron_job',
          triggerRef: { cronJobId: job.id },
          onExit: ({ code, stdout, stderr }) => {
            const terminalRunError = getTerminalRunErrorMessage(null);
            if (terminalRunError && !isFallback) {
              const fallbackAgent = applyFallbackModel(agent, globalFallback);
              if (fallbackAgent) {
                console.log(
                  `[agent-chat] Cron job ${job.id} primary model failed: ${terminalRunError}. Retrying with fallback model "${fallbackAgent.model}"...`,
                );
                spawnCronRun(fallbackAgent, true);
                return;
              }
            }
            if (terminalRunError) {
              console.error(`Agent cron task error for job ${job.id}:`, terminalRunError);
              return;
            }

            if ((code ?? 1) !== 0 && !stdout.trim() && !isFallback) {
              const fallbackAgent = applyFallbackModel(agent, globalFallback);
              if (fallbackAgent) {
                const errMsg = stderr.trim() || `Process exited with code ${code}`;
                console.log(
                  `[agent-chat] Cron job ${job.id} primary model failed: ${errMsg}. Retrying with fallback model "${fallbackAgent.model}"...`,
                );
                spawnCronRun(fallbackAgent, true);
                return;
              }
            }
            if ((code ?? 1) !== 0) {
              const errMsg = stderr.trim() || `Process exited with code ${code}`;
              console.error(`Agent cron task error for job ${job.id}:`, errMsg);
            }
          },
          onSpawnError: (err) => {
            if (!isFallback) {
              const fallbackAgent = applyFallbackModel(agent, globalFallback);
              if (fallbackAgent) {
                console.log(
                  `[agent-chat] Cron job ${job.id} primary model runner dispatch failed: ${err.message}. Retrying with fallback model "${fallbackAgent.model}"...`,
                );
                spawnCronRun(fallbackAgent, true);
                return;
              }
            }
            console.error(`Agent cron task failed to start for job ${job.id}:`, err.message);
          },
        }).catch((err: unknown) => {
          console.error(`Agent cron task failed for job ${job.id}:`, (err as Error).message);
        });
      };

      spawnCronRun(agent, false);
    })
    .catch((error: unknown) => {
      console.error(
        `Agent cron task failed to prepare for job ${job.id}:`,
        (error as Error).message,
      );
    });
}

// ---------------------------------------------------------------------------
// Execute card task (card assignment trigger)
// ---------------------------------------------------------------------------

export function executeCardTask(
  agentId: string,
  card: { id: string; name: string; description: string | null; collectionId: string },
  callbacks: {
    onDone: () => void;
    onError: (err: string) => void;
    onRunCreated?: (runId: string) => void;
  },
  customPrompt?: string,
) {
  const key = `${agentId}:card:${card.id}`;
  if (remoteRunKeys.has(key)) {
    callbacks.onError('Agent is already processing this card');
    return;
  }

  const triggerContext = buildTriggerContext('card_assignment', {
    agentId,
    cardId: card.id,
  });

  const descriptionLine = card.description
    ? `**Description:** ${card.description}`
    : '**Description:** (none)';

  const prompt = customPrompt
    ? `${triggerContext}` +
      `You are running a batch task on a card.\n\n` +
      `**Card:** ${card.name}\n` +
      `${descriptionLine}\n\n` +
      `**Task:**\n${customPrompt}`
    : `${triggerContext}` +
      `You have been assigned the following card.\n\n` +
      `**Card:** ${card.name}\n` +
      `${descriptionLine}\n\n` +
      `Complete this task.`;

  void Promise.all([prepareAgentWorkspaceAccess(agentId), getFallbackModelConfig()])
    .then(([agent, globalFallback]) => {
      if (!agent) {
        callbacks.onError('Agent not found');
        return;
      }

      let spawnedRunId: string | null = null;

      const spawnCardRun = (effectiveAgent: typeof agent, isFallback: boolean) => {
        spawnedRunId = null;
        void runAgentProcess({
          agentId,
          agent: effectiveAgent,

          runKey: key,
          prompt,
          triggerType: 'card_assignment',
          triggerRef: { cardId: card.id },
          onRunCreated: (runId) => {
            spawnedRunId = runId;
            callbacks.onRunCreated?.(runId);
          },
          onExit: ({ code, stdout, stderr }) => {
            if (isCurrentRunKilledByUser(spawnedRunId)) {
              callbacks.onError('Killed by user');
              return;
            }

            const terminalRunError = getTerminalRunErrorMessage(spawnedRunId);
            if (terminalRunError) {
              if (
                shouldAttemptFallbackRetry({
                  runId: spawnedRunId,
                  errorMessage: terminalRunError,
                  isFallback,
                  hasFallback: Boolean(globalFallback),
                })
              ) {
                const fallbackAgent = applyFallbackModel(agent, globalFallback);
                if (fallbackAgent) {
                  console.log(
                    `[agent-chat] Card task ${card.id} primary model failed: ${terminalRunError}. Retrying with fallback model "${fallbackAgent.model}"...`,
                  );
                  spawnCardRun(fallbackAgent, true);
                  return;
                }
              }
              callbacks.onError(terminalRunError);
              return;
            }

            if ((code ?? 1) !== 0 && !stdout.trim() && !isFallback) {
              const fallbackAgent = applyFallbackModel(agent, globalFallback);
              if (fallbackAgent) {
                const errMsg = stderr.trim() || `Process exited with code ${code}`;
                console.log(
                  `[agent-chat] Card task ${card.id} primary model failed: ${errMsg}. Retrying with fallback model "${fallbackAgent.model}"...`,
                );
                spawnCardRun(fallbackAgent, true);
                return;
              }
            }
            if ((code ?? 1) !== 0) {
              const errMsg = stderr.trim() || `Process exited with code ${code}`;
              callbacks.onError(errMsg);
              return;
            }

            const terminalRun = spawnedRunId ? getAgentRun(spawnedRunId) : null;
            if (terminalRun?.status === 'error') {
              const errMsg =
                typeof terminalRun.errorMessage === 'string' && terminalRun.errorMessage
                  ? terminalRun.errorMessage
                  : 'Agent run did not produce a clean completion.';
              callbacks.onError(errMsg);
              return;
            }

            callbacks.onDone();
          },
          onSpawnError: (err) => {
            if (isCurrentRunKilledByUser(spawnedRunId, err.message)) {
              callbacks.onError('Killed by user');
              return;
            }

            if (!isFallback) {
              const fallbackAgent = applyFallbackModel(agent, globalFallback);
              if (
                fallbackAgent &&
                shouldAttemptFallbackRetry({
                  runId: spawnedRunId,
                  errorMessage: err.message,
                  isFallback,
                  hasFallback: true,
                })
              ) {
                console.log(
                  `[agent-chat] Card task ${card.id} primary model runner dispatch failed: ${err.message}. Retrying with fallback model "${fallbackAgent.model}"...`,
                );
                spawnCardRun(fallbackAgent, true);
                return;
              }
            }
            callbacks.onError(err.message);
          },
        }).catch((err: unknown) => {
          const message = (err as Error).message;
          if (!spawnedRunId) {
            void persistFailedCardAssignmentStartupRun({
              agentId,
              agent: effectiveAgent,
              cardId: card.id,
              prompt,
              errorMessage: message,
              onRunCreated: (runId) => {
                spawnedRunId = runId;
                callbacks.onRunCreated?.(runId);
              },
            }).finally(() => callbacks.onError(message));
            return;
          }
          callbacks.onError(message);
        });
      };

      spawnCardRun(agent, false);
    })
    .catch((error: unknown) => {
      callbacks.onError((error as Error).message);
    });
}
