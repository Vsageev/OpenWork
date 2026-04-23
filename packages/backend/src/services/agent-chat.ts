import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { extractFinalResponseText } from '../lib/agent-output.js';
import { allocatePort, releasePort } from '../lib/port-allocator.js';
import {
  getAgent,
  getCliInfo,
  listAgents,
  prepareAgentWorkspaceAccess,
  resolveCliExecutable,
} from './agents.js';
import { resolveAgentWorkspacePath } from './agent-workspaces.js';
import { listAgentEnvVars, listRuntimeAgentEnvVarBindings } from './agent-env-vars.js';
import { createAgentRun, completeAgentRun } from './agent-runs.js';
import { getFallbackModelConfig } from './project-settings.js';

const STORAGE_DIR = path.resolve(env.DATA_DIR, 'storage');

export const RUNS_DIR = path.resolve(env.DATA_DIR, 'agent-runs');
const AGENT_CHAT_QUEUE_COLLECTION = 'agentChatQueue';
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
 * Global concurrency gate — tracks how many agent processes are running
 * across all conversations. When at capacity, new spawns are deferred
 * until a slot opens up.
 */
let globalRunningCount = 0;
const concurrencyWaiters: Array<() => void> = [];

function getMaxConcurrentAgents(): number {
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
      globalRunningCount++;
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
  const livePersistedRuns = store.count(
    'agent_runs',
    (r: Record<string, unknown>) =>
      r.status === 'running' && typeof r.pid === 'number' && isPidAlive(r.pid as number),
  );
  return Math.max(globalRunningCount, livePersistedRuns);
}

export function getMaxConcurrentAgentLimit(): number {
  return getMaxConcurrentAgents();
}
const AGENT_CHAT_QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
const AGENT_CHAT_RECOVERED_QUEUE_MATCH_WINDOW_MS = 5 * 60 * 1000;
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

// ---------------------------------------------------------------------------
// CLI command builders
// ---------------------------------------------------------------------------

interface CliCommand {
  bin: string;
  args: string[];
  stdinData?: string;
}

interface BuildCliOptions {
  model: string;
  modelId?: string | null;
  thinkingLevel?: 'low' | 'medium' | 'high' | null;
  prompt: string;
  imagePaths?: string[];
  filePaths?: string[];
}

function appendAttachmentPathsToPrompt(
  prompt: string,
  imagePaths?: string[],
  filePaths?: string[],
): string {
  const sections: string[] = [];

  if (imagePaths && imagePaths.length > 0) {
    sections.push(`Image files:\n${imagePaths.map((p) => `- ${p}`).join('\n')}`);
  }
  if (filePaths && filePaths.length > 0) {
    sections.push(`Files:\n${filePaths.map((p) => `- ${p}`).join('\n')}`);
  }
  if (sections.length === 0) return prompt;

  return `${prompt ? prompt + '\n\n' : ''}${sections.join('\n\n')}`;
}

function buildMissingCliError(command: string, model: string): Error {
  const cliInfo = getCliInfo(model) ?? getCliInfo(command);
  if (!cliInfo) {
    return new Error(`Command "${command}" is not installed or not available on the server PATH.`);
  }

  return new Error(
    `${cliInfo.name} CLI is not installed or not available on the server PATH ` +
      `(expected command: ${cliInfo.command}). Install it from ${cliInfo.downloadUrl}.`,
  );
}

function buildCliCommand(options: BuildCliOptions): CliCommand {
  const { model, modelId, thinkingLevel, prompt, imagePaths, filePaths } = options;
  const modelLower = model.trim().toLowerCase();
  const fullPrompt = appendAttachmentPathsToPrompt(prompt, imagePaths, filePaths);

  if (modelLower.includes('claude')) {
    const args: string[] = [];

    // Stream structured events so run logs contain full model output, not only final text.
    args.push(
      '-p',
      fullPrompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
    );

    if (modelId) {
      args.push('--model', modelId);
    }
    if (thinkingLevel) {
      args.push('--effort', thinkingLevel);
    }
    // Always run without interactive permission prompts.
    args.push('--dangerously-skip-permissions');
    return { bin: 'claude', args };
  }
  if (modelLower.includes('codex')) {
    // Run codex in regular exec mode for conversational responses.
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox'];
    if (imagePaths && imagePaths.length > 0) {
      args.push('--image', ...imagePaths);
    }
    if (modelId) {
      args.push('--model', modelId);
    }
    if (thinkingLevel) {
      args.push('-c', `model_reasoning_effort="${thinkingLevel}"`);
    }
    args.push('--', appendAttachmentPathsToPrompt(prompt, imagePaths, filePaths));
    return { bin: 'codex', args };
  }
  if (modelLower.includes('qwen')) {
    // Stream structured events so run logs contain full model output, not only final text.
    const args = ['--output-format', 'stream-json', '--include-partial-messages'];
    // Always run without interactive approvals.
    args.push('--approval-mode', 'yolo');
    if (modelId) {
      args.push('--model', modelId);
    }
    // Use explicit prompt flag for compatibility with CLI variants that don't
    // accept positional prompt input in non-interactive mode.
    args.push('--prompt', fullPrompt);
    return { bin: 'qwen', args };
  }
  if (modelLower.includes('cursor')) {
    // Stream structured events so run logs contain full model output, including thinking deltas.
    const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--force', '--trust'];
    if (modelId) {
      args.push('--model', modelId);
    }
    args.push(fullPrompt);
    return { bin: 'cursor-agent', args };
  }
  if (modelLower.includes('opencode')) {
    const args = ['run', '--format', 'json'];
    if (modelId) {
      args.push('--model', modelId);
    }
    if (thinkingLevel) {
      args.push('--variant', thinkingLevel);
    }
    for (const filePath of [...(imagePaths ?? []), ...(filePaths ?? [])]) {
      args.push('--file', filePath);
    }
    args.push(fullPrompt);
    return { bin: 'opencode', args };
  }

  // Fallback: treat model name as CLI binary with claude-like flags
  const args = ['-p', fullPrompt, '--output-format', 'text'];
  if (modelId) {
    args.push('--model', modelId);
  }
  return { bin: modelLower, args };
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
  const all = store.find(
    'conversations',
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
    isBusy,
    queuedCount,
    hasFailed,
  };
}

/**
 * List recent agent chat conversations across ALL agents, sorted by lastMessageAt desc.
 * Returns agent metadata alongside each conversation.
 */
