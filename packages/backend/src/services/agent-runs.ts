import fs from 'node:fs';
import path from 'node:path';
import { store } from '../db/index.js';
import type { StoreRecord } from '../db/store.js';
import {
  findAgentRunIdsForRetentionCleanup,
  findAgentRunsByListFilterPaged,
  findAgentRunsWithLegacyTriggerTypes,
  findRunningAgentRunsAsync,
} from '../db/repositories/agent-execution-repository.js';
import { env } from '../config/env.js';
import {
  DEFAULT_AGENT_RUN_ERROR_MESSAGE,
  extractAgentOutputErrorText,
  extractAgentOutputIncompleteText,
  extractFinalResponseText,
  formatAgentRunErrorMessage,
} from '../lib/agent-output.js';
import { cancelRemoteAgentRun, isRemoteAgentRunPending } from './agent-runners.js';
import {
  markAgentChatTurnCompleted,
  markAgentChatTurnFailed,
  markAgentChatTurnStopped,
} from './agent-chat-turns.js';

type TriggerType = 'chat' | 'cron_job' | 'card_assignment';
type RunStatus = 'queued' | 'running' | 'completed' | 'error';
type LegacyTriggerType = 'cron' | 'card';

const RUNS_DIR = path.resolve(env.DATA_DIR, 'agent-runs');
const LOG_RETENTION_DAYS = 7;
const MAX_CARD_AUTO_COMMENT_LENGTH = 5000;
const CARD_COMMENT_TERMINAL_STATUSES = new Set<RunStatus>(['completed', 'error']);

interface CreateAgentRunParams {
  id?: string;
  agentId: string;
  agentName: string;
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
  model?: string | null;
  modelId?: string | null;
  triggerType: TriggerType;
  conversationId?: string | null;
  cardId?: string | null;
  cronJobId?: string | null;
  executor?: 'local' | 'remote';
  pid?: number | null;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  triggerPrompt?: string | null;
  responseParentId?: string | null;
  turnId?: string | null;
  status?: Extract<RunStatus, 'queued' | 'running'>;
}

export interface AgentRunLifecycleEvent {
  at: string;
  event: string;
  message?: string;
  runnerId?: string;
  jobId?: string;
  pid?: number | null;
  code?: number | null;
  signal?: string | null;
  stdoutBytes?: number;
  stderrBytes?: number;
}

const MAX_RUN_LIFECYCLE_EVENTS = 80;

function parseRunLifecycle(run: Record<string, unknown>): AgentRunLifecycleEvent[] {
  const lifecycle = run.runnerLifecycle;
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) return [];
  const events = (lifecycle as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  return events.filter((event): event is AgentRunLifecycleEvent =>
    Boolean(event && typeof event === 'object' && typeof (event as Record<string, unknown>).event === 'string'),
  );
}

export function appendAgentRunLifecycleEvent(
  runId: string,
  event: Omit<AgentRunLifecycleEvent, 'at'> & { at?: string },
): Record<string, unknown> | null {
  const run = store.getById('agent_runs', runId);
  if (!run) return null;
  const nextEvent: AgentRunLifecycleEvent = {
    ...event,
    at: event.at ?? new Date().toISOString(),
  };
  const events = [...parseRunLifecycle(run), nextEvent].slice(-MAX_RUN_LIFECYCLE_EVENTS);
  return store.update('agent_runs', runId, {
    runnerLifecycle: {
      events,
      lastEvent: nextEvent.event,
      lastEventAt: nextEvent.at,
    },
  });
}

