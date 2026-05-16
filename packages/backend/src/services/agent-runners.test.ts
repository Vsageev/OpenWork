import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { RUNNER_PROTOCOL_VERSION, type RunnerCapabilities, type RunnerServerMessage } from 'shared';
import {
  __runnerTestUtils,
  dispatchRemoteAgentJob,
} from './agent-runners.js';

const agentRunsMocks = vi.hoisted(() => ({
  appendAgentRunLifecycleEvent: vi.fn(),
  appendAgentRunOutput: vi.fn(),
  completeAgentRun: vi.fn(),
}));

const { appendAgentRunLifecycleEvent, appendAgentRunOutput, completeAgentRun } = agentRunsMocks;

vi.mock('./agent-runs.js', () => agentRunsMocks);

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

function addRunner(
  runnerId: string,
  ws = makeOpenSocket(),
  scope?: { userId?: string; workspaceId?: string },
) {
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
    userId: scope?.userId ?? 'user-1',
    workspaceId: scope?.workspaceId ?? 'workspace-1',
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
  appendAgentRunOutput.mockReset();
  appendAgentRunLifecycleEvent.mockReset();
  completeAgentRun.mockReset();
});

describe('structured runner job dispatch', () => {
  it('sends job_offer with RunnerJobIntent only (no legacy CLI command/argv/cwd/env on the wire)', async () => {
    const ws = makeOpenSocket();
    const runner = addRunner('runner-1', ws);

    const result = dispatchRemoteAgentJob({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      intent: {
        runId: 'run-struct-1',
        agentId: 'agent-1',
        agentKind: 'dev_agent',
        provider: 'codex',
        modelPreference: { displayName: 'Codex' },
        prompt: 'hello',
        workspace: { type: 'local_path', path: '/tmp/ws', workspaceId: 'workspace-1' },
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

    expect(ws.send).toHaveBeenCalledTimes(1);
    const raw = ws.send.mock.calls[0][0] as string;
    const payload = JSON.parse(raw) as Record<string, unknown>;

    expect(payload.type).toBe('job_offer');
    expect(payload.protocolVersion).toBe(RUNNER_PROTOCOL_VERSION);
    expect(typeof payload.jobId).toBe('string');

    const forbiddenRoot = ['command', 'argv', 'args', 'cwd', 'env', 'shell', 'executable'];
    for (const key of forbiddenRoot) {
      expect(payload).not.toHaveProperty(key);
    }

    expect(payload.job).toMatchObject({
      runId: 'run-struct-1',
      agentKind: 'dev_agent',
      provider: 'codex',
      prompt: 'hello',
    });
    const job = payload.job as Record<string, unknown>;
    for (const key of ['command', 'argv', 'args', 'cwd', 'env']) {
      expect(job).not.toHaveProperty(key);
    }
    expect(job.workspace).toEqual(
      expect.objectContaining({ type: 'local_path', path: '/tmp/ws', workspaceId: 'workspace-1' }),
    );

    const jobId = payload.jobId as string;
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'completed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: 'run-struct-1',
      code: 0,
      stdout: '',
      stderr: '',
    });
    await expect(result).resolves.toMatchObject({ code: 0 });
  });
});

describe('agent runner routing scope', () => {
  it('does not pick a runner registered to a different user', async () => {
    const otherWs = makeOpenSocket();
    addRunner('runner-other', otherWs, { userId: 'user-2', workspaceId: 'workspace-1' });

    await expect(
      dispatchRemoteAgentJob({
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
      }),
    ).rejects.toThrow(/No eligible remote agent runner is connected for this workspace/i);

    expect(otherWs.send).not.toHaveBeenCalled();
  });

  it('does not pick a runner for a different workspace', async () => {
    const ws = makeOpenSocket();
    addRunner('runner-ws2', ws, { userId: 'user-1', workspaceId: 'workspace-2' });

    await expect(
      dispatchRemoteAgentJob({
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
      }),
    ).rejects.toThrow(/No eligible remote agent runner is connected for this workspace/i);

    expect(ws.send).not.toHaveBeenCalled();
  });
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

  it('persists output events after backend in-memory job state is gone', async () => {
    const runner = addRunner('runner-1');
    const message: RunnerServerMessage = {
      type: 'output_event',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: 'lost-job',
      runId: 'run-after-restart',
      stream: 'stdout',
      text: 'still working\n',
    };

    __runnerTestUtils.handleRunnerMessage(runner, message);

    await vi.waitFor(() => {
      expect(appendAgentRunOutput).toHaveBeenCalledWith(
        'run-after-restart',
        'stdout',
        'still working\n',
      );
    });
  });

  it('tracks recovered accepted jobs so reconnecting runners are shown busy and cancellable', async () => {
    const runner = addRunner('runner-1');

    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'job_accepted',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: 'recovered-job',
      runId: 'recovered-run',
    });

    expect(runner.activeJobIds.has('recovered-job')).toBe(true);
    expect(__runnerTestUtils.jobIdByRunId.get('recovered-run')).toBe('recovered-job');

    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'completed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: 'recovered-job',
      runId: 'recovered-run',
      code: 0,
      stdout:
        '{"type":"turn.completed"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n',
      stderr: '',
    });

    expect(runner.activeJobIds.has('recovered-job')).toBe(false);
    expect(__runnerTestUtils.jobIdByRunId.has('recovered-run')).toBe(false);
    expect(__runnerTestUtils.jobRunnerById.has('recovered-job')).toBe(false);
  });

  it('finalizes recovered jobs when their runner disconnect grace expires', async () => {
    const runner = addRunner('runner-1');

    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'job_accepted',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: 'recovered-job',
      runId: 'recovered-run',
    });

    __runnerTestUtils.failJobsForDisconnectedRunner('runner-1', 'Runner runner-1 disconnected');

    expect(__runnerTestUtils.jobIdByRunId.has('recovered-run')).toBe(false);
    expect(__runnerTestUtils.jobRunnerById.has('recovered-job')).toBe(false);
  });
});