export function listRecentAgentConversations(limit = 10) {
  const agents = listAgents();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const all = store.find('conversations', (r: Record<string, unknown>) => {
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
    };
  });

  return { entries };
}

/**
 * Search messages across all agent chat conversations by content.
 * Returns matches with snippet + agent/conversation metadata so UI can preview
 * and jump to the exact message in its conversation.
 */
export function searchAgentMessages(query: string, limit = 20) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return { entries: [] };
  const lowerQuery = normalizedQuery.toLowerCase();

  const agents = listAgents();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // Build map of conversationId -> { agentId, conversation }
  const convMap = new Map<string, { agentId: string; conversation: Record<string, unknown> }>();
  for (const conv of store.find('conversations', (r) => r.channelType === 'agent')) {
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
  return store.insert('conversations', {
    contactId: 'system',
    channelType: 'agent',
    status: 'open',
    subject: subject ?? null,
    externalId: null,
    isUnread: false,
    lastMessageAt: null,
    metadata: JSON.stringify({ agentId }),
  });
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
export function deleteAgentConversation(conversationId: string) {
  store.deleteWhere(
    'messages',
    (r: Record<string, unknown>) => r.conversationId === conversationId,
  );
  store.deleteWhere(
    'messageDrafts',
    (r: Record<string, unknown>) => r.conversationId === conversationId,
  );
  clearConversationQueue(conversationId);
  return store.delete('conversations', conversationId);
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
  const msgs = store.find(
    'messages',
    (r: Record<string, unknown>) => r.conversationId === conversationId && r.parentId != null,
  );
  return msgs.length > 0;
}

function listConversationMessages(conversationId: string): Record<string, unknown>[] {
  return store
    .find('messages', (r: Record<string, unknown>) => r.conversationId === conversationId)
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime(),
    );
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
  return getSelectableBranchChildren(childrenMap, parentId).filter(
    (message) => message.direction !== 'outbound',
  );
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

  const allMessages = store
    .find('messages', (r: Record<string, unknown>) => r.conversationId === conversationId)
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime(),
    );

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
    const previousUserMessageId = getPreviousUserMessageIdForConversationMessage(
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
    const previousUserMessageId = getPreviousUserMessageIdForConversationMessage(
      conversationId,
      currentUser,
    );
    currentUser = previousUserMessageId ? (messagesById.get(previousUserMessageId) ?? null) : null;
  }

  const path: TreePathMessage[] = [];
  for (const userMessage of userLineage.reverse()) {
    const previousUserMessageId = getPreviousUserMessageIdForConversationMessage(
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

export function getPreviousUserMessageIdForConversationMessage(
  conversationId: string,
  message: Record<string, unknown>,
): string | null {
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

  const stored =
    typeof message.previousUserMessageId === 'string'
      ? (message.previousUserMessageId as string)
      : null;
  if (stored) return stored;
  return findPreviousOutboundAncestor(conversationId, (message.parentId as string | null) ?? null);
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

  const pendingQueuedMessage = store.findOne(
    AGENT_CHAT_QUEUE_COLLECTION,
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
  const parentId = ((original.parentId as string | null | undefined) ?? null);
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
export function switchBranch(conversationId: string, messageId: string): void {
  const msg = store.getById('messages', messageId);
  if (!msg) throw AgentChatError.notFound('message_not_found', 'Message not found');
  if (msg.conversationId !== conversationId) {
    throw AgentChatError.notFound('message_not_found', 'Message not found');
  }

  const allMessages = listConversationMessages(conversationId);
  const siblings =
    msg.direction === 'outbound'
      ? allMessages.filter(
          (candidate) =>
            candidate.direction === 'outbound' &&
            getPreviousUserMessageIdForConversationMessage(conversationId, candidate) ===
              getPreviousUserMessageIdForConversationMessage(conversationId, msg),
        )
      : allMessages
          .filter(
            (candidate) =>
              ((candidate.parentId as string | null) ?? null) ===
                ((msg.parentId as string | null) ?? null) && candidate.direction !== 'outbound',
          )
          .filter((candidate) => !isNonFinalAgentUpdateMessage(candidate));
  if (siblings.length <= 1 || !siblings.some((candidate) => candidate.id === messageId)) {
    throw AgentChatError.badRequest(
      'invalid_branch_choice',
      'Message is not a valid branch choice',
    );
  }

  activateMessagePath(conversationId, messageId);
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

  if (canAdvanceActiveBranch) {
    if (params.direction === 'outbound') {
      const selectionKey = getUserBranchSelectionKey(previousUserMessageId);
      if (shouldAutoSelectNewChild(params.conversationId, selectionKey, currentLeafId)) {
        setActiveBranchSelection(params.conversationId, selectionKey, msg.id as string);
      }
    } else if (parentId) {
      const selectionKey = getReplyBranchSelectionKey(parentId);
      if (shouldAutoSelectNewChild(params.conversationId, selectionKey, currentLeafId)) {
        setActiveBranchSelection(params.conversationId, selectionKey, msg.id as string);
      }
    }
  }

  if (params.direction === 'outbound') {
    autoTitleIfNeeded(
      params.conversationId,
      buildAutoTitleFromMessage(params.content, params.type ?? 'text', params.attachments),
    );
  }

  return msg;
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
    return null;
  }

  return (
    [...pendingItems]
      .reverse()
      .find((item) => {
        const mode = getQueueItemMode(item);
        if (mode === 'respond_to_message') {
          return item.targetMessageId === continuationParentId;
        }

        return item.queuedMessageId === continuationParentId;
      }) ?? null
  );
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

  const getConversationMessageId = (messageId: unknown): string | null => {
    if (typeof messageId !== 'string') return null;
    const message = store.getById('messages', messageId);
    if (!message || message.conversationId !== conversationId) return null;
    return messageId;
  };

  let parentId =
    typeof queueItem.previousUserMessageId === 'string' || queueItem.previousUserMessageId === null
      ? getContinuationParentIdForPreviousUserMessage(
          conversationId,
          (queueItem.previousUserMessageId as string | null | undefined) ?? null,
        )
      : getConversationMessageId(queueItem.continuationParentId);
  const dependsOnQueueItemId =
    typeof queueItem.dependsOnQueueItemId === 'string'
      ? (queueItem.dependsOnQueueItemId as string)
      : null;
  if (dependsOnQueueItemId) {
    const dependency = store.getById(AGENT_CHAT_QUEUE_COLLECTION, dependsOnQueueItemId);
    if (dependency && dependency.conversationId === conversationId) {
      parentId =
        getConversationMessageId(dependency.responseMessageId) ??
        getConversationMessageId(getQueueItemAnchorMessageId(dependency)) ??
        parentId;
    }
  }
  parentId ??= getCurrentConversationLeafId(conversationId);

  if (parentId) {
    activateMessagePath(conversationId, parentId);
  }

  const userMessage = saveAgentConversationMessage({
    id:
      typeof queueItem.queuedMessageId === 'string' ? (queueItem.queuedMessageId as string) : undefined,
    conversationId,
    direction: 'outbound',
    content: prompt,
    type: 'text',
    metadata: null,
    parentId,
    previousUserMessageId:
      typeof queueItem.previousUserMessageId === 'string' || queueItem.previousUserMessageId === null
        ? ((queueItem.previousUserMessageId as string | null | undefined) ?? null)
        : undefined,
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

function storageDiskPath(storagePath: string): string {
  return path.resolve(STORAGE_DIR, '.' + storagePath);
}

interface ConversationAttachmentDiskPaths {
  imagePaths: string[];
  filePaths: string[];
}

/** Returns disk paths for attachments in the most recent attachment message of the active path. */
function getConversationAttachmentDiskPaths(
  conversationId: string,
  leafMessageId?: string,
): ConversationAttachmentDiskPaths {
  const activePath = leafMessageId
    ? getMessagePathToLeaf(conversationId, leafMessageId)
    : isTreeEnabledConversation(conversationId)
      ? getActiveMessagePath(conversationId)
      : listConversationMessages(conversationId);

  const attachmentMsgs = activePath
    .filter((msg) => parseAttachments(msg.attachments).length > 0)
    .reverse();

  if (attachmentMsgs.length === 0) {
    return { imagePaths: [], filePaths: [] };
  }

  const latest = attachmentMsgs[0];
  const attachments = parseAttachments(latest.attachments);
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  for (const att of attachments) {
    if (typeof att.storagePath !== 'string') continue;
    const diskPath = storageDiskPath(att.storagePath);
    if (!fs.existsSync(diskPath)) continue;
    if (att.type === 'image') imagePaths.push(diskPath);
    else filePaths.push(diskPath);
  }
  return { imagePaths, filePaths };
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
): string {
  const history = leafMessageId
    ? getMessagePathToLeaf(conversationId, leafMessageId)
    : isTreeEnabledConversation(conversationId)
      ? getActiveMessagePath(conversationId)
      : listConversationMessages(conversationId);

  const triggerContext = buildTriggerContext('chat', {
    agentId,
    conversationId,
  });

  if (history.length === 0 && currentPrompt) {
    return `${triggerContext}User: ${currentPrompt}`;
  }

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

  return `${triggerContext}\nContinue the conversation below. Only respond to the latest User message.\n\n${lines.join('\n\n')}`;
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
  };
  runKey: string;
  prompt: string;
  imagePaths?: string[];
  filePaths?: string[];
  triggerType: TriggerType;
  triggerRef?: { conversationId?: string; cardId?: string; cronJobId?: string };
  responseParentId?: string | null;
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

function buildEnvVarContextBlock(agentId: string): string {
  const envVars = listAgentEnvVars(agentId).filter((entry) => entry.isActive);
  if (envVars.length === 0) return '';

  const lines = [
    'Environment Variable Context',
    'These env vars are configured for this agent and available in the runtime environment.',
    'Use them only when needed. Never print full secret values in responses.',
  ];

  for (const entry of envVars) {
    lines.push(`- ${entry.key}`);
    if (entry.description) {
      lines.push(`  Description: ${entry.description}`);
    }
  }

  lines.push('End Environment Variable Context');
  return lines.join('\n');
}

function buildChildEnv(
  agentId: string,
  agent: { apiKeyId: string; workspaceApiKey: string | null },
): Record<string, string | undefined> {
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
    const apiKey = store.getById('apiKeys', agent.apiKeyId);
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

  for (const entry of listRuntimeAgentEnvVarBindings(agentId)) {
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
  return store
    .find(
      'messages',
      (r: Record<string, unknown>) =>
        r.conversationId === conversationId &&
        r.direction === 'inbound' &&
        new Date(r.createdAt as string).getTime() >= runStartedAt &&
        parseMetadata(r.metadata)?.agentChatUpdate === true,
    )
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime(),
    );
}

function findFinalAgentApiMessage(messages: Record<string, unknown>[]) {
  return (
    [...messages].reverse().find((msg) => parseMetadata(msg.metadata)?.isFinal === true) ?? null
  );
}

function listConversationInboundMessages(conversationId: string, sinceMs: number) {
  return store
    .find(
      'messages',
      (r: Record<string, unknown>) =>
        r.conversationId === conversationId &&
        r.direction === 'inbound' &&
        new Date(r.createdAt as string).getTime() >= sinceMs,
    )
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime(),
    );
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

/** Matches `POST /api/cards/:id/comments` body max length. */
const MAX_CARD_AUTO_COMMENT_LENGTH = 5000;

/**
 * When a card-assignment run finishes successfully, persist the same final text
 * users see on the agent run (stdout extraction) as a card comment — parallel to
 * chat runs saving `saveAgentRunResponse`. Uses `agentRunId` for idempotency.
 */
function persistCompletedCardAssignmentComment(params: {
  cardId: string;
  agentId: string;
  runId: string;
  runStartedAtMs: number;
  stdout: string;
}): void {
  const { cardId, agentId, runId, runStartedAtMs, stdout } = params;
  try {
    const dupByRun = store.find(
      'cardComments',
      (r: Record<string, unknown>) =>
        r.cardId === cardId && r.agentRunId === runId,
    );
    if (dupByRun.length > 0) return;

    let content = extractFinalResponseText(stdout).trim();
    if (!content) content = '(empty response)';
    if (content.length > MAX_CARD_AUTO_COMMENT_LENGTH) {
      content = `${content.slice(0, MAX_CARD_AUTO_COMMENT_LENGTH - 1)}…`;
    }

    const since = Number.isFinite(runStartedAtMs) ? runStartedAtMs : 0;
    const manualDup = store.find(
      'cardComments',
      (r: Record<string, unknown>) => {
        if (r.cardId !== cardId || r.authorId !== agentId) return false;
        if (r.agentRunId) return false;
        const t = new Date(r.createdAt as string).getTime();
        if (!Number.isFinite(t) || t < since) return false;
        return String(r.content || '').trim() === content;
      },
    );
    if (manualDup.length > 0) return;

    store.insert('cardComments', {
      cardId,
      authorId: agentId,
      content,
      agentRunId: runId,
    });
  } catch (err) {
    console.error(
      `[agent-chat] Failed to persist card assignment comment for run ${runId}:`,
      (err as Error).message,
    );
  }
}

// ---------------------------------------------------------------------------
// RunHandle — replaces ChildProcess in the running processes map
// ---------------------------------------------------------------------------

interface RunHandle {
  runId: string;
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutOffset: number;
  pollTimer: ReturnType<typeof setInterval>;
  watcher: fs.FSWatcher | null;
  onStdoutChunk: ((text: string) => void) | null;
  onExit: ((result: AgentProcessResult) => void) | null;
  allocatedPort: number | null;
}

// Track running processes per run key so parallel chats/tasks can run.
const runningProcesses = new Map<string, RunHandle>();
const queueProcessors = new Set<string>();
const queueDrainTimers = new Map<string, QueueDrainTimer>();

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
  return store
    .find(
      'agent_runs',
      (r: Record<string, unknown>) =>
        r.status === 'running' &&
        r.triggerType === 'chat' &&
        r.agentId === agentId &&
        r.conversationId === conversationId,
    )
    .some((run) => {
      const pid = typeof run.pid === 'number' ? (run.pid as number) : null;
      if (!pid || !isPidAlive(pid)) return false;
      if (targetMessageId === undefined) return true;
      const responseParentId =
        typeof run.responseParentId === 'string' ? (run.responseParentId as string) : null;
      return responseParentId === (targetMessageId ?? null);
    });
}

function hasRunningProcessForTargetMessage(
  agentId: string,
  conversationId: string,
  targetMessageId: string,
): boolean {
  if (runningProcesses.has(processKey(agentId, conversationId, targetMessageId))) {
    return true;
  }
  return hasLivePersistedChatRun(agentId, conversationId, targetMessageId);
}

/** Check if ANY process is running for a given conversation (across all branches). */
function hasRunningProcessForConversation(agentId: string, conversationId: string): boolean {
  const prefix = `${agentId}:${conversationId}`;
  for (const key of runningProcesses.keys()) {
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

function isRunMarkedKilledByUser(runId: string | null): boolean {
  if (!runId) return false;
  const run = store.getById('agent_runs', runId);
  if (!run) return false;
  return run.killedByUser === true || run.errorMessage === 'Killed by user';
}

function listConversationQueueItems(
  agentId: string,
  conversationId: string,
): Record<string, unknown>[] {
  return store
    .find(
      AGENT_CHAT_QUEUE_COLLECTION,
      (r: Record<string, unknown>) => r.agentId === agentId && r.conversationId === conversationId,
    )
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt),
    );
}

function sanitizeQueueItemForChat(item: Record<string, unknown>): Record<string, unknown> {
  if (typeof item.errorMessage !== 'string' || !item.errorMessage) {
    return item;
  }

  if (item.status !== 'failed' && item.status !== 'queued') {
    return item;
  }

  const summarizedError = summarizeQueueErrorForChat(item.errorMessage);
  if (summarizedError === item.errorMessage) {
    return item;
  }

  return {
    ...item,
    errorMessage: summarizedError,
  };
}

function getQueueItemMode(item: Record<string, unknown>): QueueExecutionMode {
  return (item.mode as QueueExecutionMode | undefined) ?? 'append_prompt';
}

function isPendingQueueItem(item: Record<string, unknown>): boolean {
  return item.status === 'queued' || item.status === 'processing';
}

function hasPendingExecutionItems(agentId: string, conversationId: string): boolean {
  return listConversationQueueItems(agentId, conversationId).some((item) =>
    isPendingQueueItem(item),
  );
}

function getPendingQueueCount(agentId: string, conversationId: string): number {
  return store.count(
    AGENT_CHAT_QUEUE_COLLECTION,
    (r: Record<string, unknown>) =>
      r.agentId === agentId && r.conversationId === conversationId && r.status === 'queued',
  );
}

function getQueuedAppendPromptCount(agentId: string, conversationId: string): number {
  return store.count(
    AGENT_CHAT_QUEUE_COLLECTION,
    (r: Record<string, unknown>) =>
      r.agentId === agentId &&
      r.conversationId === conversationId &&
      r.status === 'queued' &&
      getQueueItemMode(r) === 'append_prompt',
  );
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

// ---------------------------------------------------------------------------
// attachToProcess — shared between fresh spawn and re-attach
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface AttachOptions {
  runId: string;
  runKey: string;
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  runStartedAt: number;
  agentId: string;
  onStdoutChunk?: ((text: string) => void) | null;
  onExit?: ((result: AgentProcessResult) => void) | null;
}

function attachToProcess(options: AttachOptions): RunHandle {
  const { runId, runKey, pid, stdoutPath, stderrPath, runStartedAt, agentId } = options;

  let stdoutOffset = 0;

  // Try to read any existing output (for re-attach catch-up)
  try {
    const stat = fs.statSync(stdoutPath);
    // For re-attach we start from where file currently is — caller handles catch-up
    stdoutOffset = stat.size;
  } catch {
    // File may not exist yet
  }

  function readNewOutput() {
    try {
      const stat = fs.statSync(stdoutPath);
      if (stat.size <= handle.stdoutOffset) return;

      const fd = fs.openSync(stdoutPath, 'r');
      const buf = Buffer.alloc(stat.size - handle.stdoutOffset);
      fs.readSync(fd, buf, 0, buf.length, handle.stdoutOffset);
      fs.closeSync(fd);

      handle.stdoutOffset = stat.size;
      const text = buf.toString('utf-8');
      if (text && handle.onStdoutChunk) {
        handle.onStdoutChunk(text);
      }
    } catch {
      // File may have been deleted or is being written to
    }
  }

  function finalize() {
    clearInterval(handle.pollTimer);
    if (handle.watcher) {
      handle.watcher.close();
      handle.watcher = null;
    }
    if (handle.allocatedPort !== null) {
      releasePort(handle.allocatedPort);
    }
    runningProcesses.delete(runKey);
    releaseConcurrencySlot();

    // Read final output
    let stdout = '';
    let stderr = '';
    try {
      stdout = fs.readFileSync(stdoutPath, 'utf-8');
    } catch {
      /* */
    }
    try {
      stderr = fs.readFileSync(stderrPath, 'utf-8');
    } catch {
      /* */
    }

    markAgentLastActivity(agentId);
    const hasError = !stdout.trim();
    const errorMsg = hasError ? stderr.trim() || 'Process exited' : null;
    completeAgentRun(runId, errorMsg, { stdout, stderr });

    if (handle.onExit) {
      handle.onExit({ code: hasError ? 1 : 0, stdout, stderr, runStartedAt });
    }
  }

  // Set up file watcher for stdout
  let watcher: fs.FSWatcher | null = null;
  try {
    // Ensure the file exists before watching
    if (fs.existsSync(stdoutPath)) {
      watcher = fs.watch(stdoutPath, () => {
        readNewOutput();
      });
      watcher.on('error', () => {
        // Ignore watcher errors
      });
    }
  } catch {
    // fs.watch not always available
  }

  // Poll PID every 1s to detect exit
  const pollTimer = setInterval(() => {
    // Also read output on each poll in case watcher missed events
    readNewOutput();

    if (!isPidAlive(pid)) {
      // Give a small delay for final I/O flush
      setTimeout(() => {
        readNewOutput();
        finalize();
      }, 500);
    }
  }, 1000);

  const handle: RunHandle = {
    runId,
    pid,
    stdoutPath,
    stderrPath,
    stdoutOffset,
    pollTimer,
    watcher,
    onStdoutChunk: options.onStdoutChunk ?? null,
    onExit: options.onExit ?? null,
    allocatedPort: null,
  };

  runningProcesses.set(runKey, handle);
  return handle;
}

// ---------------------------------------------------------------------------
// runAgentProcess — spawns detached, writes to files
// ---------------------------------------------------------------------------

async function runAgentProcess(options: AgentProcessOptions): Promise<string> {
  // Wait for a global concurrency slot before spawning
  await waitForConcurrencySlot();

  const workDir = resolveAgentWorkspacePath(options.agentId);
  const { bin, args, stdinData } = buildCliCommand({
    model: options.agent.model,
    modelId: options.agent.modelId,
    thinkingLevel: options.agent.thinkingLevel,
    prompt: options.prompt,
    imagePaths: options.imagePaths,
    filePaths: options.filePaths,
  });
  const childEnv = buildChildEnv(options.agentId, options.agent);

  // Allocate a random port so the agent's project never conflicts with others
  const projectPort = await allocatePort();
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
  });
  const runId = agentRun.id as string;
  options.onRunCreated?.(runId);

  // Create run log directory
  const runLogDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runLogDir, { recursive: true });

  const stdoutPath = path.join(runLogDir, 'stdout.log');
  const stderrPath = path.join(runLogDir, 'stderr.log');

  // Open file descriptors for stdout/stderr
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');

  let child;
  try {
    const resolvedBin = resolveCliExecutable(bin);
    if (!resolvedBin) {
      throw buildMissingCliError(bin, options.agent.model);
    }

    child = spawn(resolvedBin, args, {
      cwd: workDir,
      env: childEnv,
      detached: true,
      stdio: [stdinData ? 'pipe' : 'ignore', stdoutFd, stderrFd],
    });
  } catch (err) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    releasePort(projectPort);
    releaseConcurrencySlot();
    completeAgentRun(runId, (err as Error).message);
    options.onSpawnError(err as Error);
    return runId;
  }

  // Write stdin data (e.g. stream-json for image messages) before unreffing.
  if (stdinData && child.stdin) {
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      // Child may exit before consuming stdin (e.g. invalid CLI args for image mode).
      if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        console.error(`[agent-chat] Failed writing stdin for run ${runId}:`, err.message);
      }
    });
    try {
      child.stdin.end(stdinData);
    } catch (err) {
      const stdinErr = err as NodeJS.ErrnoException;
      if (stdinErr.code !== 'EPIPE' && stdinErr.code !== 'ERR_STREAM_DESTROYED') {
        console.error(`[agent-chat] Failed writing stdin for run ${runId}:`, stdinErr.message);
      }
    }
  }

  // Unref so server can exit without killing the child
  child.unref();

  // Close FDs in parent — child owns them now
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const pid = child.pid!;
  const runStartedAt = Date.now();

  // Update DB with PID and paths
  store.update('agent_runs', runId, {
    pid,
    stdoutPath,
    stderrPath,
  });

  // Handle spawn errors (e.g. ENOENT)
  child.on('error', (err) => {
    // The process may not have started at all
    const handle = runningProcesses.get(options.runKey);
    if (handle) {
      clearInterval(handle.pollTimer);
      if (handle.watcher) handle.watcher.close();
      if (handle.allocatedPort !== null) releasePort(handle.allocatedPort);
      runningProcesses.delete(options.runKey);
    }
    releaseConcurrencySlot();
    completeAgentRun(runId, err.message, { stderr: err.message });
    options.onSpawnError(err);
  });

  // Attach monitoring — start reading from offset 0 since we just created the file
  const handle = attachToProcess({
    runId,
    runKey: options.runKey,
    pid,
    stdoutPath,
    stderrPath,
    runStartedAt,
    agentId: options.agentId,
    onStdoutChunk: options.onStdoutChunk,
    onExit: options.onExit,
  });

  // For fresh spawns, start reading from byte 0
  handle.stdoutOffset = 0;
  handle.allocatedPort = projectPort;
  return runId;
}