export function createAgentRun(params: CreateAgentRunParams): Record<string, unknown> {
  const now = new Date().toISOString();
  return store.insert('agent_runs', {
    ...(params.id ? { id: params.id } : {}),
    agentId: params.agentId,
    agentName: params.agentName,
    avatarIcon: params.avatarIcon ?? null,
    avatarBgColor: params.avatarBgColor ?? null,
    avatarLogoColor: params.avatarLogoColor ?? null,
    model: params.model ?? null,
    modelId: params.modelId ?? null,
    triggerType: params.triggerType,
    status: params.status ?? ('running' as RunStatus),
    conversationId: params.conversationId ?? null,
    cardId: params.cardId ?? null,
    cronJobId: params.cronJobId ?? null,
    executor: params.executor ?? 'remote',
    pid: params.pid ?? null,
    stdoutPath: params.stdoutPath ?? null,
    stderrPath: params.stderrPath ?? null,
    triggerPrompt: params.triggerPrompt ?? null,
    responseParentId: params.responseParentId ?? null,
    turnId: params.turnId ?? null,
    errorMessage: null,
    responseText: null,
    runnerLifecycle: {
      events: [
        {
          at: now,
          event: 'run_record_created',
          message: `Agent run record created with status ${params.status ?? 'running'}`,
        },
      ],
      lastEvent: 'run_record_created',
      lastEventAt: now,
    },
    startedAt: now,
    finishedAt: null,
    durationMs: null,
  });
}

function buildAgentRunCompletionPatch(
  run: Record<string, unknown>,
  errorMessage: string | null,
  logs?: { stdout?: string; stderr?: string },
): Record<string, unknown> {
  const startedAt = new Date(run.startedAt as string).getTime();
  const now = Date.now();
  const durationMs = now - startedAt;

  let stdout = logs?.stdout ?? null;
  let stderr = logs?.stderr ?? null;

  if (stdout === null && run.stdoutPath) {
    try {
      stdout = fs.readFileSync(run.stdoutPath as string, 'utf-8');
    } catch {
      // File may not exist if process never wrote output
    }
  }
  if (stderr === null && run.stderrPath) {
    try {
      stderr = fs.readFileSync(run.stderrPath as string, 'utf-8');
    } catch {
      // File may not exist
    }
  }

  const finalStdout = stdout ?? (run.stdout as string | null) ?? null;
  const finalStderr = stderr ?? (run.stderr as string | null) ?? null;
  if (logs?.stdout !== undefined && typeof run.stdoutPath === 'string' && run.stdoutPath) {
    try {
      fs.mkdirSync(path.dirname(run.stdoutPath), { recursive: true });
      fs.writeFileSync(run.stdoutPath, logs.stdout);
    } catch {
      // Keep the DB snapshot even if the file cache cannot be refreshed.
    }
  }
  if (logs?.stderr !== undefined && typeof run.stderrPath === 'string' && run.stderrPath) {
    try {
      fs.mkdirSync(path.dirname(run.stderrPath), { recursive: true });
      fs.writeFileSync(run.stderrPath, logs.stderr);
    } catch {
      // Keep the DB snapshot even if the file cache cannot be refreshed.
    }
  }
  const previousResponseText =
    typeof run.responseText === 'string' ? run.responseText : null;
  let extractionErrorMessage: string | null = null;
  let structuredErrorMessage = '';
  let incompleteOutputMessage = '';
  let responseText = '';
  try {
    structuredErrorMessage = finalStdout ? extractAgentOutputErrorText(finalStdout) : '';
    incompleteOutputMessage = finalStdout ? extractAgentOutputIncompleteText(finalStdout) : '';
    const displayErrorMessage = formatAgentRunErrorMessage(
      structuredErrorMessage || errorMessage || incompleteOutputMessage || null,
    );
    responseText =
      !displayErrorMessage && finalStdout ? extractFinalResponseText(finalStdout) : '';
    const missingFinalResponseMessage =
      !displayErrorMessage && !responseText
        ? 'Agent run completed without a final response.'
        : null;
    return {
      status: (displayErrorMessage || missingFinalResponseMessage ? 'error' : 'completed') as RunStatus,
      errorMessage: displayErrorMessage || missingFinalResponseMessage,
      finishedAt: new Date().toISOString(),
      durationMs,
      stdout: finalStdout,
      stderr: finalStderr,
      responseText: responseText || previousResponseText,
    };
  } catch (err) {
    extractionErrorMessage = `Failed to extract agent final response: ${(err as Error).message}`;
  }

  return {
    status: 'error' as RunStatus,
    errorMessage: formatAgentRunErrorMessage(extractionErrorMessage),
    finishedAt: new Date().toISOString(),
    durationMs,
    stdout: finalStdout,
    stderr: finalStderr,
    responseText: previousResponseText,
  };
}

