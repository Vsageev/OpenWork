import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { getAgent } from './agents.js';
import { createAgentRun, completeAgentRun } from './agent-runs.js';

const STORAGE_DIR = path.resolve(env.DATA_DIR, 'storage');

const AGENTS_DIR = path.resolve(env.DATA_DIR, 'agents');
export const RUNS_DIR = path.resolve(env.DATA_DIR, 'agent-runs');

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
  'You are a task execution agent. Complete the assigned task and report results. ' +
  'Refer to CHANNELS.MD for response instructions.';

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

/**
 * Extract readable text from Claude CLI's stream-json output format.
 * Falls back to raw stdout if no structured events are found.
 */
function extractStreamJsonText(stdout: string): string {
  const lines = stdout.trim().split('\n');
  // Prefer the final 'result' event which has the full consolidated text
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && typeof event.result === 'string') {
        return event.result;
      }
    } catch {
      // not JSON
    }
  }
  // Fallback: extract text from the last assistant message block
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        const textBlock = (event.message.content as Array<{ type: string; text?: string }>)
          .find((b) => b.type === 'text');
        if (textBlock?.text) return textBlock.text;
      }
    } catch {
      // not JSON
    }
  }
  return stdout.trim();
}

function buildCliCommand(options: BuildCliOptions): CliCommand {
  const { model, modelId, thinkingLevel, prompt, imagePaths } = options;
  const modelLower = model.trim().toLowerCase();
  const sysPrompt = options.systemPrompt ?? CHAT_MODE_SYSTEM_PROMPT;

  if (modelLower.includes('claude')) {
    const args: string[] = [];
    const fullPrompt = appendImagePathsToPrompt(prompt, imagePaths);

    args.push('-p', fullPrompt, '--output-format', 'text', '--append-system-prompt', sysPrompt);

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
    const args = ['--output-format', 'text'];
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

  const trigger = typeof meta.trigger === 'string'
    ? meta.trigger
    : typeof meta.triggerType === 'string'
      ? meta.triggerType
      : null;

  return trigger === 'cron_job' || trigger === 'card_assignment' || trigger === 'cron' || trigger === 'card';
}

function isAgentConversation(r: Record<string, unknown>, agentId: string): boolean {
  if (r.channelType !== 'agent' && r.channelType !== 'other') return false;
  const meta = parseMetadata(r.metadata);
  return meta?.agentId === agentId;
}

/**
 * List all conversations belonging to an agent, sorted by lastMessageAt desc.
 * Lazy-backfills subject from first outbound message for legacy conversations.
 */
export function listAgentConversations(agentId: string, limit = 50, offset = 0) {
  const all = store.find(
    'conversations',
    (r: Record<string, unknown>) =>
      isAgentConversation(r, agentId) && !isBackgroundTriggerConversationRecord(r),
  );

  // Migrate legacy 'other' → 'agent' and backfill subject
  for (const conv of all) {
    let dirty = false;
    if (conv.channelType === 'other') {
      conv.channelType = 'agent';
      dirty = true;
    }
    if (conv.subject === null || conv.subject === undefined) {
      // Backfill from first outbound message
      const firstOut = store
        .find(
          'messages',
          (r: Record<string, unknown>) =>
            r.conversationId === conv.id && r.direction === 'outbound',
        )
        .sort(
          (a: Record<string, unknown>, b: Record<string, unknown>) =>
            new Date(a.createdAt as string).getTime() -
            new Date(b.createdAt as string).getTime(),
        )[0];
      if (firstOut) {
        const text = (firstOut.content as string).slice(0, 60);
        conv.subject = text.length < (firstOut.content as string).length ? text + '...' : text;
        dirty = true;
      }
    }
    if (dirty) {
      store.update('conversations', conv.id as string, {
        channelType: conv.channelType,
        subject: conv.subject,
      });
    }
  }

  const sorted = all.sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt as string).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt as string).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return (
      new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime()
    );
  });

  const entries = sorted.slice(offset, offset + limit).map((conv) => ({
    ...conv,
    isBusy: isAgentBusy(agentId, conv.id as string),
  }));
  return { entries, total: all.length };
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