// ---------------------------------------------------------------------------
// reattachRunningProcess — called from reconcileRunsOnStartup
// ---------------------------------------------------------------------------

export function reattachRunningProcess(run: Record<string, unknown>) {
  const agentId = run.agentId as string;
  const conversationId = run.conversationId as string | null;
  const cronJobId = run.cronJobId as string | null;
  const cardId = run.cardId as string | null;
  const pid = run.pid as number;
  const runId = run.id as string;
  const stdoutPath = run.stdoutPath as string;
  const stderrPath = run.stderrPath as string;
  const triggerType = run.triggerType as TriggerType;
  const responseParentId =
    typeof run.responseParentId === 'string' ? (run.responseParentId as string) : null;

  // Reconstruct the run key
  let runKey: string;
  if (triggerType === 'chat' && conversationId) {
    runKey = processKey(agentId, conversationId, responseParentId);
  } else if (triggerType === 'cron_job' && cronJobId) {
    runKey = `${agentId}:cron:${cronJobId}`;
  } else if (triggerType === 'card_assignment' && cardId) {
    runKey = `${agentId}:card:${cardId}`;
  } else {
    runKey = `${agentId}:${runId}`;
  }

  if (runningProcesses.has(runKey)) return;
  globalRunningCount++;

  const runStartedAt = new Date(run.startedAt as string).getTime();

  const onExit = (result: AgentProcessResult) => {
    // For chat triggers, save the final message to conversation
    if (triggerType === 'chat' && conversationId) {
      if (isRunMarkedKilledByUser(runId)) {
        finalizeRecoveredQueueItemForRun(
          agentId,
          conversationId,
          runId,
          runStartedAt,
          null,
          'Killed by user',
        );
        return;
      }

      const updatesFromApi = listAgentApiUpdates(conversationId, runStartedAt);
      const finalApiMessage = findFinalAgentApiMessage(updatesFromApi);
      // extractFinalResponseText handles both plain text and stream-json output gracefully.
      const stdoutText = extractFinalResponseText(result.stdout);
      let finalMessage: Record<string, unknown> | null = null;

      if (finalApiMessage) {
        finalMessage = attachRunIdToMessage(finalApiMessage, runId);
      } else if (stdoutText) {
        finalMessage = saveAgentRunResponse(conversationId, stdoutText, responseParentId, {
          runId,
        });
      } else if (updatesFromApi.length > 0) {
        finalMessage = attachRunIdToMessage(updatesFromApi[updatesFromApi.length - 1], runId);
      }

      const fallbackErrorMessage =
        result.stderr.trim() || `Recovered run ${runId} exited without a response`;
      finalizeRecoveredQueueItemForRun(
        agentId,
        conversationId,
        runId,
        runStartedAt,
        finalMessage,
        fallbackErrorMessage,
      );
      return;
    }

    if (triggerType === 'card_assignment' && cardId) {
      if (isRunMarkedKilledByUser(runId)) return;
      if ((result.code ?? 1) !== 0) return;
      persistCompletedCardAssignmentComment({
        cardId,
        agentId,
        runId,
        runStartedAtMs: result.runStartedAt,
        stdout: result.stdout,
      });
    }
  };

  attachToProcess({
    runId,
    runKey,
    pid,
    stdoutPath,
    stderrPath,
    runStartedAt,
    agentId,
    onStdoutChunk: null,
    onExit,
  });

  console.log(`[agent-chat] Re-attached to process PID=${pid} for run ${runId} (${runKey})`);
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
    .find(
      'agent_runs',
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
  },
) {
  const isFallback = options?.isFallback ?? false;
  const responseParentId = options?.responseParentId ?? null;
  const targetMessageId = options?.targetMessageId ?? null;

  void prepareAgentWorkspaceAccess(agentId)
    .then((agent) => {
      if (!agent) {
        callbacks.onError('Agent not found');
        return;
      }

      // If this is a fallback retry, override agent model with global fallback settings
      const effectiveAgent = isFallback ? applyFallbackModel(agent) : agent;
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
        imagePaths: hasImages ? attachmentPaths.imagePaths : undefined,
        filePaths: hasFiles ? attachmentPaths.filePaths : undefined,
        triggerType: 'chat',
        triggerRef: { conversationId },
        responseParentId,
        onRunCreated: (runId) => {
          spawnedRunId = runId;
          callbacks.onRunCreated?.(runId);
        },
        onExit: ({ code, stdout, stderr, runStartedAt }) => {
          if (isRunMarkedKilledByUser(spawnedRunId)) {
            callbacks.onError('Killed by user');
            return;
          }

          if ((code ?? 1) !== 0 && !stdout.trim()) {
            // Primary model failed — attempt fallback if configured and not already a fallback
            if (!isFallback) {
              const fallback = getFallbackModelConfig();
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
          // Primary model spawn failed — attempt fallback
          if (!isFallback) {
            const fallback = getFallbackModelConfig();
            if (fallback) {
              console.log(
                `[agent-chat] Primary model spawn failed for agent ${agentId}: ${err.message}. Retrying with fallback model "${fallback.model}"...`,
              );
              callbacks.onFallbackStarted?.(fallback.model);
              spawnChatProcess(agentId, conversationId, fullPrompt, attachmentPaths, callbacks, {
                isFallback: true,
                responseParentId,
                targetMessageId,
              });
              return;
            }
          }
          callbacks.onError(`Failed to start CLI: ${err.message}`);
        },
      }).catch((err: unknown) => {
        callbacks.onError((err as Error).message);
      });
    })
    .catch((error: unknown) => {
      callbacks.onError((error as Error).message);
    });
}

