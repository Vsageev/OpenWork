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
    const job = baseJob('codex');
    expect(parseRunnerJobIntent(job)).toMatchObject({
      runId: 'qa-smoke-run-1',
      provider: 'codex',
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
  });
});
