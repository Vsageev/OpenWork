import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { env } from '../config/env.js';
import {
  RUNNER_PROTOCOL_VERSION,
  extractAgentOutputIncompleteText,
  parseRunnerServerMessage,
  type RunnerCapabilities as ProtocolRunnerCapabilities,
  type RunnerJobIntent,
  type RunnerServerMessage,
  type ServerRunnerMessage,
} from 'shared';
import {
  authenticateRunnerCredential,
  noteRunnerConnected,
  noteRunnerDisconnected,
  noteRunnerSeen,
  RUNNER_STALE_AFTER_MS,
  type RunnerCapabilities,
  type RunnerRecord,
} from './runner-devices.js';

export interface RemoteAgentJob {
  userId?: string | null;
  workspaceId?: string | null;
  intent: RunnerJobIntent;
  timeoutMs?: number;
}

export interface RemoteAgentJobCallbacks {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface RemoteAgentJobResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class RemoteAgentJobError extends Error {
  code: number | null;
  stdout: string;
  stderr: string;

  constructor(message: string, result?: RemoteAgentJobResult) {
    super(message);
    this.name = 'RemoteAgentJobError';
    this.code = result?.code ?? null;
    this.stdout = result?.stdout ?? '';
    this.stderr = result?.stderr ?? '';
  }
}

interface PendingJob {
  jobId: string;
  runId: string;
  callbacks: RemoteAgentJobCallbacks;
  resolve: (result: RemoteAgentJobResult) => void;
  reject: (error: Error) => void;
  stdout: string;
  stderr: string;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface ConnectedRunner {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  ws: WebSocket;
  capabilities: RunnerCapabilities | ProtocolRunnerCapabilities;
  connectedAt: string;
  lastSeenAt: string;
  activeJobIds: Set<string>;
}

const runners = new Map<string, ConnectedRunner>();
const jobsById = new Map<string, PendingJob>();
const jobRunnerById = new Map<string, string>();
const jobIdByRunId = new Map<string, string>();
const availableRunnerListeners = new Set<() => void>();
const RUNNER_HEARTBEAT_INTERVAL_MS = 30_000;
/** When a runner socket drops, fail in-flight jobs only after this grace period (cleared on reconnect). */
const runnerReconnectGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRunnerDisconnectGrace(runnerId: string) {
  clearRunnerReconnectGrace(runnerId);
  const graceMs = env.REMOTE_AGENT_RUNNER_RECONNECT_GRACE_MS;
  if (graceMs === 0) {
    failJobsForDisconnectedRunner(runnerId, `Runner ${runnerId} disconnected`);
    return;
  }
  const timer = setTimeout(() => {
    runnerReconnectGraceTimers.delete(runnerId);
    if (runners.has(runnerId)) return;
    failJobsForDisconnectedRunner(
      runnerId,
      `Runner ${runnerId} disconnected (reconnect grace expired after ${graceMs}ms)`,
    );
  }, graceMs);
  timer.unref?.();
  runnerReconnectGraceTimers.set(runnerId, timer);
}

function clearRunnerReconnectGrace(runnerId: string) {
  const timer = runnerReconnectGraceTimers.get(runnerId);
  if (!timer) return;
  clearTimeout(timer);
  runnerReconnectGraceTimers.delete(runnerId);
}

function collectJobIdsForRunner(runnerId: string): Set<string> {
  const ids = new Set<string>();
  for (const [jobId, mappedRunnerId] of jobRunnerById) {
    if (mappedRunnerId === runnerId) ids.add(jobId);
  }
  return ids;
}

function reattachInFlightJobsToRunner(runner: ConnectedRunner) {
  for (const jobId of collectJobIdsForRunner(runner.id)) {
    if (jobsById.has(jobId)) runner.activeJobIds.add(jobId);
  }
}

function failJobsForDisconnectedRunner(runnerId: string, message: string) {
  for (const jobId of [...jobRunnerById.keys()]) {
    if (jobRunnerById.get(jobId) === runnerId) {
      failPendingJob(jobId, new Error(message));
    }
  }
}

function runnerIsOpen(runner: ConnectedRunner): boolean {
  return runner.ws.readyState === WebSocket.OPEN;
}

function noteConnectedRunnerSeen(runner: ConnectedRunner) {
  noteRunnerSeen(runner.id, runner.activeJobIds.size > 0 ? 'busy' : 'online');
}

function send(ws: WebSocket, message: ServerRunnerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function parseJsonMessage(raw: WebSocket.RawData): RunnerServerMessage | null {
  try {
    return parseRunnerServerMessage(JSON.parse(raw.toString()));
  } catch {
    return null;
  }
}

async function authenticateUpgrade(request: IncomingMessage): Promise<RunnerRecord | null> {
  const host = request.headers.host ?? 'localhost';
  const url = new URL(request.url ?? '/', `http://${host}`);
  const auth = request.headers.authorization;
  const headerCredential = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  const credential =
    headerCredential || url.searchParams.get('credential') || url.searchParams.get('token');
  if (!credential) return null;

  if (
    env.AGENT_RUNNER_ENABLE_SHARED_TOKEN &&
    env.AGENT_RUNNER_SHARED_TOKEN &&
    credential === env.AGENT_RUNNER_SHARED_TOKEN
  ) {
    const runnerId =
      env.AGENT_RUNNER_ID || url.searchParams.get('runnerId') || 'local-dev-runner';
    return {
      id: runnerId,
      userId: 'local-dev-user',
      workspaceId: env.AGENT_RUNNER_WORKSPACE_ID || '*',
      displayName: url.searchParams.get('name') || runnerId,
      credentialHash: '',
      credentialPrefix: 'shared',
      status: 'online',
      lastSeenAt: new Date().toISOString(),
      version: null,
      capabilities: {},
      revokedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return authenticateRunnerCredential(credential);
}

function runnerMatchesUser(runner: ConnectedRunner, userId?: string | null): boolean {
  return !userId || runner.userId === userId;
}

function runnerMatchesWorkspace(runner: ConnectedRunner, workspaceId?: string | null): boolean {
  return !workspaceId || runner.workspaceId === workspaceId || runner.workspaceId === '*';
}

function runnerSupportsProvider(runner: ConnectedRunner, provider?: RunnerJobIntent['provider']): boolean {
  if (!provider) return true;
  const supportedProviders = runner.capabilities?.supportedProviders;
  return Array.isArray(supportedProviders) && supportedProviders.includes(provider);
}

function runnerMatchesJob(
  runner: ConnectedRunner,
  userId?: string | null,
  workspaceId?: string | null,
  provider?: RunnerJobIntent['provider'],
): boolean {
  return (
    runnerIsOpen(runner) &&
    getConnectedRunnerLiveStatus(runner) !== 'stale' &&
    runnerMatchesUser(runner, userId) &&
    runnerMatchesWorkspace(runner, workspaceId) &&
    runnerSupportsProvider(runner, provider)
  );
}

function pickRunner(
  userId?: string | null,
  workspaceId?: string | null,
  provider?: RunnerJobIntent['provider'],
): ConnectedRunner | null {
  if (env.AGENT_RUNNER_ID) {
    const preferred = runners.get(env.AGENT_RUNNER_ID);
    if (preferred && runnerMatchesJob(preferred, userId, workspaceId, provider)) {
      return preferred;
    }
    return null;
  }

  return [...runners.values()]
    .filter((runner) => runnerMatchesJob(runner, userId, workspaceId, provider))
    .sort((a, b) => {
      const activeDelta = a.activeJobIds.size - b.activeJobIds.size;
      if (activeDelta !== 0) return activeDelta;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    })[0] ?? null;
}

function notifyAvailableRunner() {
  if (!hasAvailableRemoteAgentRunner()) return;
  for (const listener of availableRunnerListeners) {
    listener();
  }
}

function isRunnerStale(runner: ConnectedRunner, now = Date.now()): boolean {
  const lastSeenMs = Date.parse(runner.lastSeenAt);
  return Number.isFinite(lastSeenMs) && now - lastSeenMs > RUNNER_STALE_AFTER_MS;
}

function getConnectedRunnerLiveStatus(
  runner: ConnectedRunner,
  now = Date.now(),
): 'online' | 'busy' | 'stale' {
  if (isRunnerStale(runner, now)) return 'stale';
  return runner.activeJobIds.size > 0 ? 'busy' : 'online';
}

function failPendingJob(jobId: string, error: Error) {
  const pending = jobsById.get(jobId);
  if (!pending) return;
  if (pending.timeout) clearTimeout(pending.timeout);
  jobsById.delete(jobId);
  jobIdByRunId.delete(pending.runId);
  const runnerId = jobRunnerById.get(jobId);
  jobRunnerById.delete(jobId);
  const runner = runnerId ? runners.get(runnerId) : null;
  if (runner) {
    runner.activeJobIds.delete(jobId);
    runner.lastSeenAt = new Date().toISOString();
    noteConnectedRunnerSeen(runner);
  }
  notifyAvailableRunner();
  pending.reject(error);
}

function completePendingJob(
  jobId: string,
  result: RemoteAgentJobResult,
  runner: ConnectedRunner | null,
) {
  const pending = jobsById.get(jobId);
  if (!pending) return;
  if (pending.timeout) clearTimeout(pending.timeout);
  jobsById.delete(jobId);
  jobRunnerById.delete(jobId);
  jobIdByRunId.delete(pending.runId);
  if (runner) {
    runner.activeJobIds.delete(jobId);
    runner.lastSeenAt = new Date().toISOString();
    noteConnectedRunnerSeen(runner);
  }
  notifyAvailableRunner();
  const stdout = result.stdout
    ? `${result.stdout}${pending.stdout && !result.stdout.includes(pending.stdout) ? pending.stdout : ''}`
    : pending.stdout;
  const stderr = result.stderr
    ? `${result.stderr}${pending.stderr && !result.stderr.includes(pending.stderr) ? pending.stderr : ''}`
    : pending.stderr;
  pending.resolve({
    code: result.code,
    stdout,
    stderr,
  });
}

async function completeUnknownRunnerTerminalMessage(
  message: Extract<RunnerServerMessage, { type: 'completed' | 'failed' | 'cancelled' }>,
) {
  try {
    const { completeAgentRun } = await import('./agent-runs.js');
    const errorMessage =
      message.type === 'completed'
        ? null
        : message.type === 'failed'
          ? message.message
          : message.message || 'Remote runner cancelled the job';
    await completeAgentRun(message.runId, errorMessage, {
      stdout: message.stdout,
      stderr: message.stderr,
    });
  } catch (err) {
    console.error(`[runners] Failed to finalize unknown runner terminal message for run ${message.runId}:`, err);
  }
}

function appendRunnerFinalMessage(pending: PendingJob, message: Extract<RunnerServerMessage, { type: 'final_message' }>) {
  const event = {
    type: 'item.completed',
    item: {
      id: `openwork-final-message-${message.runId}`,
      type: 'openwork_final_message',
      text: message.text,
    },
  };
  const line = `${JSON.stringify(event)}\n`;
  pending.stdout += line;
  pending.callbacks.onStdout?.(line);
}

export function getCompletedRunnerProtocolError(
  message: Extract<RunnerServerMessage, { type: 'completed' }>,
): RemoteAgentJobError | null {
  const incompleteMessage = extractAgentOutputIncompleteText(message.stdout);
  if (!incompleteMessage) return null;
  return new RemoteAgentJobError(incompleteMessage, {
    code: message.code,
    stdout: message.stdout,
    stderr: message.stderr,
  });
}

function handleRunnerMessage(runner: ConnectedRunner, message: RunnerServerMessage | null) {
  if (!message) return;
  runner.lastSeenAt = new Date().toISOString();
  noteConnectedRunnerSeen(runner);

  if (message.type === 'runner_hello') {
    if (message.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
      runner.ws.close(1002, 'Runner protocol version mismatch');
      return;
    }
    runner.name = message.name || runner.name;
    runner.capabilities = message.capabilities ?? {};
    void noteRunnerConnected(runner.id, {
      displayName: runner.name,
      version: message.capabilities?.runnerVersion,
      capabilities: runner.capabilities,
    });
    return;
  }

  if (message.type === 'job_accepted') {
    const pending = jobsById.get(message.jobId);
    if (!pending) return;
    return;
  }

  if (message.type === 'job_rejected') {
    failPendingJob(message.jobId, new Error(`${message.code}: ${message.message}`));
    return;
  }

  if (message.type === 'output_event' && message.stream === 'stdout') {
    const pending = jobsById.get(message.jobId);
    if (!pending) return;
    pending.stdout += message.text;
    pending.callbacks.onStdout?.(message.text);
    return;
  }

  if (message.type === 'output_event' && message.stream === 'stderr') {
    const pending = jobsById.get(message.jobId);
    if (!pending) return;
    pending.stderr += message.text;
    pending.callbacks.onStderr?.(message.text);
    return;
  }

  if (message.type === 'final_message') {
    const pending = jobsById.get(message.jobId);
    if (!pending) return;
    appendRunnerFinalMessage(pending, message);
    return;
  }

  if (message.type === 'artifact') {
    return;
  }

  if (message.type === 'completed') {
    if (!jobsById.has(message.jobId)) {
      void completeUnknownRunnerTerminalMessage(message);
      return;
    }
    const protocolError = getCompletedRunnerProtocolError(message);
    if (protocolError) {
      failPendingJob(message.jobId, protocolError);
      return;
    }
    completePendingJob(
      message.jobId,
      {
        code: message.code,
        stdout: message.stdout ?? '',
        stderr: message.stderr ?? '',
      },
      runner,
    );
    return;
  }

  if (message.type === 'failed') {
    if (!jobsById.has(message.jobId)) {
      void completeUnknownRunnerTerminalMessage(message);
      return;
    }
    failPendingJob(message.jobId, new RemoteAgentJobError(message.message, {
      code: message.code,
      stdout: message.stdout,
      stderr: message.stderr,
    }));
    return;
  }

  if (message.type === 'cancelled') {
    if (!jobsById.has(message.jobId)) {
      void completeUnknownRunnerTerminalMessage(message);
      return;
    }
    failPendingJob(message.jobId, new Error(message.message || 'Remote runner cancelled the job'));
    return;
  }

  if (message.type === 'protocol_error') {
    if (message.jobId) failPendingJob(message.jobId, new Error(message.message));
  }
}

export function registerAgentRunnerServer(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeatInterval = setInterval(() => {
    for (const runner of runners.values()) {
      if (!runnerIsOpen(runner)) continue;
      try {
        runner.ws.ping();
      } catch {
        runner.ws.terminate();
      }
    }
  }, RUNNER_HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  app.server.on('upgrade', (request, socket, head) => {
    const host = request.headers.host ?? 'localhost';
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname !== '/api/runners/ws') return;

    void authenticateUpgrade(request).then((runnerRecord) => {
      if (!runnerRecord) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const runnerId = runnerRecord.id || url.searchParams.get('runnerId') || randomUUID();
        const now = new Date().toISOString();

        const existing = runners.get(runnerId);
        if (existing) {
          console.warn(`[runners] Runner ${runnerId} reconnected — closing previous WebSocket`);
          existing.ws.close(1000, 'Replaced by new connection');
          runners.delete(runnerId);
        }
        clearRunnerReconnectGrace(runnerId);

        const runner: ConnectedRunner = {
          id: runnerId,
          userId: runnerRecord.userId,
          workspaceId: runnerRecord.workspaceId,
          name: url.searchParams.get('name') || runnerRecord.displayName || runnerId,
          ws,
          capabilities: runnerRecord.capabilities ?? {},
          connectedAt: now,
          lastSeenAt: now,
          activeJobIds: new Set(),
        };

        runners.set(runnerId, runner);
        reattachInFlightJobsToRunner(runner);
        void noteRunnerConnected(runnerId, { displayName: runner.name, capabilities: runner.capabilities });
        send(ws, { type: 'server_hello', protocolVersion: RUNNER_PROTOCOL_VERSION, runnerId });
        notifyAvailableRunner();

        ws.on('message', (raw) => handleRunnerMessage(runner, parseJsonMessage(raw)));
        ws.on('pong', () => {
          runner.lastSeenAt = new Date().toISOString();
          noteConnectedRunnerSeen(runner);
        });
        ws.on('close', () => {
          if (runners.get(runnerId) !== runner) return;
          runners.delete(runnerId);
          noteRunnerDisconnected(runnerId);
          scheduleRunnerDisconnectGrace(runnerId);
        });
      });
    }).catch(() => {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    });
  });

  app.addHook('onClose', async () => {
    clearInterval(heartbeatInterval);
    wss.close();
  });
}

export function listConnectedAgentRunners() {
  return [...runners.values()].map((runner) => ({
    id: runner.id,
    userId: runner.userId,
    workspaceId: runner.workspaceId,
    name: runner.name,
    status: getConnectedRunnerLiveStatus(runner),
    capabilities: runner.capabilities,
    connectedAt: runner.connectedAt,
    lastSeenAt: runner.lastSeenAt,
    currentJobId: [...runner.activeJobIds][0] ?? null,
    currentJobIds: [...runner.activeJobIds],
  }));
}

export function getLiveRunnerStatusMap(): Map<string, 'online' | 'busy' | 'stale'> {
  return new Map([...runners.values()].map((runner) => [runner.id, getConnectedRunnerLiveStatus(runner)]));
}

export function hasAvailableRemoteAgentRunner(
  userIdOrWorkspaceId?: string | null,
  workspaceIdOrProvider?: string | null,
  providerMaybe?: RunnerJobIntent['provider'],
): boolean;
export function hasAvailableRemoteAgentRunner(
  workspaceId?: string | null,
  provider?: RunnerJobIntent['provider'],
): boolean;
export function hasAvailableRemoteAgentRunner(
  first?: string | null,
  second?: string | RunnerJobIntent['provider'] | null,
  third?: RunnerJobIntent['provider'],
): boolean {
  const userId = third === undefined ? undefined : first;
  const workspaceId = third === undefined ? first : second;
  const provider = third === undefined ? (second as RunnerJobIntent['provider'] | undefined) : third;
  return pickRunner(userId, workspaceId, provider) !== null;
}

export function hasConnectedRemoteAgentRunner(
  userIdOrWorkspaceId?: string | null,
  workspaceIdMaybe?: string | null,
): boolean;
export function hasConnectedRemoteAgentRunner(workspaceId?: string | null): boolean;
export function hasConnectedRemoteAgentRunner(
  first?: string | null,
  second?: string | null,
): boolean {
  const userId = second === undefined ? undefined : first;
  const workspaceId = second === undefined ? first : second;
  return [...runners.values()].some(
    (runner) =>
      runnerIsOpen(runner) &&
      getConnectedRunnerLiveStatus(runner) !== 'stale' &&
      runnerMatchesUser(runner, userId) &&
      runnerMatchesWorkspace(runner, workspaceId),
  );
}

export function disconnectRemoteAgentRunner(runnerId: string): boolean {
  const runner = runners.get(runnerId);
  if (!runner) return false;
  runner.ws.close(1008, 'Runner revoked');
  runners.delete(runnerId);
  for (const jobId of [...runner.activeJobIds]) {
    failPendingJob(jobId, new Error(`Runner ${runnerId} revoked`));
  }
  return true;
}

const PROVIDER_COMMANDS: Record<RunnerJobIntent['provider'], string> = {
  claude: 'claude',
  codex: 'codex',
  qwen: 'qwen',
  cursor: 'cursor-agent',
  opencode: 'opencode',
};

export function getRemoteAgentRunnerUnavailableMessage(
  workspaceId?: string | null,
  provider?: RunnerJobIntent['provider'],
): string {
  if (!hasConnectedRemoteAgentRunner(workspaceId)) {
    return 'No remote agent runner is connected. Start or pair an OpenWork runner, then try again.';
  }
  if (provider && !hasAvailableRemoteAgentRunner(workspaceId, provider)) {
    return `No eligible remote agent runner supports ${provider}. Install ${PROVIDER_COMMANDS[provider]} on the runner, restart it, or choose another model.`;
  }
  return 'No eligible remote agent runner is connected for this workspace.';
}

export function onRemoteAgentRunnerAvailable(listener: () => void): () => void {
  availableRunnerListeners.add(listener);
  return () => {
    availableRunnerListeners.delete(listener);
  };
}

export function dispatchRemoteAgentJob(
  job: RemoteAgentJob,
  callbacks: RemoteAgentJobCallbacks = {},
): Promise<RemoteAgentJobResult> {
  const runner = pickRunner(job.userId, job.workspaceId, job.intent.provider);
  if (!runner) {
    return Promise.reject(
      new Error(getRemoteAgentRunnerUnavailableMessage(job.workspaceId, job.intent.provider)),
    );
  }

  const jobId = randomUUID();
  runner.activeJobIds.add(jobId);
  runner.lastSeenAt = new Date().toISOString();
  noteConnectedRunnerSeen(runner);

  return new Promise<RemoteAgentJobResult>((resolve, reject) => {
    const timeoutMs = job.timeoutMs ?? env.REMOTE_AGENT_RUN_TIMEOUT_MS;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            cancelRemoteAgentRun(job.intent.runId);
            failPendingJob(jobId, new Error(`Remote agent run timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    timeout?.unref();

    jobsById.set(jobId, {
      jobId,
      runId: job.intent.runId,
      callbacks,
      resolve,
      reject,
      stdout: '',
      stderr: '',
      timeout,
    });
    jobRunnerById.set(jobId, runner.id);
    jobIdByRunId.set(job.intent.runId, jobId);

    send(runner.ws, {
      type: 'job_offer',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      job: job.intent,
    });
  });
}

export function cancelRemoteAgentRun(runId: string): boolean {
  const jobId = jobIdByRunId.get(runId);
  if (!jobId) return false;
  const runnerId = jobRunnerById.get(jobId);
  const runner = runnerId ? runners.get(runnerId) : null;
  if (!runner) return false;
  send(runner.ws, { type: 'cancel', protocolVersion: RUNNER_PROTOCOL_VERSION, jobId, runId });
  return true;
}

/** True while this run has an in-flight remote job on this backend process. */
export function isRemoteAgentRunPending(runId: string): boolean {
  return jobIdByRunId.has(runId);
}

export const __runnerTestUtils = {
  getConnectedRunnerLiveStatus,
  handleRunnerMessage,
  isRunnerStale,
  pickRunner,
  reattachInFlightJobsToRunner,
  runners,
  jobsById,
  jobRunnerById,
  jobIdByRunId,
};