/**
 * Returns a copy of the agent config with the model overridden by the global fallback model.
 * Returns null if no fallback model is configured.
 */
function applyFallbackModel(
  agent: NonNullable<Awaited<ReturnType<typeof prepareAgentWorkspaceAccess>>>,
): typeof agent | null {
  const fallback = getFallbackModelConfig();
  if (!fallback) return null;
  return {
    ...agent,
    model: fallback.model,
    modelId: fallback.modelId,
  };
}

export function executePrompt(
  agentId: string,
  prompt: string,
  conversationId: string,
  options: {
    onRunCreated?: (runId: string) => void;
    onFallbackStarted?: (model: string) => void;
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
    const fullPrompt = buildPromptWithHistory(agentId, conversationId, prompt);

    // Save user message
    const userMessage = saveMessage(conversationId, 'outbound', prompt);

    spawnChatProcess(
      agentId,
      conversationId,
      fullPrompt,
      { imagePaths: [], filePaths: [] },
      wrapChatExecuteCallbacks({
        onRunCreated: options.onRunCreated,
        onFallbackStarted: options.onFallbackStarted,
        onDone: resolve,
        onError: (error) => reject(new Error(error)),
      }),
      {
        responseParentId: userMessage.id as string,
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

    const fullPrompt = buildPromptWithHistory(agentId, conversationId, undefined, parentMessageId);
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
  if (hasRunningProcessForTargetMessage(agentId, conversationId, targetMessageId)) {
    return false;
  }
  return getGlobalRunningAgentCount() < getMaxConcurrentAgents();
}

function clearConversationQueue(conversationId: string) {
  store.deleteWhere(
    AGENT_CHAT_QUEUE_COLLECTION,
    (r: Record<string, unknown>) => r.conversationId === conversationId,
  );

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
  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    nextAttemptAt: null,
    errorMessage: null,
    runId: null,
    responseMessageId:
      finalMessage && typeof finalMessage.id === 'string'
        ? finalMessage.id
        : ((finalMessage?.id as string | undefined) ?? null),
  });
}

function markQueueItemCancelledByUser(queueItemId: string, errorMessage = 'Cancelled by user') {
  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    nextAttemptAt: null,
    runId: null,
    errorMessage,
  });
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
}

