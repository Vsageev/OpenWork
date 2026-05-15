import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const DEFAULT_BACKEND_PORT = '3847';
const DEFAULT_POSTGRES_PORT = '5433';
const rootEnv = process.env;
const backendPort = rootEnv.PORT || DEFAULT_BACKEND_PORT;

const children = [];
let stopping = false;

function readBackendEnv() {
  try {
    return Object.fromEntries(
      readFileSync('packages/backend/.env', 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=');
          const key = line.slice(0, separator).trim();
          const value = line
            .slice(separator + 1)
            .trim()
            .replace(/^(['"])(.*)\1$/, '$2');
          return [key, value];
        }),
    );
  } catch {
    return {};
  }
}

const backendEnv = readBackendEnv();
const databaseUrl = rootEnv.DATABASE_URL || backendEnv.DATABASE_URL;

const processes = [
  {
    name: 'backend',
    args: ['--filter', 'backend', 'dev'],
    env: {
      PORT: backendPort,
    },
  },
  {
    name: 'frontend',
    args: ['--filter', 'frontend', 'dev'],
  },
  {
    name: 'landing',
    args: ['--filter', 'landing', 'dev'],
  },
  {
    name: 'widget',
    args: ['--filter', 'widget', 'dev'],
  },
];

function startProcess(definition) {
  const child = spawn('pnpm', definition.args, {
    stdio: 'inherit',
    env: {
      ...rootEnv,
      ...definition.env,
    },
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (stopping) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    console.error(`[dev] ${definition.name} exited with ${reason}; stopping dev stack.`);
    stopAll(1);
  });
}

function runCommand(name, command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...rootEnv,
        ...env,
      },
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      reject(new Error(`${name} failed with ${reason}`));
    });

    child.on('error', reject);
  });
}

function runSilent(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      env: rootEnv,
    });

    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function runOnce(name, args, env = {}) {
  return runCommand(name, 'pnpm', args, env);
}

function parseDatabaseTarget(url) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname,
      port: parsed.port || '5432',
    };
  } catch {
    return undefined;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function waitForTcpPort({ host, port, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host, port: Number(port) });
      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });

      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for Postgres at ${host}:${port}.`));
          return;
        }
        setTimeout(tryConnect, 500);
      };

      socket.on('error', retry);
      socket.on('timeout', retry);
    };

    tryConnect();
  });
}

async function ensureDockerDaemon() {
  if (await runSilent('docker', ['info'])) return;

  if (process.platform === 'darwin') {
    console.log('[dev] Docker is installed but not running; opening Docker Desktop...');
    await runSilent('open', ['-gja', 'Docker']);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (await runSilent('docker', ['info'])) return;
    }
  }

  throw new Error('Docker daemon is not running.');
}

async function ensureLocalPostgres() {
  if (rootEnv.OPENWORK_DEV_SKIP_POSTGRES === 'true') return;

  const target = parseDatabaseTarget(databaseUrl);
  if (!target || !isLocalHost(target.hostname)) return;

  const composePort = rootEnv.POSTGRES_PORT || backendEnv.POSTGRES_PORT || DEFAULT_POSTGRES_PORT;
  if (target.port !== composePort) return;

  console.log('[dev] Ensuring local Postgres is running via Docker Compose...');
  try {
    await ensureDockerDaemon();
    await runCommand('docker compose postgres', 'docker', ['compose', 'up', '-d', 'postgres']);
    await waitForTcpPort({ host: target.hostname, port: target.port });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not start local Postgres for DATABASE_URL=${databaseUrl}. Start Docker and retry, or set OPENWORK_DEV_SKIP_POSTGRES=true if you manage Postgres yourself. ${message}`,
    );
  }
}

async function migrateDatabase() {
  try {
    await runOnce('db:migrate', ['--filter', 'backend', 'db:migrate']);
  } catch (error) {
    const target = parseDatabaseTarget(databaseUrl);
    const connectionHint =
      target && isLocalHost(target.hostname)
        ? ` Ensure Postgres is reachable at ${target.hostname}:${target.port}.`
        : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}.${connectionHint}`);
  }
}

async function buildSharedPackage() {
  await runOnce('shared build', ['--filter', 'shared', 'build']);
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

console.log('[dev] Backend agent execution: remote runner required');
console.log('[dev] Building shared package...');
await buildSharedPackage();

if (rootEnv.OPENWORK_DEV_SKIP_MIGRATE === 'true') {
  console.log('[dev] Skipping database migrations because OPENWORK_DEV_SKIP_MIGRATE=true.');
} else {
  await ensureLocalPostgres();
  console.log('[dev] Applying backend database migrations...');
  await migrateDatabase();
}

console.log('[dev] Starting backend, frontend, landing, and widget...');
console.log('[dev] Start a paired runner separately from Settings -> Runners when agent execution is needed.');

for (const definition of processes) {
  startProcess(definition);
}
