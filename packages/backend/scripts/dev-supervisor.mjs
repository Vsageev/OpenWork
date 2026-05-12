import { spawn, spawnSync } from 'node:child_process';

const RESTART_DELAY_MS = 1000;
const HEALTH_POLL_MS = 5000;
const MISSING_GRANDCHILD_GRACE_MS = 20000;
let stopping = false;
let child = null;
let restartTimer = null;
let healthTimer = null;
let lastGrandchildSeenAt = 0;

function hasLiveGrandchild(parentPid) {
  // tsx watch spawns the real app as a node grandchild. If that grandchild is
  // gone, tsx watch idles forever waiting for a file save and the app is down.
  const result = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  return result.stdout.trim().length > 0;
}

function forwardSignal(signal) {
  if (stopping) {
    return;
  }

  stopping = true;
  if (child && !child.killed) {
    child.kill(signal);
    return;
  }

  process.exit(0);
}

function scheduleRestart(reason) {
  if (stopping || restartTimer) {
    return;
  }

  console.log(`[dev-supervisor] Backend process exited with ${reason}. Restarting in ${RESTART_DELAY_MS}ms...`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    start();
  }, RESTART_DELAY_MS);
}

function start() {
  if (stopping) {
    return;
  }

  const existingNodeOptions = process.env.NODE_OPTIONS ?? '';
  const nodeOptions = /--max-old-space-size/.test(existingNodeOptions)
    ? existingNodeOptions
    : `${existingNodeOptions} --max-old-space-size=8192`.trim();

  child = spawn('tsx', ['watch', 'src/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });

  lastGrandchildSeenAt = Date.now();

  child.on('error', (error) => {
    clearHealthTimer();
    child = null;
    scheduleRestart(error.message);
  });

  child.on('exit', (code, signal) => {
    clearHealthTimer();
    child = null;

    if (stopping) {
      process.exit(0);
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    scheduleRestart(reason);
  });

  healthTimer = setInterval(() => {
    if (!child || stopping) return;
    if (hasLiveGrandchild(child.pid)) {
      lastGrandchildSeenAt = Date.now();
      return;
    }
    if (Date.now() - lastGrandchildSeenAt < MISSING_GRANDCHILD_GRACE_MS) return;
    console.log('[dev-supervisor] tsx watch has no live app process — killing to force restart.');
    clearHealthTimer();
    try {
      child.kill('SIGKILL');
    } catch {}
  }, HEALTH_POLL_MS);
}

function clearHealthTimer() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

start();
