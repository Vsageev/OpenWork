import fs from 'node:fs';
import path from 'node:path';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { extractFinalResponseText } from '../lib/agent-output.js';

type TriggerType = 'chat' | 'cron_job' | 'card_assignment';
type RunStatus = 'running' | 'completed' | 'error';
type LegacyTriggerType = 'cron' | 'card';

const RUNS_DIR = path.resolve(env.DATA_DIR, 'agent-runs');
const LOG_RETENTION_DAYS = 7;

interface CreateAgentRunParams {
  agentId: string;
  agentName: string;
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
  triggerType: TriggerType;
  conversationId?: string | null;
  cardId?: string | null;
  cronJobId?: string | null;
  pid?: number | null;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  triggerPrompt?: string | null;
  responseParentId?: string | null;
}

export function createAgentRun(params: CreateAgentRunParams): Record<string, unknown> {
  return store.insert('agent_runs', {
    agentId: params.agentId,
    agentName: params.agentName,
    avatarIcon: params.avatarIcon ?? null,
    avatarBgColor: params.avatarBgColor ?? null,
    avatarLogoColor: params.avatarLogoColor ?? null,
    triggerType: params.triggerType,
    status: 'running' as RunStatus,
    conversationId: params.conversationId ?? null,
    cardId: params.cardId ?? null,
    cronJobId: params.cronJobId ?? null,
    pid: params.pid ?? null,
    stdoutPath: params.stdoutPath ?? null,
    stderrPath: params.stderrPath ?? null,
    triggerPrompt: params.triggerPrompt ?? null,
    responseParentId: params.responseParentId ?? null,
    errorMessage: null,
    responseText: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
  });
}

export function completeAgentRun(
  runId: string,
  errorMessage: string | null = null,
  logs?: { stdout?: string; stderr?: string },
) {
  const run = store.getById('agent_runs', runId);
  if (!run) return null;

  const startedAt = new Date(run.startedAt as string).getTime();
  const now = Date.now();
  const durationMs = now - startedAt;

  // If logs not passed explicitly, try reading from files
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
  const previousResponseText =
    typeof run.responseText === 'string' ? run.responseText : null;
  const responseText = finalStdout ? extractFinalResponseText(finalStdout) : '';

  return store.update('agent_runs', runId, {
    status: errorMessage ? 'error' : 'completed',
    errorMessage,
    finishedAt: new Date().toISOString(),
    durationMs,
    stdout: finalStdout,
    stderr: stderr ?? (run.stderr as string | null) ?? null,
    responseText: responseText || previousResponseText,
  });
}

export function getAgentRun(runId: string) {
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
  const shouldExtractResponse = run.status !== 'running';
  const extractedResponseText =
    shouldExtractResponse && stdout ? extractFinalResponseText(stdout) : '';
  const responseText = extractedResponseText || storedResponseText;

  if (shouldExtractResponse && responseText && responseText !== storedResponseText) {
    store.update('agent_runs', runId, { responseText });
  }

  return {
    ...run,
    stdout,
    stderr,
    responseText,
  };
}

export function killAgentRun(runId: string): { ok: boolean; error?: string } {
  const run = store.getById('agent_runs', runId);
  if (!run) return { ok: false, error: 'Run not found' };
  if (run.status !== 'running') return { ok: false, error: 'Run is not active' };

  const pid = run.pid as number | null;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may have already exited
    }
  }

  completeAgentRun(runId, 'Killed by user');
  store.update('agent_runs', runId, { killedByUser: true });
  return { ok: true };
}

interface ListAgentRunsParams {
  status?: RunStatus;
  agentId?: string;
  triggerType?: TriggerType;
  conversationId?: string;
  limit?: number;
  offset?: number;
}