function buildCardAssignmentTerminalComment(params: {
  run: Record<string, unknown>,
  patch: Record<string, unknown>,
}): string {
  const { run, patch } = params;
  const responseText = typeof patch.responseText === 'string' ? patch.responseText.trim() : '';
  const stdout = typeof patch.stdout === 'string' ? patch.stdout : '';
  const stderr = typeof patch.stderr === 'string' ? patch.stderr.trim() : '';
  const rawErrorMessage =
    typeof patch.errorMessage === 'string'
      ? patch.errorMessage
      : typeof run.errorMessage === 'string'
        ? run.errorMessage
        : null;
  const errorMessage = formatAgentRunErrorMessage(rawErrorMessage);

  let summary = responseText || errorMessage;
  if (!summary && stdout) {
    summary = extractFinalResponseText(stdout).trim() || extractAgentOutputErrorText(stdout).trim();
  }
  if (!summary && stderr) summary = stderr;
  if (!summary) summary = '(empty response)';

  if (summary.length > MAX_CARD_AUTO_COMMENT_LENGTH) {
    summary = `${summary.slice(0, MAX_CARD_AUTO_COMMENT_LENGTH - 3)}...`;
  }

  return summary;
}

function persistTerminalCardAssignmentComment(
  run: Record<string, unknown>,
  patch: Record<string, unknown>,
): { ok: true } | { ok: false; errorMessage: string } {
  if (String(run.triggerType ?? '') !== 'card_assignment') {
    return { ok: true };
  }
  const status = patch.status as RunStatus;
  if (!CARD_COMMENT_TERMINAL_STATUSES.has(status)) {
    return { ok: true };
  }

  const runId = typeof run.id === 'string' ? run.id : null;
  const cardId = typeof run.cardId === 'string' ? run.cardId : null;
  const agentId = typeof run.agentId === 'string' ? run.agentId : null;
  if (!cardId) {
    return { ok: true };
  }

  if (!runId || !agentId) {
    return {
      ok: false,
      errorMessage: 'Cannot persist card completion comment because run or agent attribution is missing.',
    };
  }

  const existing = store
    .getAll('cardComments')
    .some((comment: Record<string, unknown>) => comment.cardId === cardId && comment.agentRunId === runId);
  if (existing) return { ok: true };

  try {
    store.insert('cardComments', {
      cardId,
      authorId: agentId,
      content: buildCardAssignmentTerminalComment({ run, patch }),
      agentRunId: runId,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      errorMessage: `Failed to persist card completion comment: ${(err as Error).message}`,
    };
  }
}

export async function completeAgentRun(
  runId: string,
  errorMessage: string | null = null,
  logs?: { stdout?: string; stderr?: string },
): Promise<Record<string, unknown> | null> {
  return store.transaction(async () => {
    await store.lockAgentRunRowForUpdate(runId);
    const run = store.getById('agent_runs', runId);
    if (!run || run.status !== 'running') return null;
    const patch = buildAgentRunCompletionPatch(run, errorMessage, logs);
    let updated = store.update('agent_runs', runId, patch);
    if (!updated) return null;
    const turnId = typeof run.turnId === 'string' ? (run.turnId as string) : null;
    if (turnId) {
      if (patch.status === 'completed') {
        markAgentChatTurnCompleted(turnId, { runId });
      } else {
        markAgentChatTurnFailed(turnId, {
          runId,
          errorMessage: typeof patch.errorMessage === 'string' ? patch.errorMessage : null,
        });
      }
    }

    const sideEffect = persistTerminalCardAssignmentComment(run, patch);
    if (!sideEffect.ok) {
      updated = store.update('agent_runs', runId, {
        status: 'error' as RunStatus,
        errorMessage: formatAgentRunErrorMessage(sideEffect.errorMessage),
        finishedAt: new Date().toISOString(),
      });
    }
    return updated;
  });
}

export async function failAgentRunCompletionSideEffect(
  runId: string,
  errorMessage: string,
  logs?: { stdout?: string; stderr?: string },
): Promise<Record<string, unknown> | null> {
  return store.transaction(async () => {
    await store.lockAgentRunRowForUpdate(runId);
    const run = store.getById('agent_runs', runId);
    if (!run || run.status === 'error') return null;

    if (logs?.stdout !== undefined && typeof run.stdoutPath === 'string' && run.stdoutPath) {
      try {
        fs.mkdirSync(path.dirname(run.stdoutPath), { recursive: true });
        fs.writeFileSync(run.stdoutPath, logs.stdout);
      } catch {
        // Keep the DB snapshot even if the file cache cannot be refreshed.
      }
    }
    if (logs?.stderr !== undefined && typeof run.stderrPath === 'string' && run.stderrPath) {
      try {
        fs.mkdirSync(path.dirname(run.stderrPath), { recursive: true });
        fs.writeFileSync(run.stderrPath, logs.stderr);
      } catch {
        // Keep the DB snapshot even if the file cache cannot be refreshed.
      }
    }

    const patch = {
      status: 'error' as RunStatus,
      errorMessage: formatAgentRunErrorMessage(errorMessage),
      finishedAt: new Date().toISOString(),
      stdout: logs?.stdout ?? (run.stdout as string | null) ?? null,
      stderr: logs?.stderr ?? (run.stderr as string | null) ?? null,
    };
    let updated = store.update('agent_runs', runId, patch);
    if (!updated) return null;
    markAgentChatTurnFailed(typeof run.turnId === 'string' ? (run.turnId as string) : null, {
      runId,
      errorMessage: patch.errorMessage,
    });
    const sideEffect = persistTerminalCardAssignmentComment(run, patch);
    if (!sideEffect.ok) {
      updated = store.update('agent_runs', runId, {
        status: 'error' as RunStatus,
        errorMessage: formatAgentRunErrorMessage(sideEffect.errorMessage),
        finishedAt: new Date().toISOString(),
      });
    }
    return updated;
  });
}

export function getAgentRun(
  runId: string,
): (StoreRecord & {
  errorMessage: string | null;
  stdout: string | null;
  stderr: string | null;
  responseText: string | null;
}) | null {
  const run = store.getById('agent_runs', runId);
  if (!run) return null;

  // Always prefer reading from current log files so monitor can show
  // finalized/full output even if the in-record snapshot is stale.
  let stdout = typeof run.stdout === 'string' ? run.stdout : null;
  let stderr = typeof run.stderr === 'string' ? run.stderr : null;

  if (typeof run.stdoutPath === 'string' && run.stdoutPath) {
    try {
      stdout = fs.readFileSync(run.stdoutPath, 'utf-8');
    } catch {
      // Fallback to stored snapshot
    }
  }

  if (typeof run.stderrPath === 'string' && run.stderrPath) {
    try {
      stderr = fs.readFileSync(run.stderrPath, 'utf-8');
    } catch {
      // Fallback to stored snapshot
    }
  }

  const storedResponseText =
    typeof run.responseText === 'string' ? run.responseText : null;
  const shouldExtractResponse = run.status === 'completed';
  const extractedResponseText =
    shouldExtractResponse && stdout ? extractFinalResponseText(stdout) : '';
  const responseText = extractedResponseText || storedResponseText;

  if (shouldExtractResponse && responseText && responseText !== storedResponseText) {
    store.update('agent_runs', runId, { responseText });
  }

  return {
    ...run,
    errorMessage: formatAgentRunErrorMessage(
      typeof run.errorMessage === 'string' ? run.errorMessage : null,
    ),
    stdout,
    stderr,
    responseText,
  };
}

export function appendAgentRunOutput(
  runId: string,
  stream: 'stdout' | 'stderr',
  text: string,
): Record<string, unknown> | null {
  if (!text) return store.getById('agent_runs', runId) ?? null;

  const run = store.getById('agent_runs', runId);
  if (!run || run.status !== 'running') return run ?? null;

  const pathKey = stream === 'stdout' ? 'stdoutPath' : 'stderrPath';
  const fieldKey = stream;
  const logPath = typeof run[pathKey] === 'string' ? run[pathKey] as string : '';

  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, text);
      appendAgentRunLifecycleEvent(runId, {
        event: `${stream}_chunk_persisted`,
        [`${stream}Bytes`]: text.length,
      });
      return run;
    } catch {
      // Fall through to the DB snapshot if the log file is unavailable.
    }
  }

  const previous = typeof run[fieldKey] === 'string' ? run[fieldKey] as string : '';
  const updated = store.update('agent_runs', runId, {
    [fieldKey]: `${previous}${text}`,
  });
  appendAgentRunLifecycleEvent(runId, {
    event: `${stream}_chunk_persisted`,
    [`${stream}Bytes`]: text.length,
  });
  return updated;
}