function autoTitleIfNeeded(conversationId: string, prompt: string) {
  const conv = store.getById('conversations', conversationId);
  if (!conv || conv.subject) return;

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
    'See CHANNELS.MD for how to send progress updates and final answers. ' +
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
  agent: { name: string; model: string; modelId: string | null; thinkingLevel: 'low' | 'medium' | 'high' | null; apiKeyId: string; workspaceApiKey: string | null };
  runKey: string;
  prompt: string;
  systemPrompt: string;
  imagePaths?: string[];
  triggerType: 'chat' | 'cron' | 'card';
  triggerRef?: { conversationId?: string; cardId?: string; cronJobId?: string };
  onStdoutChunk?: (text: string) => void;
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

function processKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
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

function runAgentProcess(options: AgentProcessOptions) {
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
    triggerType: options.triggerType,
    conversationId: options.triggerRef?.conversationId,
    cardId: options.triggerRef?.cardId,
    cronJobId: options.triggerRef?.cronJobId,
  });
  const runId = agentRun.id as string;

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
    return;
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
  const triggerType = run.triggerType as 'chat' | 'cron' | 'card';

  // Reconstruct the run key
  let runKey: string;
  if (triggerType === 'chat' && conversationId) {
    runKey = processKey(agentId, conversationId);
  } else if (triggerType === 'cron' && cronJobId) {
    runKey = `${agentId}:cron:${cronJobId}`;
  } else if (triggerType === 'card' && cardId) {
    runKey = `${agentId}:card:${cardId}`;
  } else {
    runKey = `${agentId}:${runId}`;
  }

  if (runningProcesses.has(runKey)) return;

  const runStartedAt = new Date(run.startedAt as string).getTime();

  const onExit = (result: AgentProcessResult) => {
    // For chat triggers, save the final message to conversation
    if (triggerType === 'chat' && conversationId) {
      const updatesFromApi = listAgentApiUpdates(conversationId, runStartedAt);
      const finalApiMessage = findFinalAgentApiMessage(updatesFromApi);
      // extractStreamJsonText handles both plain text and stream-json output gracefully.
      const stdoutText = extractStreamJsonText(result.stdout);

      if (!finalApiMessage && stdoutText) {
        saveMessage(conversationId, 'inbound', stdoutText);
      } else if (!finalApiMessage && updatesFromApi.length === 0 && !stdoutText) {
        // No output at all — don't save empty message for background re-attach
      }
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
    onStdoutChunk: null, // No SSE client yet
    onExit,
  });

  console.log(`[agent-chat] Re-attached to process PID=${pid} for run ${runId} (${runKey})`);
}

// ---------------------------------------------------------------------------
// subscribeToRunOutput — for SSE reconnection
// ---------------------------------------------------------------------------

export interface RunOutputSubscriber {
  onChunk: (text: string) => void;
  onDone: (message: Record<string, unknown> | null) => void;
  onError: (error: string) => void;
}

export function subscribeToRunOutput(
  agentId: string,
  conversationId: string,
  subscriber: RunOutputSubscriber,
): boolean {
  const key = processKey(agentId, conversationId);
  const handle = runningProcesses.get(key);
  if (!handle) return false;

  // Send catch-up: all existing output from file
  try {
    const existing = fs.readFileSync(handle.stdoutPath, 'utf-8');
    if (existing) {
      subscriber.onChunk(existing);
    }
  } catch {
    // File may not exist
  }

  // Hook into live updates
  const prevOnStdoutChunk = handle.onStdoutChunk;
  handle.onStdoutChunk = (text: string) => {
    prevOnStdoutChunk?.(text);
    subscriber.onChunk(text);
  };

  // Hook into exit
  const prevOnExit = handle.onExit;
  handle.onExit = (result: AgentProcessResult) => {
    prevOnExit?.(result);

    const hasError = (result.code ?? 1) !== 0 && !result.stdout.trim();
    if (hasError) {
      const errMsg = result.stderr.trim() || `Process exited with code ${result.code}`;
      subscriber.onError(errMsg);
    } else {
      // Find the saved message
      const updatesFromApi = listAgentApiUpdates(conversationId, result.runStartedAt);
      const finalApiMessage = findFinalAgentApiMessage(updatesFromApi);

      if (finalApiMessage) {
        subscriber.onDone(finalApiMessage);
      } else if (result.stdout.trim()) {
        // The message was already saved by the onExit handler in reattach or the original spawn
        // Try to find it
        const msgs = store
          .find('messages', (r: Record<string, unknown>) =>
            r.conversationId === conversationId && r.direction === 'inbound',
          )
          .sort(
            (a: Record<string, unknown>, b: Record<string, unknown>) =>
              new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime(),
          );
        subscriber.onDone(msgs[0] ?? null);
      } else if (updatesFromApi.length > 0) {
        subscriber.onDone(updatesFromApi[updatesFromApi.length - 1]);
      } else {
        subscriber.onDone(null);
      }
    }
  };

  return true;
}

