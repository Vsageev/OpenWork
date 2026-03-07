import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { extractFinalResponseText } from '../lib/agent-output.js';
import { getAgent, listAgents } from './agents.js';
import { createAgentRun, completeAgentRun } from './agent-runs.js';

const STORAGE_DIR = path.resolve(env.DATA_DIR, 'storage');

const AGENTS_DIR = path.resolve(env.DATA_DIR, 'agents');
export const RUNS_DIR = path.resolve(env.DATA_DIR, 'agent-runs');
const AGENT_CHAT_QUEUE_COLLECTION = 'agentChatQueue';
const AGENT_CHAT_QUEUE_RETRY_BASE_MS = 1000;
const AGENT_CHAT_QUEUE_RETRY_MAX_MS = 30000;
const AGENT_CHAT_QUEUE_DEFAULT_MAX_ATTEMPTS = 4;
const AGENT_CHAT_QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
const AGENT_CHAT_RECOVERED_QUEUE_MATCH_WINDOW_MS = 5 * 60 * 1000;

interface QueueDrainTimer {
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
}

// ---------------------------------------------------------------------------
// CLI command builders
// ---------------------------------------------------------------------------

interface CliCommand {
  bin: string;
  args: string[];
  stdinData?: string;
}

const CHAT_MODE_SYSTEM_PROMPT =
  'You are a general-purpose assistant in a direct user chat. ' +
  'Non-coding requests are valid and should be handled directly when possible. ' +
  'Do not claim you are only a software engineering assistant. ' +
  'If a request cannot be fully completed due to tool or permission limits, explain the limitation briefly and provide the best actionable alternative.';

const TASK_MODE_SYSTEM_PROMPT =
  'You are a task execution agent. Complete the assigned task and report results.';

interface BuildCliOptions {
  model: string;
  modelId?: string | null;
  thinkingLevel?: 'low' | 'medium' | 'high' | null;
  prompt: string;
  systemPrompt?: string;
  imagePaths?: string[];
}

function appendImagePathsToPrompt(prompt: string, imagePaths?: string[]): string {
  if (!imagePaths || imagePaths.length === 0) return prompt;
  const pathList = imagePaths.map((p) => `- ${p}`).join('\n');
  return `${prompt ? prompt + '\n\n' : ''}Image files:\n${pathList}`;
}

function buildCliCommand(options: BuildCliOptions): CliCommand {
  const { model, modelId, thinkingLevel, prompt, imagePaths } = options;
  const modelLower = model.trim().toLowerCase();
  const sysPrompt = options.systemPrompt ?? CHAT_MODE_SYSTEM_PROMPT;

  if (modelLower.includes('claude')) {
    const args: string[] = [];
    const fullPrompt = appendImagePathsToPrompt(prompt, imagePaths);

    // Stream structured events so run logs contain full model output, not only final text.
    args.push(
      '-p',
      fullPrompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--append-system-prompt',
      sysPrompt,
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
    args.push('--', appendImagePathsToPrompt(prompt, imagePaths));
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
    args.push('--prompt', appendImagePathsToPrompt(prompt, imagePaths));
    return { bin: 'qwen', args };
  }

  // Fallback: treat model name as CLI binary with claude-like flags
  const args = ['-p', appendImagePathsToPrompt(prompt, imagePaths), '--output-format', 'text'];
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
    return (
      new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime()
    );
  });

  const entries = sorted.slice(offset, offset + limit).map((conv) => {
    const conversationId = conv.id as string;
    const busy = isAgentBusy(agentId, conversationId);
    const rawQueuedCount = getPendingQueueCount(agentId, conversationId);
    // If agent is not busy, the first queued item will be picked up immediately
    // by the drain timer, so don't count it as "queued behind".
    const queuedCount = busy ? rawQueuedCount : Math.max(0, rawQueuedCount - 1);
    const isBusy = busy || rawQueuedCount > 0;
    return {
      ...conv,
      isBusy,
      queuedCount,
    };
  });
  return { entries, total: all.length };
}

/**
 * List recent agent chat conversations across ALL agents, sorted by lastMessageAt desc.
 * Returns agent metadata alongside each conversation.
 */