function toAgentRunSummary(run: Record<string, unknown>) {
  return {
    id: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    avatarIcon: run.avatarIcon ?? null,
    avatarBgColor: run.avatarBgColor ?? null,
    avatarLogoColor: run.avatarLogoColor ?? null,
    triggerType: run.triggerType,
    status: run.status,
    conversationId: run.conversationId ?? null,
    cardId: run.cardId ?? null,
    cronJobId: run.cronJobId ?? null,
    responseParentId: run.responseParentId ?? null,
    errorMessage: run.errorMessage ?? null,
    responseText: run.responseText ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
  };
}

export function listAgentRuns(params: ListAgentRunsParams = {}) {
  const { status, agentId, triggerType, conversationId, limit = 50, offset = 0 } = params;

  const all = store.find('agent_runs', (r: Record<string, unknown>) => {
    if (status && r.status !== status) return false;
    if (agentId && r.agentId !== agentId) return false;
    if (triggerType && r.triggerType !== triggerType) return false;
    if (conversationId && r.conversationId !== conversationId) return false;
    return true;
  });

  const sorted = all.sort(
    (a: Record<string, unknown>, b: Record<string, unknown>) =>
      new Date(b.startedAt as string).getTime() - new Date(a.startedAt as string).getTime(),
  );

  const entries = sorted.slice(offset, offset + limit).map(toAgentRunSummary);
  return { entries, total: all.length };
}

export function getActiveRuns() {
  return store
    .find('agent_runs', (r: Record<string, unknown>) => r.status === 'running')
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

/**
 * On startup, check all 'running' agent runs.
 * - If PID is alive → call reattach callback so agent-chat can re-monitor
 * - If PID is dead → read output from log files and mark completed/error
 */
export function reconcileRunsOnStartup(
  reattach: (run: Record<string, unknown>) => void,
) {
  const stale = store.find('agent_runs', (r: Record<string, unknown>) => r.status === 'running');
  if (stale.length === 0) return [];

  console.log(`[agent-runs] Reconciling ${stale.length} running record(s) after restart`);

  for (const run of stale) {
    const id = run.id as string;
    const pid = run.pid as number | null;

    if (pid && isPidAlive(pid)) {
      console.log(`[agent-runs] PID ${pid} still alive for run ${id}, re-attaching`);
      reattach(run);
      continue;
    }

    // PID is dead or missing — finalize the run
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

    if (hasOutput) {
      console.log(`[agent-runs] PID dead but stdout exists for run ${id}, marking completed`);
      const responseText = extractFinalResponseText(stdout);
      store.update('agent_runs', id, {
        status: 'completed',
        errorMessage: null,
        finishedAt: new Date().toISOString(),
        durationMs: now - startedAt,
        stdout,
        stderr,
        responseText: responseText || null,
      });
    } else {
      console.log(`[agent-runs] PID dead, no output for run ${id}, marking error`);
      store.update('agent_runs', id, {
        status: 'error',
        errorMessage: stderr.trim() || 'Process died (server restarted or process killed)',
        finishedAt: new Date().toISOString(),
        durationMs: now - startedAt,
        stdout,
        stderr,
      });
    }
  }

  return stale;
}

/**
 * Delete completed/error run records older than the given number of days.
 * Also removes their log directories from disk.
 * Running runs are never deleted.
 * Returns the number of records deleted.
 */
export function cleanupOldRunRecords(olderThanDays: number): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  const toDelete = store.find('agent_runs', (r: Record<string, unknown>) => {
    if (r.status === 'running') return false;
    const finished = r.finishedAt ?? r.startedAt;
    return new Date(finished as string).getTime() < cutoff;
  });

  let deleted = 0;
  for (const run of toDelete) {
    const runId = run.id as string;

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

  const runs = store.find('agent_runs', (r: Record<string, unknown>) => {
    return r.triggerType === 'cron' || r.triggerType === 'card';
  });

  for (const run of runs) {
    const triggerType = run.triggerType;
    if (triggerType !== 'cron' && triggerType !== 'card') continue;

    legacyCounts[triggerType] += 1;
    store.update('agent_runs', run.id as string, {
      triggerType: legacyToCanonical[triggerType],
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
