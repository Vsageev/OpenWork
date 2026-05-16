#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  RUNNER_PROTOCOL_VERSION,
  extractFinalResponseText,
  parseRunnerJobIntent,
  parseServerRunnerMessage,
  type RunnerCapabilities,
  type RunnerProvider,
  type RunnerRejectionCode,
  type RunnerServerMessage,
  type ServerRunnerMessage,
} from 'shared';
import { finalizeCodexRunnerLogs } from './codex-final-message.js';
import { buildRunnerTerminalMessage } from './terminal-message.js';
import {
  PROVIDER_BINARIES,
  createExecutionPlan,
  isPolicyFailure,
  resolveProviderExecutable,
  spawnDetachedExecutionPlan,
  type DetachedExecutionProcess,
} from './executor.js';

const RUNNER_VERSION = '0.0.1';
const serverUrl = process.env.OPENWORK_SERVER_URL;
const runnerName = process.env.OPENWORK_RUNNER_NAME || os.hostname();
const workspaceRoot = process.env.OPENWORK_RUNNER_WORKSPACE_ROOT;
const configPath =
  process.env.OPENWORK_RUNNER_CONFIG ||
  path.join(os.homedir(), '.openwork-runner', 'config.json');
const stateDir =
  process.env.OPENWORK_RUNNER_STATE_DIR ||
  path.join(path.dirname(configPath), 'jobs');

interface RunnerConfig {
  serverUrl?: string;
  runnerId?: string;
  credential?: string;
}

if (!serverUrl) {
  console.error('OPENWORK_SERVER_URL is required.');
  process.exit(1);
}

interface SupervisedJob {
  jobId: string;
  runId: string;
  provider: RunnerProvider;
  pid: number | null;
  startedAt: string;
  stdoutPath: string;
  stderrPath: string;
  outputLastMessagePath?: string;
  child?: DetachedExecutionProcess;
  stdoutOffset: number;
  stderrOffset: number;
  stdoutBytes: number;
  stderrBytes: number;
  lastOutputAt?: string;
  lastOutputStream?: 'stdout' | 'stderr';
  finalizedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  finalized: boolean;
}

interface PersistedJob {
  jobId: string;
  runId: string;
  provider: SupervisedJob['provider'];
  pid: number | null;
  startedAt: string;
  stdoutPath: string;
  stderrPath: string;
  outputLastMessagePath?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  lastOutputAt?: string;
  lastOutputStream?: 'stdout' | 'stderr';
  finalizedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
}

const jobs = new Map<string, SupervisedJob>();
let activeWs: WebSocket | null = null;
const pendingServerMessages: RunnerServerMessage[] = [];
const JOB_LOG_POLL_MS = 500;

export function buildRunnerCapabilities(): RunnerCapabilities {
  const supportedProviders = Object.entries(PROVIDER_BINARIES)
    .filter(([provider]) => resolveProviderExecutable(provider as keyof typeof PROVIDER_BINARIES))
    .map(([provider]) => provider as keyof typeof PROVIDER_BINARIES);

  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    os: os.platform(),
    arch: os.arch(),
    runnerVersion: RUNNER_VERSION,
    workspaceRoot,
    supportedAgentKinds: ['dev_agent'],
    supportedProviders,
    supportsCancellation: true,
    supportsArtifacts: true,
    policy: {
      workspaceRootRequired: Boolean(workspaceRoot),
      allowedTools: supportedProviders,
      approvalModes: ['dangerous'],
      envAccess: true,
      secretAccess: true,
      network: true,
      shell: true,
    },
  };
}