export function listRecentAgentConversations(limit = 10) {
  const agents = listAgents();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const all = store.find(
    'conversations',
    (r: Record<string, unknown>) => {
      if (r.channelType !== 'agent') return false;
      if (isBackgroundTriggerConversationRecord(r)) return false;
      const meta = parseMetadata(r.metadata);
      return !!meta?.agentId && agentMap.has(meta.agentId as string);
    },
  );

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
  store.deleteWhere('messages', (r: Record<string, unknown>) => r.conversationId === conversationId);
  store.deleteWhere('messageDrafts', (r: Record<string, unknown>) => r.conversationId === conversationId);
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
// Save messages
// ---------------------------------------------------------------------------

type AgentConversationMessageType = 'text' | 'system';

interface SaveAgentMessageParams {
  conversationId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  type?: AgentConversationMessageType | 'image';
  metadata?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
}

export function saveAgentConversationMessage(params: SaveAgentMessageParams) {
  const metadata = params.metadata ? JSON.stringify(params.metadata) : null;
  const msg = store.insert('messages', {
    conversationId: params.conversationId,
    direction: params.direction,
    type: params.type ?? 'text',
    content: params.content,
    status: params.direction === 'outbound' ? 'sent' : 'delivered',
    attachments: params.attachments ?? null,
    metadata,
  });

  const markUnread = params.direction === 'inbound' && params.type !== 'system';
  store.update('conversations', params.conversationId, {
    lastMessageAt: new Date().toISOString(),
    isUnread: markUnread,
  });

  if (params.direction === 'outbound') {
    autoTitleIfNeeded(
      params.conversationId,
      buildAutoTitleFromMessage(params.content, params.type ?? 'text', params.attachments),
    );
  }

  return msg;
}

function saveMessage(
  conversationId: string,
  direction: 'inbound' | 'outbound',
  content: string,
) {
  return saveAgentConversationMessage({
    conversationId,
    direction,
    content,
    type: 'text',
    metadata: null,
  });
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

  if (type !== 'image') {
    return null;
  }

  const parsedAttachments = parseAttachments(attachments);
  const imageNames = parsedAttachments
    .filter((attachment) => attachment.type === 'image' && typeof attachment.fileName === 'string')
    .map((attachment) => attachment.fileName as string);

  if (imageNames.length === 1) {
    return `Image: ${imageNames[0]}`;
  }
  if (imageNames.length > 1) {
    return `Images: ${imageNames.slice(0, 2).join(', ')}${imageNames.length > 2 ? ', ...' : ''}`;
  }

  return 'Image upload';
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
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function storageDiskPath(storagePath: string): string {
  return path.resolve(STORAGE_DIR, '.' + storagePath);
}

/** Returns disk paths for image files in the most recent image message of the conversation. */
function getConversationImageDiskPaths(conversationId: string): string[] {
  const imageMsgs = store
    .find(
      'messages',
      (r: Record<string, unknown>) => r.conversationId === conversationId && r.type === 'image',
    )
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime(),
    );

  if (imageMsgs.length === 0) return [];

  const latest = imageMsgs[0];
  const attachments = parseAttachments(latest.attachments);
  const paths: string[] = [];
  for (const att of attachments) {
    if (att.type === 'image' && typeof att.storagePath === 'string') {
      const diskPath = storageDiskPath(att.storagePath);
      if (fs.existsSync(diskPath)) {
        paths.push(diskPath);
      }
    }
  }
  return paths;
}

function formatMessageForPrompt(msg: Record<string, unknown>): string {
  const role = msg.direction === 'outbound' ? 'User' : 'Assistant';
  const content = (msg.content as string) || '';

  if (msg.type === 'image') {
    const attachments = parseAttachments(msg.attachments);
    const imageNames = attachments
      .filter((a) => a.type === 'image' && typeof a.fileName === 'string')
      .map((a) => a.fileName as string);
    const imageLabel = imageNames.length > 0
      ? `[Image: ${imageNames.join(', ')}]`
      : '[Image]';
    return content ? `${role}: ${imageLabel}\n${content}` : `${role}: ${imageLabel}`;
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
): string {
  const history = store
    .find('messages', (r: Record<string, unknown>) => r.conversationId === conversationId)
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime(),
    );

  const triggerContext = buildTriggerContext('chat', { agentId, conversationId });

  const promptPreamble =
    'You are in a direct chat with a user. Respond to the latest User message clearly and directly. ' +
    'Non-coding requests are valid and should be handled directly when possible. ' +
    'Do not ask project-setup questions unless the user explicitly asks for coding/project help. ' +
    `You have workspace API access via $WORKSPACE_API_URL and $WORKSPACE_API_KEY env vars. ` +
    `Do not use /api/messages for this chat thread. ` +
    'See CLAUDE.MD for endpoint examples.';

  if (history.length === 0 && currentPrompt) {
    return `${triggerContext}${promptPreamble}\n\nUser: ${currentPrompt}`;
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

  return `${triggerContext}${promptPreamble}\n\nContinue the conversation below. Only respond to the latest User message.\n\n${lines.join('\n\n')}`;
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
  systemPrompt: string;
  imagePaths?: string[];
  triggerType: TriggerType;
  triggerRef?: { conversationId?: string; cardId?: string; cronJobId?: string };
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

function buildChildEnv(agent: { apiKeyId: string; workspaceApiKey: string | null }): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...process.env };

  // Prevent "nested session" errors when the backend itself runs inside Claude Code
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
  return [...messages].reverse().find((msg) => parseMetadata(msg.metadata)?.isFinal === true) ?? null;
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
): Record<string, unknown> | null {
  const inboundMessages = listConversationInboundMessages(conversationId, runStartedAt);
  if (inboundMessages.length === 0) return null;

  if (expectedContent && expectedContent.trim().length > 0) {
    const contentMatch = [...inboundMessages].reverse().find((msg) => {
      if (msg.type !== 'text') return false;
      return ((msg.content as string) || '').trim() === expectedContent.trim();
    });
    if (contentMatch) return contentMatch;
  }

  return (
    [...inboundMessages].reverse().find((msg) => {
      if (msg.type !== 'text') return false;
      const meta = parseMetadata(msg.metadata);
      return !(meta?.agentChatUpdate === true && meta?.isFinal === false);
    }) ?? null
  );
}

function resolveFinalMessageForCompletedRun(
  conversationId: string,
  runStartedAt: number,
  rawStdout: string,
): Record<string, unknown> | null {
  const updatesFromApi = listAgentApiUpdates(conversationId, runStartedAt);
  const finalApiMessage = findFinalAgentApiMessage(updatesFromApi);
  if (finalApiMessage) return finalApiMessage;

  const stdoutText = extractFinalResponseText(rawStdout);
  const existingFinal = findExistingFinalMessageFromRun(conversationId, runStartedAt, stdoutText || null);
  if (existingFinal) return existingFinal;

  if (stdoutText) {
    return saveMessage(conversationId, 'inbound', stdoutText);
  }
  if (updatesFromApi.length > 0) {
    return updatesFromApi[updatesFromApi.length - 1];
  }
  return null;
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
}

// Track running processes per run key so parallel chats/tasks can run.
const runningProcesses = new Map<string, RunHandle>();
const queueProcessors = new Set<string>();
const queueDrainTimers = new Map<string, QueueDrainTimer>();

function processKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
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

function listConversationQueueItems(agentId: string, conversationId: string): Record<string, unknown>[] {
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

function getPendingQueueCount(agentId: string, conversationId: string): number {
  return store.count(
    AGENT_CHAT_QUEUE_COLLECTION,
    (r: Record<string, unknown>) =>
      r.agentId === agentId &&
      r.conversationId === conversationId &&
      r.status === 'queued',
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
  const {
    runId, runKey, pid, stdoutPath, stderrPath,
    runStartedAt, agentId,
  } = options;

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
    runningProcesses.delete(runKey);

    // Read final output
    let stdout = '';
    let stderr = '';
    try { stdout = fs.readFileSync(stdoutPath, 'utf-8'); } catch { /* */ }
    try { stderr = fs.readFileSync(stderrPath, 'utf-8'); } catch { /* */ }

    markAgentLastActivity(agentId);
    const hasError = !stdout.trim();
    const errorMsg = hasError ? (stderr.trim() || 'Process exited') : null;
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
  };

  runningProcesses.set(runKey, handle);
  return handle;
}

// ---------------------------------------------------------------------------
// runAgentProcess — spawns detached, writes to files
// ---------------------------------------------------------------------------

function runAgentProcess(options: AgentProcessOptions): string {
  const workDir = path.join(AGENTS_DIR, options.agentId);
  const { bin, args, stdinData } = buildCliCommand({
    model: options.agent.model,
    modelId: options.agent.modelId,
    thinkingLevel: options.agent.thinkingLevel,
    prompt: options.prompt,
    systemPrompt: options.systemPrompt,
    imagePaths: options.imagePaths,
  });
  const childEnv = buildChildEnv(options.agent);

  // Record the agent run first to get runId for log directory
  const agentRun = createAgentRun({
    agentId: options.agentId,
    agentName: options.agent.name,
    avatarIcon: options.agent.avatarIcon ?? null,
    avatarBgColor: options.agent.avatarBgColor ?? null,
    avatarLogoColor: options.agent.avatarLogoColor ?? null,
    triggerType: options.triggerType,
    conversationId: options.triggerRef?.conversationId,
    cardId: options.triggerRef?.cardId,
    cronJobId: options.triggerRef?.cronJobId,
    triggerPrompt: options.prompt,
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
    child = spawn(bin, args, {
      cwd: workDir,
      env: childEnv,
      detached: true,
      stdio: [stdinData ? 'pipe' : 'ignore', stdoutFd, stderrFd],
    });
  } catch (err) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
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
      runningProcesses.delete(options.runKey);
    }
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

  // Reconstruct the run key
  let runKey: string;
  if (triggerType === 'chat' && conversationId) {
    runKey = processKey(agentId, conversationId);
  } else if (triggerType === 'cron_job' && cronJobId) {
    runKey = `${agentId}:cron:${cronJobId}`;
  } else if (triggerType === 'card_assignment' && cardId) {
    runKey = `${agentId}:card:${cardId}`;
  } else {
    runKey = `${agentId}:${runId}`;
  }

  if (runningProcesses.has(runKey)) return;

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
        finalMessage = finalApiMessage;
      } else if (stdoutText) {
        finalMessage = saveMessage(conversationId, 'inbound', stdoutText);
      } else if (updatesFromApi.length > 0) {
        finalMessage = updatesFromApi[updatesFromApi.length - 1];
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

// ---------------------------------------------------------------------------
// Execute prompt (chat)
// ---------------------------------------------------------------------------

export interface ExecutePromptCallbacks {
  onRunCreated?: (runId: string) => void;
  onDone: (message: Record<string, unknown>) => void;
  onError: (error: string) => void;
}

function spawnChatProcess(
  agentId: string,
  conversationId: string,
  fullPrompt: string,
  imagePaths: string[],
  callbacks: ExecutePromptCallbacks,
) {
  const agent = getAgent(agentId);
  if (!agent) {
    callbacks.onError('Agent not found');
    return;
  }

  const key = processKey(agentId, conversationId);
  const hasImages = imagePaths.length > 0;
  let spawnedRunId: string | null = null;

  runAgentProcess({
    agentId,
    agent,
    runKey: key,
    prompt: fullPrompt,
    systemPrompt: CHAT_MODE_SYSTEM_PROMPT,
    imagePaths: hasImages ? imagePaths : undefined,
    triggerType: 'chat',
    triggerRef: { conversationId },
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
        msg = finalApiMessage;
      } else if (stdoutText) {
        msg = saveMessage(conversationId, 'inbound', stdoutText);
      } else if (updatesFromApi.length > 0) {
        msg = updatesFromApi[updatesFromApi.length - 1];
      } else {
        msg = saveMessage(conversationId, 'inbound', '(empty response)');
      }

      callbacks.onDone(msg);
    },
    onSpawnError: (err) => {
      callbacks.onError(`Failed to start CLI: ${err.message}`);
    },
  });
}

export function executePrompt(
  agentId: string,
  prompt: string,
  conversationId: string,
  options: { onRunCreated?: (runId: string) => void } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(agentId);
    if (!agent) {
      reject(new Error('Agent not found'));
      return;
    }

    const key = processKey(agentId, conversationId);
    if (runningProcesses.has(key)) {
      reject(new Error('Agent is already processing a prompt'));
      return;
    }

    // Build prompt with conversation history BEFORE saving, so current message isn't duplicated
    const fullPrompt = buildPromptWithHistory(agentId, conversationId, prompt);

    // Save user message
    saveMessage(conversationId, 'outbound', prompt);

    spawnChatProcess(agentId, conversationId, fullPrompt, [], {
      onRunCreated: options.onRunCreated,
      onDone: resolve,
      onError: (error) => reject(new Error(error)),
    });
  });
}