function recoverInterruptedQueueItemFromRun(queueItem: Record<string, unknown>): boolean {
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
  if (isRunMarkedKilledByUser(runId)) {
    markQueueItemCancelledByUser(queueItemId);
    return true;
  }

  const runStatus = run.status;
  if (runStatus === 'running') return false;

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

function findProcessingQueueItemForRun(
  agentId: string,
  conversationId: string,
  runId: string,
  runStartedAt: number,
): Record<string, unknown> | null {
  const processingItems = store
    .find(
      AGENT_CHAT_QUEUE_COLLECTION,
      (r: Record<string, unknown>) =>
        r.agentId === agentId && r.conversationId === conversationId && r.status === 'processing',
    )
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt),
    );

  if (processingItems.length === 0) return null;

  const exactRunIdMatch = processingItems.find((item) => item.runId === runId);
  if (exactRunIdMatch) return exactRunIdMatch;

  let bestByStart: Record<string, unknown> | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const item of processingItems) {
    const startedAtMs = parseIsoDateMs(item.startedAt);
    if (!Number.isFinite(startedAtMs)) continue;
    const diff = Math.abs(startedAtMs - runStartedAt);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestByStart = item;
    }
  }
  if (bestByStart && bestDiff <= AGENT_CHAT_RECOVERED_QUEUE_MATCH_WINDOW_MS) {
    return bestByStart;
  }

  return null;
}