// ---------------------------------------------------------------------------
// Execute prompt (chat)
// ---------------------------------------------------------------------------

export interface ExecutePromptCallbacks {
  onChunk: (text: string) => void;
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

  runAgentProcess({
    agentId,
    agent,
    runKey: key,
    prompt: fullPrompt,
    systemPrompt: CHAT_MODE_SYSTEM_PROMPT,
    imagePaths: hasImages ? imagePaths : undefined,
    triggerType: 'chat',
    triggerRef: { conversationId },
    // When using stream-json output (image mode), raw chunks are JSON events — skip forwarding them.
    onStdoutChunk: hasImages ? undefined : (text) => {
      callbacks.onChunk(text);
    },
    onExit: ({ code, stdout, stderr, runStartedAt }) => {
      if ((code ?? 1) !== 0 && !stdout.trim()) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        callbacks.onError(errMsg);
        return;
      }

      const updatesFromApi = listAgentApiUpdates(conversationId, runStartedAt);
      const finalApiMessage = findFinalAgentApiMessage(updatesFromApi);
      // For image mode (stream-json output), extract the text from the JSON events.
      const stdoutText = hasImages ? extractStreamJsonText(stdout) : stdout.trim();

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
  callbacks: ExecutePromptCallbacks,
) {
  const agent = getAgent(agentId);
  if (!agent) {
    callbacks.onError('Agent not found');
    return;
  }

  const key = processKey(agentId, conversationId);
  if (runningProcesses.has(key)) {
    callbacks.onError('Agent is already processing a prompt');
    return;
  }

  // Build prompt with conversation history BEFORE saving, so current message isn't duplicated
  const fullPrompt = buildPromptWithHistory(agentId, conversationId, prompt);

  // Save user message
  saveMessage(conversationId, 'outbound', prompt);

  // Auto-title conversation on first message
  autoTitleIfNeeded(conversationId, prompt);

  spawnChatProcess(agentId, conversationId, fullPrompt, [], callbacks);
}

/**
 * Trigger the agent to respond to the latest message already in the conversation
 * (used after an image upload — the image message is the user's turn, no new text message needed).
 */
export function executeRespondToLastMessage(
  agentId: string,
  conversationId: string,
  callbacks: ExecutePromptCallbacks,
) {
  const agent = getAgent(agentId);
  if (!agent) {
    callbacks.onError('Agent not found');
    return;
  }

  const key = processKey(agentId, conversationId);
  if (runningProcesses.has(key)) {
    callbacks.onError('Agent is already processing a prompt');
    return;
  }

  // Build prompt from history only — the last image message is already the user's turn
  const fullPrompt = buildPromptWithHistory(agentId, conversationId);

  // Extract image disk paths from the most recent image message
  const imagePaths = getConversationImageDiskPaths(conversationId);

  spawnChatProcess(agentId, conversationId, fullPrompt, imagePaths, callbacks);
}

export function isAgentBusy(agentId: string, conversationId: string): boolean {
  return runningProcesses.has(processKey(agentId, conversationId));
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
    `You have been triggered by a scheduled cron job. See CHANNELS.MD for how to respond.\n` +
    `This is a background automation run, not a chat conversation. Do not call /api/agents/:id/chat/messages.\n\n` +
    `**Task:** ${job.prompt}\n\n` +
    `Complete this task.`;

  runAgentProcess({
    agentId,
    agent,

    runKey: key,
    prompt,
    systemPrompt: TASK_MODE_SYSTEM_PROMPT,
    triggerType: 'cron',
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
  callbacks: { onDone: () => void; onError: (err: string) => void },
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
      `You are running a batch task on a card. See CHANNELS.MD for how to respond.\n` +
      `This is a task assignment run, not a chat conversation. Do not call /api/agents/:id/chat/messages.\n\n` +
      `**Card:** ${card.name}\n` +
      `${descriptionLine}\n\n` +
      `**Task:**\n${customPrompt}`
    : `${triggerContext}` +
      `You have been assigned the following card. See CHANNELS.MD for how to respond.\n` +
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
    triggerType: 'card',
    triggerRef: { cardId: card.id },
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