/**
 * Trigger the agent to respond to the latest message already in the conversation
 * (used after an image upload — the image message is the user's turn, no new text message needed).
 */
export function executeRespondToLastMessage(
  agentId: string,
  conversationId: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(agentId);
    if (!agent) {
      reject(new Error('Agent not found'));
      return;
    }

    const key = processKey(agentId, conversationId);
    if (runningProcesses.has(key)) {
      reject(new Error('Agent is already processing a prompt'));
      return;
    }

    // Build prompt from history only — the last image message is already the user's turn
    const fullPrompt = buildPromptWithHistory(agentId, conversationId);

    // Extract image disk paths from the most recent image message
    const imagePaths = getConversationImageDiskPaths(conversationId);

    spawnChatProcess(agentId, conversationId, fullPrompt, imagePaths, {
      onDone: resolve,
      onError: (error) => reject(new Error(error)),
    });
  });
}

export function isAgentBusy(agentId: string, conversationId: string): boolean {
  return runningProcesses.has(processKey(agentId, conversationId));
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

function markQueueItemCompleted(
  queueItemId: string,
  finalMessage: Record<string, unknown> | null,
) {
  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    nextAttemptAt: null,
    errorMessage: null,
    runId: null,
    responseMessageId:
      finalMessage && typeof finalMessage.id === 'string'
        ? finalMessage.id
        : (finalMessage?.id as string | undefined) ?? null,
  });
}