function finalizeRecoveredQueueItemForRun(
  agentId: string,
  conversationId: string,
  runId: string,
  runStartedAt: number,
  finalMessage: Record<string, unknown> | null,
  fallbackErrorMessage: string,
) {
  const processingItem = findProcessingQueueItemForRun(
    agentId,
    conversationId,
    runId,
    runStartedAt,
  );
  if (!processingItem || typeof processingItem.id !== 'string') return;

  if (isRunMarkedKilledByUser(runId)) {
    markQueueItemCancelledByUser(processingItem.id);
    scheduleQueueDrain(agentId, conversationId, 0);
    return;
  }

  if (finalMessage) {
    markQueueItemCompleted(processingItem.id, finalMessage);
    scheduleQueueDrain(agentId, conversationId, 0);
    return;
  }

  const attemptsUsed = normalizeQueueAttemptCount(processingItem.attempts);
  retryOrFailQueueItem(
    processingItem.id,
    processingItem,
    agentId,
    fallbackErrorMessage,
    attemptsUsed,
  );
  scheduleQueueDrain(agentId, conversationId, 0);
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
    }

    if (!effectiveTargetId) {
      throw AgentChatError.notFound('queue_target_missing', 'Queued message target is missing');
    }

    const onRunCreated = (runId: string) => {
      spawnedRunId = runId;
      store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
        runId,
        lastRunId: runId,
      });
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

  const mode = getQueueItemMode(queueItem);
  if (mode === 'respond_to_message') {
    const targetMessageId =
      typeof queueItem.targetMessageId === 'string'
        ? (queueItem.targetMessageId as string)
        : null;
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
      const queueItems = listConversationQueueItems(agentId, conversationId);
      const now = Date.now();
      const readyItems = queueItems.filter((item) =>
        canStartQueuedItemNow(agentId, conversationId, queueItems, item, now),
      );

      if (readyItems.length === 0) {
        const hasQueuedItems = queueItems.some((item) => item.status === 'queued');
        if (!hasQueuedItems) {
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

      for (const readyItem of readyItems) {
        if (getGlobalRunningAgentCount() >= getMaxConcurrentAgents()) {
          scheduleQueueDrain(agentId, conversationId, 2000);
          return;
        }

        const readyItemId = readyItem.id as string;
        const attempts = Number(readyItem.attempts ?? 0);
        const mode = (readyItem.mode as QueueExecutionMode | undefined) ?? 'append_prompt';
        const prompt = typeof readyItem.prompt === 'string' ? readyItem.prompt.trim() : '';
        const targetMessageId =
          typeof readyItem.targetMessageId === 'string'
            ? (readyItem.targetMessageId as string)
            : null;

        if (mode === 'append_prompt' && !prompt) {
          store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            nextAttemptAt: null,
            runId: null,
            errorMessage: 'Queued prompt is empty',
          });
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

        void processQueueItem(
          readyItemId,
          readyItem,
          agentId,
          conversationId,
          mode,
          prompt,
          targetMessageId,
        ).finally(() => {
          scheduleQueueDrain(agentId, conversationId, 0);
        });
      }
    }
  } finally {
    queueProcessors.delete(key);
  }
}