export async function killAgentRun(runId: string): Promise<{ ok: boolean; error?: string }> {
  return store.transaction(async () => {
    await store.lockAgentRunRowForUpdate(runId);
    const run = store.getById('agent_runs', runId);
    if (!run) return { ok: false, error: 'Run not found' };
    if (run.status !== 'running') return { ok: false, error: 'Run is not active' };

    const pid = run.pid as number | null;
    if (run.executor === 'remote') {
      cancelRemoteAgentRun(runId);
    } else if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }

    const patch = buildAgentRunCompletionPatch(run, 'Killed by user', undefined);
    const finalPatch = { ...patch, killedByUser: true };
    store.update('agent_runs', runId, finalPatch);
    markAgentChatTurnStopped(typeof run.turnId === 'string' ? (run.turnId as string) : null, {
      runId,
      errorMessage: 'Killed by user',
    });
    const sideEffect = persistTerminalCardAssignmentComment(run, finalPatch);
    if (!sideEffect.ok) {
      store.update('agent_runs', runId, {
        status: 'error' as RunStatus,
        errorMessage: formatAgentRunErrorMessage(sideEffect.errorMessage),
        finishedAt: new Date().toISOString(),
      });
    }
    return { ok: true };
  });
}

interface ListAgentRunsParams {
  status?: RunStatus;
  agentId?: string;
  triggerType?: TriggerType;
  conversationId?: string;
  cardId?: string;
  limit?: number;
  offset?: number;
}