function markQueueItemCancelledByUser(
  queueItemId: string,
  errorMessage = 'Cancelled by user',
) {
  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'failed',
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
  conversationId: string,
  errorMessage: string,
  attemptsUsed: number,
) {
  const maxAttempts = normalizeQueueMaxAttempts(queueItem.maxAttempts);
  if (attemptsUsed < maxAttempts) {
    const retryDelayMs = getQueueItemRetryDelayMs(attemptsUsed);
    store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
      status: 'queued',
      completedAt: null,
      errorMessage,
      runId: null,
      nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString(),
    });
    return;
  }

  store.update(AGENT_CHAT_QUEUE_COLLECTION, queueItemId, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    nextAttemptAt: null,
    runId: null,
    errorMessage,
  });
  saveAgentConversationMessage({
    conversationId,
    direction: 'inbound',
    type: 'system',
    content: `Queued message failed after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}: ${errorMessage}`,
    metadata: {
      agentChatUpdate: true,
      isFinal: true,
      queuedFailure: true,
    },
  });
}

function recoverInterruptedQueueItemFromRun(
  queueItem: Record<string, unknown>,
): boolean {
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
    const finalMessage = resolveFinalMessageForCompletedRun(conversationId, runStartedAt, rawStdout);

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
  retryOrFailQueueItem(
    queueItemId,
    queueItem,
    agentId,
    conversationId,
    errorMessage,
    attemptsUsed,
  );
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
        r.agentId === agentId &&
        r.conversationId === conversationId &&
        r.status === 'processing',
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
  const processingItem = findProcessingQueueItemForRun(agentId, conversationId, runId, runStartedAt);
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
    conversationId,
    fallbackErrorMessage,
    attemptsUsed,
  );
  scheduleQueueDrain(agentId, conversationId, 0);
}

