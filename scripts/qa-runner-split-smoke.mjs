#!/usr/bin/env node
/* global console, process */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  {
    name: 'backend API/service smoke',
    files: ['packages/backend/src/qa/runner-split-smoke.test.ts'],
  },
  {
    name: 'sidebar/chat state contract',
    files: ['packages/frontend/src/pages/agent-chat-view-model.test.ts'],
  },
  {
    name: 'runner protocol contract',
    files: ['packages/shared/src/runner-protocol.smoke.test.ts'],
  },
  {
    name: 'non-Codex runner startup planning',
    files: ['packages/runner/src/executor.smoke.test.ts'],
  },
];

const startedAt = new Date();
const results = [];
const resources = [];
const reports = [];

console.log('OpenWork runner-split QA smoke');
console.log(`Started: ${startedAt.toISOString()}`);
console.log('Mode: local test layers only; no destructive live-state mutations.');
console.log('');

for (const check of checks) {
  console.log(`--- ${check.name} ---`);
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--reporter=default', ...check.files],
    {
      cwd: repoRoot,
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          NODE_ENV: 'test',
        }).filter(([key]) => key !== 'NO_COLOR' && key !== 'FORCE_COLOR'),
      ),
      encoding: 'utf8',
    },
  );

  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());

  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/qa-smoke resources:\s*(.+)$/);
    if (match) resources.push(match[1]);
    const reportMatch = line.match(/qa-smoke report:\s*(\{.+\})$/);
    if (reportMatch) {
      try {
        reports.push(JSON.parse(reportMatch[1]));
      } catch {
        reports.push({
          check: check.name,
          status: 'FAIL',
          reason: `Malformed qa-smoke report JSON: ${reportMatch[1]}`,
        });
      }
    }
  }

  results.push({
    name: check.name,
    files: check.files,
    status: result.status === 0 ? 'PASS' : 'FAIL',
    exitCode: result.status ?? 1,
  });
  console.log('');
}

const failed = results.filter((result) => result.status === 'FAIL');
console.log('Smoke report');
for (const result of results) {
  console.log(`${result.status} ${result.name} (${result.files.join(', ')})`);
}
if (resources.length > 0) {
  console.log('Resources:');
  for (const resourceLine of resources) {
    console.log(`- ${resourceLine}`);
  }
}
if (reports.length > 0) {
  console.log('Structured check evidence:');
  for (const report of reports) {
    console.log(JSON.stringify(report));
  }
}
console.log(`Started: ${startedAt.toISOString()}`);
console.log(`Finished: ${new Date().toISOString()}`);

if (failed.length > 0) {
  console.log(`Result: FAIL (${failed.length}/${results.length} checks failed)`);
  process.exitCode = 1;
} else {
  console.log(`Result: PASS (${results.length}/${results.length} checks passed)`);
}
