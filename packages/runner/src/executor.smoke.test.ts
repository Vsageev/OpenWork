import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_PROTOCOL_VERSION, type RunnerCapabilities, type RunnerJobIntent } from 'shared';
import {
  PROVIDER_BINARIES,
  createExecutionPlan,
  inferProvider,
  isPolicyFailure,
  spawnDetachedExecutionPlan,
  spawnExecutionPlan,
} from './executor.js';

const providers = ['claude', 'qwen', 'cursor', 'opencode'] as const;
const allProviders = ['claude', 'codex', 'qwen', 'cursor', 'opencode'] as const;
let tmpDir = '';
let originalPath = '';

function makeExecutable(name: string) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
}

function baseCapabilities(provider: RunnerJobIntent['provider']): RunnerCapabilities {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    os: process.platform,
    arch: process.arch,
    runnerVersion: '0.0.0-smoke',
    workspaceRoot: tmpDir,
    supportedAgentKinds: ['dev_agent'],
    supportedProviders: [provider],
    supportsCancellation: true,
    supportsArtifacts: false,
    policy: {
      workspaceRootRequired: true,
      allowedTools: [provider],
      approvalModes: ['never', 'dangerous'],
      envAccess: true,
      secretAccess: false,
      network: false,
      shell: false,
    },
  };
}

function baseJob(provider: RunnerJobIntent['provider']): RunnerJobIntent {
  return {
    runId: `qa-smoke-${provider}-run`,
    agentId: 'qa-smoke-agent',
    agentKind: 'dev_agent',
    provider,
    modelPreference: {
      displayName: provider,
      modelId: `${provider}-model`,
      thinkingLevel: provider === 'claude' ? 'medium' : null,
    },
    prompt: `qa non-codex startup smoke for ${provider}`,
    workspace: {
      type: 'local_path',
      path: tmpDir,
      workspaceId: 'qa-smoke-workspace',
    },
    allowedOperations: {
      tools: [provider],
      approvalMode: 'never',
      env: true,
      secrets: false,
      network: false,
      shell: false,
    },
    environment: {
      variables: [{ name: 'QA_SMOKE', value: provider, source: 'runtime', secret: false }],
    },
  };
}

describe('non-Codex runner startup smoke', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwork-runner-smoke-'));
    originalPath = process.env.PATH ?? '';
    for (const provider of allProviders) makeExecutable(PROVIDER_BINARIES[provider]);
    process.env.PATH = `${tmpDir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(providers)('builds an executable startup plan for %s', (provider) => {
    expect(inferProvider(`${provider}-latest`)).toBe(provider);
    const plan = createExecutionPlan(baseJob(provider), baseCapabilities(provider));

    expect(isPolicyFailure(plan)).toBe(false);
    if (isPolicyFailure(plan)) return;
    expect(plan.cwd).toBe(tmpDir);
    expect(plan.env.QA_SMOKE).toBe(provider);
    expect(plan.command.bin).toBe(path.join(tmpDir, PROVIDER_BINARIES[provider]));
    expect(plan.command.args.join(' ')).toContain('qa non-codex startup smoke');
  });

  it('writes Codex final responses to a runner-owned last-message file', () => {
    const plan = createExecutionPlan(baseJob('codex'), baseCapabilities('codex'));

    expect(isPolicyFailure(plan)).toBe(false);
    if (isPolicyFailure(plan)) return;
    expect(plan.outputLastMessagePath).toContain('openwork-runner');
    expect(plan.outputLastMessagePath).toContain('qa-smoke-codex-run');
    expect(plan.command.args).toContain('--json');
    expect(plan.command.args).toContain('--output-last-message');
    expect(plan.command.args).toContain(plan.outputLastMessagePath);
  });

  it('includes full attachment metadata in prompts and passes OpenCode files natively', () => {
    const imagePath = path.join(tmpDir, 'diagram.png');
    const filePath = path.join(tmpDir, 'context.txt');
    fs.writeFileSync(imagePath, 'fake image');
    fs.writeFileSync(filePath, 'hello runner');

    const plan = createExecutionPlan(
      {
        ...baseJob('opencode'),
        attachments: [
          {
            type: 'image',
            path: imagePath,
            filename: 'diagram.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            textExtraction: { status: 'not_applicable' },
            manifest: { storagePath: '/chat-uploads/diagram.png' },
          },
          {
            type: 'file',
            path: filePath,
            filename: 'context.txt',
            mimeType: 'text/plain',
            sizeBytes: 12,
            textExtraction: {
              status: 'available',
              textPath: filePath,
              charCount: 12,
              truncated: false,
            },
            manifest: { storagePath: '/chat-uploads/context.txt' },
          },
        ],
      },
      baseCapabilities('opencode'),
    );

    expect(isPolicyFailure(plan)).toBe(false);
    if (isPolicyFailure(plan)) return;
    expect(plan.command.args).toContain('--file');
    expect(plan.command.args).toContain(imagePath);
    expect(plan.command.args).toContain(filePath);
    const prompt = plan.command.args.at(-1) ?? '';
    expect(prompt).toContain('Attachments:');
    expect(prompt).toContain('filename');
    expect(prompt).toContain('context.txt');
    expect(prompt).toContain('mimeType: text/plain');
    expect(prompt).toContain('sizeBytes: 12');
    expect(prompt).toContain('textExtraction: status=available');
    expect(prompt).toContain('manifest: {"storagePath":"/chat-uploads/context.txt"}');
  });

  it('does not open stdin for Codex prompt-only jobs', async () => {
    const plan = createExecutionPlan(baseJob('codex'), baseCapabilities('codex'));

    expect(isPolicyFailure(plan)).toBe(false);
    if (isPolicyFailure(plan)) return;

    const child = spawnExecutionPlan(plan);
    expect(child.stdin).toBeNull();
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => resolve());
    });
  });

  it('can run a detached plan with file-backed stdout and stderr', async () => {
    fs.writeFileSync(
      path.join(tmpDir, PROVIDER_BINARIES.codex),
      '#!/bin/sh\nprintf "detached stdout\\n"\nprintf "detached stderr\\n" >&2\nexit 0\n',
    );
    fs.chmodSync(path.join(tmpDir, PROVIDER_BINARIES.codex), 0o755);
    const stdoutPath = path.join(tmpDir, 'detached-stdout.log');
    const stderrPath = path.join(tmpDir, 'detached-stderr.log');
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');
    const plan = createExecutionPlan(baseJob('codex'), baseCapabilities('codex'));

    expect(isPolicyFailure(plan)).toBe(false);
    if (isPolicyFailure(plan)) return;

    const child = spawnDetachedExecutionPlan(plan, { stdoutFd, stderrFd });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => resolve());
    });

    expect(fs.readFileSync(stdoutPath, 'utf-8')).toBe('detached stdout\n');
    expect(fs.readFileSync(stderrPath, 'utf-8')).toBe('detached stderr\n');
  });

  it('rejects an unsupported runner capability with explicit evidence', () => {
    const job = baseJob('qwen');
    const capabilities = baseCapabilities('codex');
    const plan = createExecutionPlan(job, capabilities);

    expect(isPolicyFailure(plan)).toBe(true);
    if (!isPolicyFailure(plan)) return;
    expect(plan).toMatchObject({
      code: 'unsupported_provider',
      message: 'Unsupported provider: qwen',
    });
    console.info(
      `qa-smoke report: ${JSON.stringify({ check: 'unsupported runner capability negative control', status: 'PASS', reason: plan.message, ids: { runId: job.runId, provider: job.provider } })}`,
    );
  });
});