async function drainConversationQueue(agentId: string, conversationId: string): Promise<void> {
  const key = queueKey(agentId, conversationId);
  if (queueProcessors.has(key)) return;

  queueProcessors.add(key);
  try {
    while (true) {
      const queueItems = listConversationQueueItems(agentId, conversationId);
      const readyItem = queueItems.find((item) => {
        if (item.status !== 'queued') return false;
        const nextAttemptAtMs = parseIsoDateMs(item.nextAttemptAt);
        return !Number.isFinite(nextAttemptAtMs) || nextAttemptAtMs <= Date.now();
      });

      if (!readyItem) {
        const nextDelayMs = getNextQueueReadyDelay(agentId, conversationId);
        if (nextDelayMs !== null) {
          scheduleQueueDrain(agentId, conversationId, nextDelayMs);
        } else {
          clearQueueDrainTimerForKey(key);
        }
        return;
      }

      if (isAgentBusy(agentId, conversationId)) {
        scheduleQueueDrain(agentId, conversationId, 1000);
        return;
      }

      const readyItemId = readyItem.id as string;
      const attempts = Number(readyItem.attempts ?? 0);
      const prompt = typeof readyItem.prompt === 'string' ? readyItem.prompt.trim() : '';
      if (!prompt) {
        store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          nextAttemptAt: null,
          runId: null,
          errorMessage: 'Queued prompt is empty',
        });
        continue;
      }
      store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, {
        status: 'processing',
        attempts: attempts + 1,
        startedAt: new Date().toISOString(),
        runId: null,
        errorMessage: null,
      });

      let spawnedRunId: string | null = null;
      try {
        const finalMessage = await executePrompt(agentId, prompt, conversationId, {
          onRunCreated: (runId) => {
            spawnedRunId = runId;
            store.update(AGENT_CHAT_QUEUE_COLLECTION, readyItemId, { runId });
          },
        });
        const latestItem = store.getById(AGENT_CHAT_QUEUE_COLLECTION, readyItemId);
        if (!latestItem || latestItem.status !== 'processing') {
          scheduleQueueDrain(agentId, conversationId, 0);
          continue;
        }
        markQueueItemCompleted(readyItemId, finalMessage);
      } catch (err) {
        const latestItem = store.getById(AGENT_CHAT_QUEUE_COLLECTION, readyItemId);
        if (!latestItem || latestItem.status !== 'processing') {
          scheduleQueueDrain(agentId, conversationId, 0);
          continue;
        }

        const activeRunId =
          typeof latestItem.runId === 'string' && latestItem.runId
            ? latestItem.runId
            : spawnedRunId;
        if (isRunMarkedKilledByUser(activeRunId)) {
          markQueueItemCancelledByUser(readyItemId);
          scheduleQueueDrain(agentId, conversationId, 0);
          continue;
        }

        const errorMessage =
          err instanceof Error ? err.message : 'Failed to process queued chat message';
        const attemptsUsed = normalizeQueueAttemptCount(latestItem.attempts);
        retryOrFailQueueItem(
          readyItemId,
          latestItem,
          agentId,
          conversationId,
          errorMessage,
          attemptsUsed,
        );
      }
    }
  } finally {
    queueProcessors.delete(key);
  }
}