function toAgentRunSummary(run: Record<string, unknown>) {
  const rawErrorMessage = typeof run.errorMessage === 'string' ? run.errorMessage : null;
  const errorMessage = formatAgentRunErrorMessage(rawErrorMessage);

  return {
    id: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    avatarIcon: run.avatarIcon ?? null,
    avatarBgColor: run.avatarBgColor ?? null,
    avatarLogoColor: run.avatarLogoColor ?? null,
    model: run.model ?? null,
    modelId: run.modelId ?? null,
    triggerType: run.triggerType,
    status: run.status,
    conversationId: run.conversationId ?? null,
    cardId: run.cardId ?? null,
    cronJobId: run.cronJobId ?? null,
    responseParentId: run.responseParentId ?? null,
    turnId: run.turnId ?? null,
    errorMessage,
    responseText: run.responseText ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
  };
}

export async function listAgentRuns(params: ListAgentRunsParams = {}) {
  const { status, agentId, triggerType, conversationId, cardId, limit = 50, offset = 0 } = params;

  const { rows: all, total } = await findAgentRunsByListFilterPaged(
    {
      status,
      agentId,
      triggerType,
      conversationId,
      cardId,
    },
    limit,
    offset,
  );

  const entries = all.map(toAgentRunSummary);
  return { entries, total };
}

