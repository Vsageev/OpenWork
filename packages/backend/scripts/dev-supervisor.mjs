import { spawn } from 'node:child_process';

const RESTART_DELAY_MS = 1000;
let stopping = false;
let child = null;
let restartTimer = null;

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

  child = spawn('tsx', ['watch', 'src/index.ts'], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    child = null;
    scheduleRestart(error.message);
  });

  child.on('exit', (code, signal) => {
    child = null;

    if (stopping) {
      process.exit(0);
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    scheduleRestart(reason);
  });
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

start();