function pruneChatQueueHistory() {
  const now = Date.now();
  store.deleteWhere(AGENT_CHAT_QUEUE_COLLECTION, (r: Record<string, unknown>) => {
    if (r.status !== 'completed' && r.status !== 'failed') return false;
    const completedAtMs = parseIsoDateMs(r.completedAt);
    if (!Number.isFinite(completedAtMs)) return false;
    return now - completedAtMs > AGENT_CHAT_QUEUE_RETENTION_MS;
  });
}

export function getAgentQueuedPromptCount(agentId: string, conversationId: string): number {
  return getPendingQueueCount(agentId, conversationId);
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
): EnqueueAgentPromptResult {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('Prompt is required');
  }

  pruneChatQueueHistory();

  const queueItem = store.insert(AGENT_CHAT_QUEUE_COLLECTION, {
    agentId,
    conversationId,
    prompt: trimmedPrompt,
    status: 'queued',
    attempts: 0,
    maxAttempts: AGENT_CHAT_QUEUE_DEFAULT_MAX_ATTEMPTS,
    runId: null,
    queuedMessageId: null,
    responseMessageId: null,
    errorMessage: null,
    nextAttemptAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  });

  scheduleQueueDrain(agentId, conversationId, 0);

  // If the agent is not currently busy, the just-enqueued item will be picked
  // up immediately by the drain timer, so it shouldn't count as "queued behind".
  const rawCount = getPendingQueueCount(agentId, conversationId);
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