export async function getActiveRuns() {
  const running = await findRunningAgentRunsAsync();
  return running
    .map(toAgentRunSummary)
    .sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        new Date(b.startedAt as string).getTime() - new Date(a.startedAt as string).getTime(),
    );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function finalizeInterruptedRun(
  run: Record<string, unknown>,
  errorMessage = 'Process died (server restarted or process killed)',
): Promise<Record<string, unknown> | null> {
  const id = run.id as string;
  const stdoutPath = run.stdoutPath as string | null;
  const stderrPath = run.stderrPath as string | null;
  let stdout = '';
  let stderr = '';

  if (stdoutPath) {
    try { stdout = fs.readFileSync(stdoutPath, 'utf-8'); } catch { /* */ }
  }
  if (stderrPath) {
    try { stderr = fs.readFileSync(stderrPath, 'utf-8'); } catch { /* */ }
  }

  const hasOutput = stdout.trim().length > 0;
  const startedAt = new Date(run.startedAt as string).getTime();
  const now = Date.now();
  const structuredErrorMessage = hasOutput ? extractAgentOutputErrorText(stdout) : '';

  if (structuredErrorMessage) {
    console.log(`[agent-runs] Interrupted stdout reports an error for run ${id}`);
    appendAgentRunLifecycleEvent(id, {
      event: 'reconcile_finalize_error_output',
      message: structuredErrorMessage,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
    });
    return completeAgentRun(id, structuredErrorMessage, {
      stdout,
      stderr,
    });
  }
  if (hasOutput) {
    console.log(`[agent-runs] Interrupted run ${id} has stdout, finalizing from logs`);
    appendAgentRunLifecycleEvent(id, {
      event: 'reconcile_finalize_from_output',
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
    });
    return completeAgentRun(id, null, {
      stdout,
      stderr,
    });
  }

  console.log(`[agent-runs] Interrupted run ${id} has no output, marking error`);
  appendAgentRunLifecycleEvent(id, {
    event: 'reconcile_finalize_no_output',
    message: errorMessage,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
  });
  const patch = {
    status: 'error',
    errorMessage: stderr.trim() ? DEFAULT_AGENT_RUN_ERROR_MESSAGE : errorMessage,
    finishedAt: new Date().toISOString(),
    durationMs: now - startedAt,
    stdout,
    stderr,
  };
  let updated = store.update('agent_runs', id, patch);
  const sideEffect = persistTerminalCardAssignmentComment(run, patch);
  if (!sideEffect.ok) {
    updated = store.update('agent_runs', id, {
      status: 'error',
      errorMessage: formatAgentRunErrorMessage(sideEffect.errorMessage),
      finishedAt: new Date().toISOString(),
    });
  }
  return updated;
}

/**
 * On startup, check all 'running' agent runs.
 * - If a legacy local PID is alive and a reattach callback is available, re-monitor it
 * - If PID is dead or no callback is available, read output from log files and mark completed/error
 */
