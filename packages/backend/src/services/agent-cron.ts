import cron from 'node-cron';
import { listAgents, getAgent } from './agents.js';
import { executeCronTask } from './agent-chat.js';

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
}

export interface CronJobWithNextRun extends CronJob {
  nextRunAt: string | null;
}

interface RunningCronTask {
  task: cron.ScheduledTask;
  signature: string;
}

// Map keyed by `{agentId}:{jobId}` → running scheduled task with job signature
const runningTasks = new Map<string, RunningCronTask>();

function taskKey(agentId: string, jobId: string): string {
  return `${agentId}:${jobId}`;
}

function jobSignature(job: Pick<CronJob, 'cron' | 'prompt'>): string {
  return JSON.stringify({ cron: job.cron, prompt: job.prompt });
}

function normalizeCronExpression(cronExpr: string): string {
  return cronExpr.trim();
}

function getTaskNextRunAt(task: cron.ScheduledTask): string | null {
  const nextRun = task.getNextRun();
  return nextRun ? nextRun.toISOString() : null;
}

function getCronJobNextRunAt(agentId: string, job: CronJob): string | null {
  if (!job.enabled) return null;

  const cronExpr = normalizeCronExpression(job.cron);
  if (!cron.validate(cronExpr)) return null;

  const running = runningTasks.get(taskKey(agentId, job.id));
  if (!running) return null;
  if (running.signature !== jobSignature({ ...job, cron: cronExpr })) return null;

  return getTaskNextRunAt(running.task);
}

export function listAgentCronJobsWithNextRun(
  agentId: string,
  cronJobs: CronJob[],
): CronJobWithNextRun[] {
  return cronJobs.map((job) => ({
    ...job,
    nextRunAt: getCronJobNextRunAt(agentId, job),
  }));
}

function stopTask(key: string, running: RunningCronTask): void {
  try {
    running.task.stop();
  } catch (err) {
    console.error(`Failed to stop agent cron task ${key}:`, err);
  } finally {
    runningTasks.delete(key);
  }
}

/**
 * Sync running cron tasks for a specific agent.
 * Stops removed/disabled jobs, starts new/enabled ones.
 */
export function syncAgentCronJobs(agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent) {
    stopAllAgentCronJobs(agentId);
    return;
  }
  const cronJobs: CronJob[] = agent.cronJobs ?? [];

  // Build expected active jobs keyed by task key
  const expectedJobs = new Map<string, { job: CronJob; signature: string }>();
  for (const job of cronJobs) {
    if (!job.enabled) continue;
    const cronExpr = normalizeCronExpression(job.cron);
    if (!cron.validate(cronExpr)) {
      console.warn(`Skipping invalid cron expression for agent ${agentId}, job ${job.id}: ${job.cron}`);
      continue;
    }

    const normalizedJob: CronJob = { ...job, cron: cronExpr };
    const key = taskKey(agentId, normalizedJob.id);
    if (expectedJobs.has(key)) {
      console.warn(`Duplicate cron job id detected for agent ${agentId}: ${normalizedJob.id}. Keeping first occurrence.`);
      continue;
    }
    expectedJobs.set(key, { job: normalizedJob, signature: jobSignature(normalizedJob) });
  }

  // Stop tasks that are no longer needed
  for (const [key, running] of runningTasks.entries()) {
    if (!key.startsWith(`${agentId}:`)) continue;
    if (!expectedJobs.has(key)) {
      stopTask(key, running);
    }
  }

  // Start new tasks and reload tasks whose cron/prompt changed
  for (const [key, expected] of expectedJobs.entries()) {
    const existing = runningTasks.get(key);
    if (existing && existing.signature === expected.signature) {
      continue; // already running with current config
    }

    if (existing) {
      stopTask(key, existing);
    }

    try {
      const task = cron.schedule(expected.job.cron, () => {
        try {
          executeCronTask(agentId, { id: expected.job.id, prompt: expected.job.prompt });
        } catch (err) {
          console.error(`Agent cron execution failed for ${key}:`, err);
        }
      });
      runningTasks.set(key, { task, signature: expected.signature });
    } catch (err) {
      console.error(`Failed to schedule agent cron job ${key}:`, err);
    }
  }
}

/**
 * Stop all cron jobs for a specific agent (used on agent deletion).
 */
export function stopAllAgentCronJobs(agentId: string): void {
  for (const [key, running] of runningTasks.entries()) {
    if (key.startsWith(`${agentId}:`)) {
      stopTask(key, running);
    }
  }
}

export function shutdownAgentCronJobs(): void {
  for (const [key, running] of runningTasks.entries()) {
    stopTask(key, running);
  }
}

/**
 * Initialize cron jobs for all agents on app startup.
 */
export function initAllCronJobs(): void {
  const agents = listAgents();
  for (const agent of agents) {
    try {
      const cronJobs = agent.cronJobs;
      if (cronJobs && cronJobs.length > 0) {
        syncAgentCronJobs(agent.id);
      }
    } catch (err) {
      console.error(`Failed to initialize cron jobs for agent ${agent.id}:`, err);
    }
  }
}