export function updateQueueItem(
  itemId: string,
  agentId: string,
  conversationId: string,
  updates: { prompt?: string },
): Record<string, unknown> | null {
  const item = store.getById(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  if (!item) return null;
  if (item.agentId !== agentId || item.conversationId !== conversationId) return null;
  if (item.status !== 'queued') return null;

  const patch: Record<string, unknown> = {};
  if (updates.prompt !== undefined) {
    const trimmed = updates.prompt.trim();
    if (!trimmed) return null;
    patch.prompt = trimmed;
  }
  if (Object.keys(patch).length === 0) return item;

  return store.update(AGENT_CHAT_QUEUE_COLLECTION, itemId, patch);
}

export function deleteQueueItem(
  itemId: string,
  agentId: string,
  conversationId: string,
): boolean {
  const item = store.getById(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  if (!item) return false;
  if (item.agentId !== agentId || item.conversationId !== conversationId) return false;
  if (item.status !== 'queued') return false;

  store.delete(AGENT_CHAT_QUEUE_COLLECTION, itemId);
  return true;
}

export function clearAgentConversationQueue(
  agentId: string,
  conversationId: string,
): number {
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
    if (!itemMap.has(id)) return false;
  }
  if (orderedIds.length !== items.length) return false;

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

export function executeCronTask(
  agentId: string,
  job: { id: string; prompt: string },
) {
  const agent = getAgent(agentId);
  if (!agent) return;

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
    `This is a background automation run, not a chat conversation. Do not call /api/agents/:id/chat/messages.\n\n` +
    `**Task:** ${job.prompt}\n\n` +
    `Complete this task.`;

  runAgentProcess({
    agentId,
    agent,

    runKey: key,
    prompt,
    systemPrompt: TASK_MODE_SYSTEM_PROMPT,
    triggerType: 'cron_job',
    triggerRef: { cronJobId: job.id },
    onExit: ({ code, stderr }) => {
      if ((code ?? 1) !== 0) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        console.error(`Agent cron task error for job ${job.id}:`, errMsg);
      }
    },
    onSpawnError: (err) => {
      console.error(`Agent cron task failed to start for job ${job.id}:`, err.message);
    },
  });
}

// ---------------------------------------------------------------------------
// Execute card task (card assignment trigger)
// ---------------------------------------------------------------------------

export function executeCardTask(
  agentId: string,
  card: { id: string; name: string; description: string | null; collectionId: string },
  callbacks: { onDone: () => void; onError: (err: string) => void; onRunCreated?: (runId: string) => void },
  customPrompt?: string,
) {
  const agent = getAgent(agentId);
  if (!agent) {
    callbacks.onError('Agent not found');
    return;
  }

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
      `You are running a batch task on a card.\n` +
      `This is a task assignment run, not a chat conversation. Do not call /api/agents/:id/chat/messages.\n\n` +
      `**Card:** ${card.name}\n` +
      `${descriptionLine}\n\n` +
      `**Task:**\n${customPrompt}`
    : `${triggerContext}` +
      `You have been assigned the following card.\n` +
      `This is a task assignment run, not a chat conversation. Do not call /api/agents/:id/chat/messages.\n\n` +
      `**Card:** ${card.name}\n` +
      `${descriptionLine}\n\n` +
      `Complete this task.`;

  runAgentProcess({
    agentId,
    agent,

    runKey: key,
    prompt,
    systemPrompt: TASK_MODE_SYSTEM_PROMPT,
    triggerType: 'card_assignment',
    triggerRef: { cardId: card.id },
    onRunCreated: callbacks.onRunCreated,
    onExit: ({ code, stderr }) => {
      if ((code ?? 1) !== 0) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        callbacks.onError(errMsg);
        return;
      }

      callbacks.onDone();
    },
    onSpawnError: (err) => {
      callbacks.onError(`Failed to start CLI: ${err.message}`);
    },
  });
}