export async function reconcileRunsOnStartup(
  reattach?: (run: Record<string, unknown>) => void,
) {
  const stale = await findRunningAgentRunsAsync();
  if (stale.length === 0) return [];

  console.log(`[agent-runs] Reconciling ${stale.length} running record(s) after restart`);

  for (const run of stale) {
    const id = run.id as string;
    const pid = run.pid as number | null;
    const executor = typeof run.executor === 'string' ? run.executor : 'local';
    const hasRemoteLogPaths = Boolean(run.stdoutPath || run.stderrPath);

    if (executor === 'remote' && !pid && hasRemoteLogPaths) {
      console.log(`[agent-runs] Preserving remote run ${id} for runner reconnection`);
      continue;
    }

    if (pid && reattach && isPidAlive(pid)) {
      console.log(`[agent-runs] PID ${pid} still alive for run ${id}, re-attaching`);
      reattach(run);
      continue;
    }

    // PID is dead or missing — finalize the run
    await finalizeInterruptedRun(run);
  }

  return stale;
}

export async function reconcileUnrecoveredRemoteRuns(): Promise<number> {
  const running = await findRunningAgentRunsAsync();
  let finalized = 0;
  const now = Date.now();
  const minAgeMs = env.REMOTE_AGENT_RUNNER_RECONNECT_GRACE_MS;

  for (const run of running) {
    const id = typeof run.id === 'string' ? run.id : null;
    const executor = typeof run.executor === 'string' ? run.executor : 'local';
    const pid = run.pid as number | null;
    if (!id || executor !== 'remote' || pid) continue;
    if (isRemoteAgentRunPending(id)) continue;
    const startedAtMs = new Date(run.startedAt as string).getTime();
    if (Number.isFinite(startedAtMs) && now - startedAtMs < minAgeMs) continue;

    await finalizeInterruptedRun(run, 'Remote runner job was not recovered after backend restart');
    finalized++;
  }

  if (finalized > 0) {
    console.log(`[agent-runs] Finalized ${finalized} unrecovered remote run${finalized === 1 ? '' : 's'}`);
  }

  return finalized;
}

/**
 * Delete completed/error run records older than the given number of days.
 * Also removes their log directories from disk.
 * Running runs are never deleted.
 * Returns the number of records deleted.
 */
export function cleanupOldRunRecords(olderThanDays: number): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  const ids = findAgentRunIdsForRetentionCleanup(cutoff);

  let deleted = 0;
  for (const runId of ids) {
    // Remove log directory if it exists
    const logDir = path.join(RUNS_DIR, runId);
    if (fs.existsSync(logDir)) {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // Best-effort
      }
    }

    store.delete('agent_runs', runId);
    deleted++;
  }

  if (deleted > 0) {
    console.log(`[agent-runs] Deleted ${deleted} old run record${deleted === 1 ? '' : 's'} (older than ${olderThanDays}d)`);
  }

  return deleted;
}

export function migrateLegacyAgentRunTriggerTypes() {
  const legacyToCanonical: Record<LegacyTriggerType, Exclude<TriggerType, 'chat'>> = {
    cron: 'cron_job',
    card: 'card_assignment',
  };

  const legacyCounts = {
    cron: 0,
    card: 0,
  };

  const runs = findAgentRunsWithLegacyTriggerTypes();

  for (const run of runs) {
    const triggerType = run.triggerType;
    if (triggerType !== 'cron' && triggerType !== 'card') continue;

    legacyCounts[triggerType as LegacyTriggerType] += 1;
    store.update('agent_runs', run.id as string, {
      triggerType: legacyToCanonical[triggerType as LegacyTriggerType],
    });
  }

  return {
    scanned: runs.length,
    migrated: runs.length,
    legacyCounts,
  };
}

/**
 * Delete run log directories older than LOG_RETENTION_DAYS.
 */
export function cleanupOldRunLogs() {
  if (!fs.existsSync(RUNS_DIR)) return;

  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(RUNS_DIR, entry.name);
      try {
        const stat = fs.statSync(dirPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // RUNS_DIR may not be readable yet
  }

  if (cleaned > 0) {
    console.log(`[agent-runs] Cleaned up ${cleaned} old run log director${cleaned === 1 ? 'y' : 'ies'}`);
  }
}