function readConfig(): RunnerConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RunnerConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: RunnerConfig) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function pairWithCode(code: string): Promise<RunnerConfig> {
  const res = await fetch(new URL('/api/agent-runners/pair', serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      displayName: runnerName,
      version: RUNNER_VERSION,
      capabilities: buildRunnerCapabilities(),
    }),
  });
  if (!res.ok) {
    throw new Error(`Pairing failed with HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { runner: { id: string }; credential: string };
  const config = { serverUrl, runnerId: data.runner.id, credential: data.credential };
  writeConfig(config);
  console.log(`Paired runner ${data.runner.id}. Credential saved to ${configPath}`);
  return config;
}

function buildWebSocketUrl() {
  const config = readConfig();
  const credential = process.env.OPENWORK_RUNNER_CREDENTIAL || config.credential;
  const runnerId = process.env.OPENWORK_RUNNER_ID || config.runnerId;
  if (!credential) {
    console.error('Runner is not paired. Set OPENWORK_RUNNER_PAIRING_CODE once to pair this runner.');
    process.exit(1);
  }
  const url = new URL('/api/runners/ws', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('credential', credential);
  if (runnerId) url.searchParams.set('runnerId', runnerId);
  url.searchParams.set('name', runnerName);
  return url;
}

function send(ws: WebSocket, message: RunnerServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function sendToServer(message: RunnerServerMessage) {
  if (activeWs?.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify(message));
    return;
  }
  pendingServerMessages.push(message);
}

function flushPendingServerMessages() {
  while (activeWs?.readyState === WebSocket.OPEN && pendingServerMessages.length > 0) {
    activeWs.send(JSON.stringify(pendingServerMessages.shift()));
  }
}

function announceActiveJobs(ws: WebSocket) {
  for (const job of jobs.values()) {
    send(ws, {
      type: 'job_accepted',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: job.jobId,
      runId: job.runId,
    });
  }
}

function parseMessage(raw: WebSocket.RawData): ServerRunnerMessage | null {
  try {
    return parseServerRunnerMessage(JSON.parse(raw.toString()));
  } catch {
    return null;
  }
}

function rejectJob(
  ws: WebSocket,
  jobId: string,
  runId: string | undefined,
  code: RunnerRejectionCode,
  message: string,
) {
  const rejection = {
    type: 'job_rejected',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    jobId,
    runId,
    code,
    message,
  } as RunnerServerMessage;
  if (ws.readyState === WebSocket.OPEN) send(ws, rejection);
  else sendToServer(rejection);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function jobDir(jobId: string, runId: string): string {
  return path.join(stateDir, `${safeId(runId)}-${safeId(jobId)}`);
}

function jobStatePath(jobId: string, runId: string): string {
  return path.join(jobDir(jobId, runId), 'job.json');
}

function persistJob(job: SupervisedJob) {
  fs.mkdirSync(path.dirname(jobStatePath(job.jobId, job.runId)), { recursive: true });
  const payload: PersistedJob = {
    jobId: job.jobId,
    runId: job.runId,
    provider: job.provider,
    pid: job.pid,
    startedAt: job.startedAt,
    stdoutPath: job.stdoutPath,
    stderrPath: job.stderrPath,
    outputLastMessagePath: job.outputLastMessagePath,
    stdoutBytes: job.stdoutBytes,
    stderrBytes: job.stderrBytes,
    lastOutputAt: job.lastOutputAt,
    lastOutputStream: job.lastOutputStream,
    finalizedAt: job.finalizedAt,
    exitCode: job.exitCode,
    signal: job.signal,
  };
  fs.writeFileSync(jobStatePath(job.jobId, job.runId), `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

function removePersistedJob(job: SupervisedJob) {
  try {
    fs.rmSync(jobDir(job.jobId, job.runId), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readNewLogText(filePath: string, offset: number): { text: string; offset: number } {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return { text: '', offset: size };
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      return { text: buffer.toString('utf-8'), offset: size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', offset };
  }
}

function sendJobOutput(job: SupervisedJob, stream: 'stdout' | 'stderr', text: string) {
  if (!text) return;
  sendToServer({
    type: 'output_event',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    jobId: job.jobId,
    runId: job.runId,
    stream,
    text,
  });
}

function readNewJobOutput(job: SupervisedJob) {
  const stdout = readNewLogText(job.stdoutPath, job.stdoutOffset);
  job.stdoutOffset = stdout.offset;
  if (stdout.text) {
    job.stdoutBytes += Buffer.byteLength(stdout.text);
    job.lastOutputAt = new Date().toISOString();
    job.lastOutputStream = 'stdout';
    persistJob(job);
  }
  sendJobOutput(job, 'stdout', stdout.text);

  const stderr = readNewLogText(job.stderrPath, job.stderrOffset);
  job.stderrOffset = stderr.offset;
  if (stderr.text) {
    job.stderrBytes += Buffer.byteLength(stderr.text);
    job.lastOutputAt = new Date().toISOString();
    job.lastOutputStream = 'stderr';
    persistJob(job);
  }
  sendJobOutput(job, 'stderr', stderr.text);
}

function inferRecoveredExitCode(stdout: string, stderr: string): number | null {
  if (extractFinalResponseText(stdout)) return 0;
  if (stderr.trim()) return 1;
  return null;
}

function startPollingJob(job: SupervisedJob) {
  if (job.pollTimer) return;
  job.pollTimer = setInterval(() => {
    readNewJobOutput(job);
    if (job.child || !job.pid || isPidAlive(job.pid)) return;
    finalizeJob(job, inferRecoveredExitCode(readFile(job.stdoutPath), readFile(job.stderrPath)), null);
  }, JOB_LOG_POLL_MS);
  job.pollTimer.unref?.();
}

function stopPollingJob(job: SupervisedJob) {
  if (!job.pollTimer) return;
  clearInterval(job.pollTimer);
  job.pollTimer = null;
}

function finalizeJob(job: SupervisedJob, code: number | null, signal: NodeJS.Signals | null) {
  if (job.finalized) return;
  job.finalized = true;
  job.finalizedAt = new Date().toISOString();
  job.exitCode = code;
  job.signal = signal;
  persistJob(job);
  stopPollingJob(job);

  if (signal) {
    const diag = `[openwork-runner] child terminated by signal ${signal} (code=${code ?? 'null'}) for run ${job.runId}\n`;
    try {
      fs.appendFileSync(job.stderrPath, diag);
    } catch {
      // Best-effort diagnostic.
    }
    console.warn(diag.trim());
  }

  readNewJobOutput(job);

  const stdout = readFile(job.stdoutPath);
  const stderr = readFile(job.stderrPath);
  const lastMessage = readOutputLastMessage(job.outputLastMessagePath);
  const finalized =
    job.provider === 'codex'
      ? finalizeCodexRunnerLogs({
          runId: job.runId,
          code,
          stdout,
          stderr,
          outputLastMessagePath: job.outputLastMessagePath,
          lastMessage,
        })
      : {
          code,
          stdout,
          stderr,
          appendedFinalMessage: false,
        };

  if (finalized.stdout !== stdout) {
    const appended = finalized.stdout.startsWith(stdout)
      ? finalized.stdout.slice(stdout.length)
      : finalized.stdout;
    sendJobOutput(job, 'stdout', appended);
  }
  if (finalized.stderr !== stderr) {
    const appended = finalized.stderr.startsWith(stderr)
      ? finalized.stderr.slice(stderr.length)
      : finalized.stderr;
    sendJobOutput(job, 'stderr', appended);
  }

  sendToServer(buildRunnerTerminalMessage({
    jobId: job.jobId,
    runId: job.runId,
    provider: job.provider,
    code: finalized.code,
    stdout: finalized.stdout,
    stderr: finalized.stderr,
  }));

  jobs.delete(job.jobId);
  removePersistedJob(job);
}

function terminateJob(job: SupervisedJob) {
  if (!job.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-job.pid, 'SIGTERM');
    else process.kill(job.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(job.pid, 'SIGTERM');
    } catch {
      // Process may already be gone.
    }
  }
}

function recoverPersistedJobs() {
  if (!fs.existsSync(stateDir)) return;

  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(stateDir, entry.name, 'job.json');
    let persisted: PersistedJob;
    try {
      persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as PersistedJob;
    } catch {
      continue;
    }
    if (!persisted.jobId || !persisted.runId || !persisted.provider) continue;

    const job: SupervisedJob = {
      jobId: persisted.jobId,
      runId: persisted.runId,
      provider: persisted.provider,
      pid: persisted.pid,
      startedAt: persisted.startedAt ?? new Date().toISOString(),
      stdoutPath: persisted.stdoutPath,
      stderrPath: persisted.stderrPath,
      outputLastMessagePath: persisted.outputLastMessagePath,
      stdoutOffset: fileSize(persisted.stdoutPath),
      stderrOffset: fileSize(persisted.stderrPath),
      stdoutBytes: persisted.stdoutBytes ?? fileSize(persisted.stdoutPath),
      stderrBytes: persisted.stderrBytes ?? fileSize(persisted.stderrPath),
      lastOutputAt: persisted.lastOutputAt,
      lastOutputStream: persisted.lastOutputStream,
      finalizedAt: persisted.finalizedAt,
      exitCode: persisted.exitCode,
      signal: persisted.signal,
      pollTimer: null,
      finalized: false,
    };
    jobs.set(job.jobId, job);

    if (job.pid && isPidAlive(job.pid)) {
      startPollingJob(job);
      continue;
    }

    finalizeJob(job, inferRecoveredExitCode(readFile(job.stdoutPath), readFile(job.stderrPath)), null);
  }
}

function readOutputLastMessage(filePath: string | undefined): string {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  } finally {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

function startJob(ws: WebSocket, jobId: string, job: ServerRunnerMessage & { type: 'job_offer' }) {
  const intent = parseRunnerJobIntent(job.job);

  if (job.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
    rejectJob(
      ws,
      jobId,
      intent?.runId,
      'protocol_version_mismatch',
      `Unsupported runner protocol ${job.protocolVersion}; expected ${RUNNER_PROTOCOL_VERSION}`,
    );
    return;
  }

  if (!intent) {
    rejectJob(ws, jobId, undefined, 'invalid_job', 'Invalid or missing runner job payload');
    return;
  }

  const runId = intent.runId;
  const plan = createExecutionPlan(intent, buildRunnerCapabilities());
  if (isPolicyFailure(plan)) {
    rejectJob(ws, jobId, runId, plan.code, plan.message);
    return;
  }

  send(ws, {
    type: 'job_accepted',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    jobId,
    runId,
  });

  const dir = jobDir(jobId, runId);
  fs.mkdirSync(dir, { recursive: true });
  const stdoutPath = path.join(dir, 'stdout.log');
  const stderrPath = path.join(dir, 'stderr.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  let child: DetachedExecutionProcess;
  try {
    child = spawnDetachedExecutionPlan(plan, { stdoutFd, stderrFd });
  } catch (error) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    rejectJob(ws, jobId, runId, 'spawn_failed', (error as Error).message);
    return;
  }
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const supervised: SupervisedJob = {
    jobId,
    runId,
    provider: intent.provider,
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    outputLastMessagePath: plan.outputLastMessagePath,
    child,
    stdoutOffset: 0,
    stderrOffset: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    pollTimer: null,
    finalized: false,
  };
  jobs.set(jobId, supervised);
  persistJob(supervised);
  startPollingJob(supervised);

  child.on('error', (error) => {
    supervised.finalized = true;
    stopPollingJob(supervised);
    jobs.delete(jobId);
    removePersistedJob(supervised);
    rejectJob(ws, jobId, runId, 'spawn_failed', error.message);
  });

  child.on('close', (code, signal) => {
    finalizeJob(supervised, code, signal);
  });

  if (child.stdin) {
    child.stdin.end(plan.stdinData ?? '');
  }
}

function connect() {
  const ws = new WebSocket(buildWebSocketUrl());
  const config = readConfig();
  const runnerId = process.env.OPENWORK_RUNNER_ID || config.runnerId || '';

  ws.on('open', () => {
    activeWs = ws;
    send(ws, {
      type: 'runner_hello',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerId,
      name: runnerName,
      capabilities: buildRunnerCapabilities(),
    });
    flushPendingServerMessages();
    announceActiveJobs(ws);
    console.log(`Connected runner ${runnerId} to ${serverUrl}`);
  });

  ws.on('message', (raw) => {
    const message = parseMessage(raw);
    if (!message) return;
    if (message.type === 'server_hello') return;
    if (message.type === 'job_offer') {
      startJob(ws, message.jobId, message);
      return;
    }
    if (message.type === 'cancel') {
      const job = jobs.get(message.jobId);
      if (job) terminateJob(job);
    }
  });

  ws.on('close', (closeCode, closeReason) => {
    const inFlight = jobs.size;
    if (inFlight > 0) {
      console.warn(
        `[openwork-runner] WS closed (code=${closeCode}, reason=${closeReason?.toString() || ''}) while ${inFlight} job(s) in-flight; keeping child process(es) alive for reconnect`,
      );
    }
    if (activeWs === ws) activeWs = null;
    setTimeout(connect, 2000);
  });

  ws.on('error', (error) => {
    console.error(`Runner connection error: ${error.message}`);
  });
}

async function main() {
  const pairingCode = process.env.OPENWORK_RUNNER_PAIRING_CODE;
  const config = readConfig();
  if (pairingCode && (!config.credential || config.serverUrl !== serverUrl)) {
    await pairWithCode(pairingCode);
  }
  recoverPersistedJobs();
  connect();
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
