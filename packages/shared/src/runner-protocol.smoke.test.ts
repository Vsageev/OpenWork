import { describe, expect, it } from 'vitest';
import {
  RUNNER_PROTOCOL_VERSION,
  parseRunnerJobIntent,
  parseRunnerServerMessage,
  parseServerRunnerMessage,
  type RunnerJobIntent,
} from './runner-protocol.js';

function baseJob(provider: RunnerJobIntent['provider']): RunnerJobIntent {
  return {
    runId: 'qa-smoke-run-1',
    agentId: 'qa-smoke-agent-1',
    agentKind: 'dev_agent',
    provider,
    modelPreference: {
      displayName: provider,
      modelId: `${provider}-model`,
      thinkingLevel: null,
    },
    prompt: 'qa runner protocol smoke',
    workspace: {
      type: 'local_path',
      path: process.cwd(),
      workspaceId: 'qa-smoke-workspace-1',
    },
    allowedOperations: {
      tools: [provider],
      approvalMode: 'never',
      env: false,
      secrets: false,
      network: false,
      shell: false,
    },
  };
}

describe('runner protocol smoke', () => {
  it('accepts the current server-to-runner job offer shape', () => {
    const job = {
      ...baseJob('codex'),
      attachments: [
        {
          type: 'file' as const,
          path: '/tmp/context.txt',
          filename: 'context.txt',
          mimeType: 'text/plain',
          sizeBytes: 12,
          textExtraction: {
            status: 'available' as const,
            textPath: '/tmp/context.txt',
            charCount: 12,
            truncated: false,
          },
          manifest: { storagePath: '/chat-uploads/context.txt' },
        },
      ],
    };
    expect(parseRunnerJobIntent(job)).toMatchObject({
      runId: 'qa-smoke-run-1',
      provider: 'codex',
      attachments: [
        {
          filename: 'context.txt',
          mimeType: 'text/plain',
          sizeBytes: 12,
          textExtraction: { status: 'available' },
          manifest: { storagePath: '/chat-uploads/context.txt' },
        },
      ],
    });
    expect(
      parseServerRunnerMessage({
        type: 'job_offer',
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        jobId: 'qa-smoke-job-1',
        job,
      }),
    ).toMatchObject({ type: 'job_offer', jobId: 'qa-smoke-job-1' });
  });

  it('accepts runner lifecycle messages and rejects malformed payloads', () => {
    expect(
      parseRunnerServerMessage({
        type: 'runner_hello',
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerId: 'qa-smoke-runner-1',
        name: 'qa smoke runner',
        capabilities: {
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          os: 'darwin',
          arch: 'arm64',
          runnerVersion: '0.0.0-smoke',
          supportedAgentKinds: ['dev_agent'],
          supportedProviders: ['codex'],
          supportsCancellation: true,
          supportsArtifacts: false,
          policy: {
            workspaceRootRequired: true,
            allowedTools: ['codex'],
            approvalModes: ['never'],
            envAccess: false,
            secretAccess: false,
            network: false,
            shell: false,
          },
        },
      }),
    ).toMatchObject({ type: 'runner_hello', runnerId: 'qa-smoke-runner-1' });

    expect(
      parseServerRunnerMessage({ type: 'job_offer', protocolVersion: RUNNER_PROTOCOL_VERSION }),
    ).toBeNull();
    expect(parseRunnerJobIntent({ ...baseJob('codex'), provider: 42 })).toBeNull();
    expect(
      parseRunnerJobIntent({
        ...baseJob('codex'),
        attachments: [{ type: 'file', path: '/tmp/shallow.txt' }],
      }),
    ).toBeNull();
  });

  it('accepts every runner→server protocol message shape for the current protocol version', () => {
    const base = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: 'job-1',
      runId: 'run-1',
    };
    expect(parseRunnerServerMessage({ type: 'job_accepted', ...base })).toMatchObject({ type: 'job_accepted' });
    expect(
      parseRunnerServerMessage({
        type: 'job_rejected',
        ...base,
        code: 'unsupported_provider',
        message: 'no codex',
      }),
    ).toMatchObject({ type: 'job_rejected', code: 'unsupported_provider' });
    expect(
      parseRunnerServerMessage({
        type: 'output_event',
        ...base,
        stream: 'stdout',
        text: 'chunk',
      }),
    ).toMatchObject({ type: 'output_event', stream: 'stdout' });
    expect(
      parseRunnerServerMessage({
        type: 'output_event',
        ...base,
        stream: 'stderr',
        text: 'err',
      }),
    ).toMatchObject({ type: 'output_event', stream: 'stderr' });
    expect(
      parseRunnerServerMessage({
        type: 'final_message',
        ...base,
        text: 'done',
      }),
    ).toMatchObject({ type: 'final_message', text: 'done' });
    expect(
      parseRunnerServerMessage({
        type: 'artifact',
        ...base,
        artifact: { name: 'log', path: '/tmp/a', mimeType: 'text/plain' },
      }),
    ).toMatchObject({ type: 'artifact', artifact: { name: 'log' } });
    expect(
      parseRunnerServerMessage({
        type: 'completed',
        ...base,
        code: 0,
        stdout: '',
        stderr: '',
      }),
    ).toMatchObject({ type: 'completed', code: 0 });
    expect(
      parseRunnerServerMessage({
        type: 'failed',
        ...base,
        code: 1,
        message: 'boom',
        stdout: '',
        stderr: 'e',
      }),
    ).toMatchObject({ type: 'failed', message: 'boom' });
    expect(
      parseRunnerServerMessage({
        type: 'cancelled',
        ...base,
        message: 'user',
        stdout: '',
        stderr: '',
      }),
    ).toMatchObject({ type: 'cancelled' });
    expect(
      parseRunnerServerMessage({
        type: 'cancelled',
        ...base,
        stdout: '',
        stderr: '',
      }),
    ).toMatchObject({ type: 'cancelled' });
    expect(
      parseRunnerServerMessage({
        type: 'protocol_error',
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        code: 'invalid_job',
        message: 'bad',
      }),
    ).toMatchObject({ type: 'protocol_error' });
  });

  it('rejects malformed runner→server payloads (negative control for schema validation)', () => {
    const base = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: 'job-1',
      runId: 'run-1',
    };
    expect(parseRunnerServerMessage({ ...base, type: 'job_accepted', protocolVersion: '0.0' })).toBeNull();
    expect(parseRunnerServerMessage({ type: 'job_rejected', ...base, code: 1, message: 'x' })).toBeNull();
    expect(parseRunnerServerMessage({ type: 'output_event', ...base, stream: 'stdin', text: 'x' })).toBeNull();
    expect(parseRunnerServerMessage({ type: 'final_message', ...base, text: 1 })).toBeNull();
    expect(parseRunnerServerMessage({ type: 'artifact', ...base, artifact: { name: 'n' } })).toBeNull();
    expect(parseRunnerServerMessage({ type: 'completed', ...base, code: '0', stdout: '', stderr: '' })).toBeNull();
    expect(parseRunnerServerMessage({ type: 'failed', ...base, code: 1, message: 2, stdout: '', stderr: '' })).toBeNull();
    expect(parseRunnerServerMessage({ type: 'cancelled', ...base, stdout: 1, stderr: '' })).toBeNull();
  });
});