function pruneChatQueueHistory() {
  const now = Date.now();
  store.deleteWhere(AGENT_CHAT_QUEUE_COLLECTION, (r: Record<string, unknown>) => {
    if (r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled') {
      return false;
    }
    const completedAtMs = parseIsoDateMs(r.completedAt);
    if (!Number.isFinite(completedAtMs)) return false;
    return now - completedAtMs > AGENT_CHAT_QUEUE_RETENTION_MS;
  });
}

export function getAgentQueuedPromptCount(agentId: string, conversationId: string): number {
  return getQueuedAppendPromptCount(agentId, conversationId);
}

export function cancelProcessingQueueItemForRun(
  runId: string,
  errorMessage = 'Cancelled by user',
): boolean {
  const item = store.find(
    AGENT_CHAT_QUEUE_COLLECTION,
    (r: Record<string, unknown>) => r.status === 'processing' && r.runId === runId,
  )[0];
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

export function initializeAgentChatQueue(options: InitializeAgentChatQueueOptions = {}) {
  const { preserveActiveProcessing = false } = options;
  const nowIso = new Date().toISOString();
  const interruptedItems = store.find(
    AGENT_CHAT_QUEUE_COLLECTION,
    (r: Record<string, unknown>) => r.status === 'processing',
  );

  for (const item of interruptedItems) {
    const hasKeys = typeof item.agentId === 'string' && typeof item.conversationId === 'string';
    const shouldPreserve =
      preserveActiveProcessing &&
      hasKeys &&
      isAgentBusy(item.agentId as string, item.conversationId as string);
    if (shouldPreserve) continue;

    const recoveredFromRun = recoverInterruptedQueueItemFromRun(item);
    if (recoveredFromRun) continue;

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

  const pendingItems = store.find(
    AGENT_CHAT_QUEUE_COLLECTION,
    (r: Record<string, unknown>) => r.status === 'queued',
  );
  const keys = new Set<string>();
  for (const item of pendingItems) {
    if (typeof item.agentId !== 'string' || typeof item.conversationId !== 'string') continue;
    keys.add(queueKey(item.agentId, item.conversationId));
  }

  for (const key of keys) {
    const [agentId, conversationId] = key.split(':');
    if (!agentId || !conversationId) continue;
    scheduleQueueDrain(agentId, conversationId, 0);
  }
}

export interface EnqueueAgentPromptResult {
  queueItem: Record<string, unknown>;
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
  } = {},
): EnqueueAgentPromptResult {
  const trimmedPrompt = prompt.trim();
  const mode = options.mode ?? 'append_prompt';
  if (!trimmedPrompt && mode !== 'respond_to_message') {
    throw AgentChatError.badRequest('prompt_required', 'Prompt is required');
  }
  const targetMessageId = options.targetMessageId ?? null;
  const queuedMessageId = options.queuedMessageId ?? null;
  const previousUserMessageId = resolvePreviousUserMessageId(
    conversationId,
    options.previousUserMessageId ?? null,
  );
  if (mode === 'respond_to_message') {
    if (!targetMessageId) {
      throw AgentChatError.badRequest('target_message_required', 'Target message is required');
    }
    const targetMessage = store.getById('messages', targetMessageId);
    if (!targetMessage || targetMessage.conversationId !== conversationId) {
      throw AgentChatError.notFound('target_message_not_found', 'Target message not found');
    }
  }

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
  }

  pruneChatQueueHistory();

  const queueItem = store.insert(AGENT_CHAT_QUEUE_COLLECTION, {
    agentId,
    conversationId,
    mode,
    prompt: trimmedPrompt,
    targetMessageId,
    status: 'queued',
    attempts: 0,
    maxAttempts: AGENT_CHAT_QUEUE_DEFAULT_MAX_ATTEMPTS,
    runId: null,
    lastRunId: null,
    continuationParentId,
    dependsOnQueueItemId,
    previousUserMessageId,
    queuedMessageId,
    responseMessageId: null,
    errorMessage: null,
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
    queuedCount: effectiveCount,
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
  return listConversationQueueItems(agentId, conversationId).map(sanitizeQueueItemForChat);
}

export function updateQueueItem(
  itemId: string,
  agentId: string,
  conversationId: string,
  updates: { prompt?: string },
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

  const patch: Record<string, unknown> = {};
  if (updates.prompt !== undefined) {
    if (item.mode === 'respond_to_message') {
      throw AgentChatError.badRequest(
        'queue_item_prompt_immutable',
        'Branch response items do not support prompt edits',
      );
    }
    const trimmed = updates.prompt.trim();
    if (!trimmed) {
      throw AgentChatError.badRequest('prompt_required', 'Prompt is required');
    }
    patch.prompt = trimmed;
  }
  if (Object.keys(patch).length === 0) return item;

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
  scheduleQueueDrain(agentId, conversationId, 0);
  return updated;
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

  store.delete(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  return true;
}

export function clearAgentConversationQueue(agentId: string, conversationId: string): number {
  const items = getConversationQueueItems(agentId, conversationId);
  const count = items.filter((i) => i.status === 'queued').length;
  clearConversationQueue(conversationId);
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
    store.update(AGENT_CHAT_QUEUE_COLLECTION, orderedIds[i], {
      createdAt: new Date(baseTime + i).toISOString(),
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Execute cron task (cron job trigger)
// ---------------------------------------------------------------------------

export function executeCronTask(agentId: string, job: { id: string; prompt: string }) {
  const key = `${agentId}:cron:${job.id}`;
  if (runningProcesses.has(key)) {
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
    `Use OpenWork API endpoints for all platform state changes. Do not edit platform JSON data files directly (boards.json, cards.json, tasks.json, collections.json, agents.json, users.json, etc.).\n\n` +
    `**Task:** ${job.prompt}\n\n` +
    `Complete this task.`;

  void prepareAgentWorkspaceAccess(agentId)
    .then((agent) => {
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
            if ((code ?? 1) !== 0 && !stdout.trim() && !isFallback) {
              const fallbackAgent = applyFallbackModel(agent);
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
              const fallbackAgent = applyFallbackModel(agent);
              if (fallbackAgent) {
                console.log(
                  `[agent-chat] Cron job ${job.id} primary model spawn failed: ${err.message}. Retrying with fallback model "${fallbackAgent.model}"...`,
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
  if (runningProcesses.has(key)) {
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

  void prepareAgentWorkspaceAccess(agentId)
    .then((agent) => {
      if (!agent) {
        callbacks.onError('Agent not found');
        return;
      }

      let spawnedRunId: string | null = null;

      const spawnCardRun = (effectiveAgent: typeof agent, isFallback: boolean) => {
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
          onExit: ({ code, stdout, stderr, runStartedAt }) => {
            if ((code ?? 1) !== 0 && !stdout.trim() && !isFallback) {
              const fallbackAgent = applyFallbackModel(agent);
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

            if (spawnedRunId && !isRunMarkedKilledByUser(spawnedRunId)) {
              persistCompletedCardAssignmentComment({
                cardId: card.id,
                agentId,
                runId: spawnedRunId,
                runStartedAtMs: runStartedAt,
                stdout,
              });
            }

            callbacks.onDone();
          },
          onSpawnError: (err) => {
            if (!isFallback) {
              const fallbackAgent = applyFallbackModel(agent);
              if (fallbackAgent) {
                console.log(
                  `[agent-chat] Card task ${card.id} primary model spawn failed: ${err.message}. Retrying with fallback model "${fallbackAgent.model}"...`,
                );
                spawnCardRun(fallbackAgent, true);
                return;
              }
            }
            callbacks.onError(`Failed to start CLI: ${err.message}`);
          },
        }).catch((err: unknown) => {
          callbacks.onError((err as Error).message);
        });
      };

      spawnCardRun(agent, false);
    })
    .catch((error: unknown) => {
      callbacks.onError((error as Error).message);
    });
}
