import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { RUNNER_PROTOCOL_VERSION, type RunnerCapabilities, type RunnerServerMessage } from 'shared';
import {
  __runnerTestUtils,
  dispatchRemoteAgentJob,
} from './agent-runners.js';

const completeAgentRun = vi.fn();

vi.mock('./agent-runs.js', () => ({
  completeAgentRun,
}));

vi.mock('./runner-devices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner-devices.js')>();
  return {
    ...actual,
    noteRunnerConnected: vi.fn(),
    noteRunnerDisconnected: vi.fn(),
    noteRunnerSeen: vi.fn(),
  };
});

function makeOpenSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function addRunner(runnerId: string, ws = makeOpenSocket()) {
  const now = new Date().toISOString();
  const capabilities: RunnerCapabilities = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    os: 'test',
    arch: 'test',
    runnerVersion: 'test',
    supportedAgentKinds: ['dev_agent'],
    supportedProviders: ['codex'],
    supportsCancellation: true,
    supportsArtifacts: true,
    policy: {
      workspaceRootRequired: false,
      allowedTools: ['codex'],
      approvalModes: ['dangerous'],
      envAccess: true,
      secretAccess: true,
      network: true,
      shell: true,
    },
  };
  const runner = {
    id: runnerId,
    userId: 'user-1',
    workspaceId: 'workspace-1',
    name: 'test-runner',
    ws,
    capabilities,
    connectedAt: now,
    lastSeenAt: now,
    activeJobIds: new Set<string>(),
  };
  __runnerTestUtils.runners.set(runnerId, runner);
  return runner;
}

afterEach(() => {
  __runnerTestUtils.runners.clear();
  __runnerTestUtils.jobsById.clear();
  __runnerTestUtils.jobRunnerById.clear();
  __runnerTestUtils.jobIdByRunId.clear();
  completeAgentRun.mockReset();
});

describe('agent runner resilience', () => {
  it('keeps an in-flight job pending and reattaches it to a reconnecting runner', async () => {
    const firstSocket = makeOpenSocket();
    const firstRunner = addRunner('runner-1', firstSocket);

    const result = dispatchRemoteAgentJob({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      intent: {
        runId: 'run-1',
        agentId: 'agent-1',
        agentKind: 'dev_agent',
        provider: 'codex',
        modelPreference: { displayName: 'Codex' },
        prompt: 'hello',
        workspace: { type: 'local_path', path: '/tmp', workspaceId: 'workspace-1' },
        allowedOperations: {
          tools: ['codex'],
          approvalMode: 'dangerous',
          env: true,
          secrets: true,
          network: true,
          shell: true,
        },
      },
    });

    const offered = JSON.parse(firstSocket.send.mock.calls[0][0] as string) as { jobId: string };
    const jobId = offered.jobId;
    expect(firstRunner.activeJobIds.has(jobId)).toBe(true);

    __runnerTestUtils.runners.delete('runner-1');
    const secondRunner = addRunner('runner-1');
    __runnerTestUtils.reattachInFlightJobsToRunner(secondRunner);

    expect(secondRunner.activeJobIds.has(jobId)).toBe(true);

    __runnerTestUtils.handleRunnerMessage(secondRunner, {
      type: 'completed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: 'run-1',
      code: 0,
      stdout:
        '{"type":"turn.completed"}\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n',
      stderr: '',
    });

    await expect(result).resolves.toMatchObject({ code: 0 });
    expect(__runnerTestUtils.jobIdByRunId.has('run-1')).toBe(false);
  });

  it('finalizes a terminal message after backend in-memory job state is gone', async () => {
    const runner = addRunner('runner-1');
    const message: RunnerServerMessage = {
      type: 'completed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: 'lost-job',
      runId: 'run-after-restart',
      code: 0,
      stdout:
        '{"type":"turn.completed"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n',
      stderr: '',
    };

    __runnerTestUtils.handleRunnerMessage(runner, message);
    await vi.waitFor(() => {
      expect(completeAgentRun).toHaveBeenCalledWith('run-after-restart', null, {
        stdout: message.stdout,
        stderr: '',
      });
    });
  });
});
