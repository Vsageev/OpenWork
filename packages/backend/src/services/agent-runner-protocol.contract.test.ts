import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { RUNNER_PROTOCOL_VERSION, parseRunnerServerMessage, type RunnerCapabilities } from 'shared';
import {
  __runnerTestUtils,
  dispatchRemoteAgentJob,
} from './agent-runners.js';
import { agentRunRoutes } from '../routes/agent-runs.js';
import { cardRoutes } from '../routes/cards.js';
import { completeAgentRun, createAgentRun, getAgentRun } from './agent-runs.js';

type RecordMap = Map<string, Map<string, Record<string, unknown>>>;

const mocks = vi.hoisted(() => {
  const records: RecordMap = new Map();

  function collection(name: string) {
    let map = records.get(name);
    if (!map) {
      map = new Map();
      records.set(name, map);
    }
    return map;
  }

  const store = {
    reset() {
      records.clear();
    },
    getAll(name: string) {
      return [...collection(name).values()];
    },
    getById(name: string, id: string) {
      return collection(name).get(id) ?? null;
    },
    insert(name: string, data: Record<string, unknown>) {
      const now = new Date().toISOString();
      const generatedId = `00000000-0000-4000-8000-${String(collection(name).size + 1).padStart(12, '0')}`;
      const record = {
        ...data,
        id: typeof data.id === 'string' ? data.id : generatedId,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now,
      };
      collection(name).set(String(record.id), record);
      return record;
    },
    update(name: string, id: string, data: Record<string, unknown>) {
      const existing = collection(name).get(id);
      if (!existing) return null;
      const record = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
      collection(name).set(id, record);
      return record;
    },
    async transaction<T>(operation: () => T | Promise<T>) {
      return operation();
    },
    async lockAgentChatQueueConversation() {},
    async lockAgentRunRowForUpdate() {},
    async reload() {},
    async flush() {},
  };

  return { store };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/connection.js', () => ({ store: mocks.store }));

function makeOpenSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function addRunner(runnerId: string, ws = makeOpenSocket(), caps?: Partial<RunnerCapabilities>) {
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
    ...caps,
  };
  const runner = {
    id: runnerId,
    userId: 'user-contract',
    workspaceId: 'ws-contract',
    name: 'contract-runner',
    ws,
    capabilities,
    connectedAt: now,
    lastSeenAt: now,
    activeJobIds: new Set<string>(),
  };
  __runnerTestUtils.runners.set(runnerId, runner);
  return runner;
}

function readOfferedJobId(ws: WebSocket & { send: ReturnType<typeof vi.fn> }): string {
  const raw = ws.send.mock.calls[0]?.[0];
  expect(typeof raw).toBe('string');
  const payload = JSON.parse(raw as string) as { jobId: string };
  return payload.jobId;
}

async function buildContractApi() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = { sub: 'user-contract' };
  });
  await app.register(agentRunRoutes);
  await app.register(cardRoutes);
  return app;
}

afterEach(() => {
  __runnerTestUtils.runners.clear();
  __runnerTestUtils.jobsById.clear();
  __runnerTestUtils.jobRunnerById.clear();
  __runnerTestUtils.jobIdByRunId.clear();
});

describe('runner protocol → agent_runs + card comment contract', () => {
  it('buffers output_event + final_message before completed, merges for persistence, and exposes API-shaped evidence', async () => {
    mocks.store.reset();
    const ids = {
      agent: 'qa-contract-agent',
      collection: 'qa-contract-collection',
      card: '00000000-0000-4000-8000-00000000aa01',
      run: 'qa-contract-run-happy',
    };
    mocks.store.insert('agents', {
      id: ids.agent,
      name: 'contract agent',
      model: 'codex',
      modelId: 'gpt-test',
      status: 'active',
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: 'contract collection',
    });
    mocks.store.insert('cards', {
      id: ids.card,
      collectionId: ids.collection,
      name: 'contract card',
      description: '',
    });

    createAgentRun({
      id: ids.run,
      agentId: ids.agent,
      agentName: 'contract agent',
      model: 'codex',
      modelId: 'gpt-test',
      triggerType: 'card_assignment',
      cardId: ids.card,
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);

    const ws = makeOpenSocket();
    const runner = addRunner('runner-contract-1', ws);
    const finalAnswer = [
      'QA_RUNNER_PROTOCOL_CONTRACT_OK',
      '',
      'Verification commands/API checks used:',
      '- pnpm --filter backend test -- src/services/agent-runner-protocol.contract.test.ts',
      `- GET /api/agent-runs/${ids.run}`,
      `- GET /api/cards/${ids.card}/comments`,
    ].join('\n');

    const jobPromise = dispatchRemoteAgentJob({
      userId: 'user-contract',
      workspaceId: 'ws-contract',
      intent: {
        runId: ids.run,
        agentId: ids.agent,
        agentKind: 'dev_agent',
        provider: 'codex',
        modelPreference: { displayName: 'Codex' },
        prompt: 'hi',
        workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-contract' },
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

    const jobId = readOfferedJobId(ws);
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'job_accepted',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: ids.run,
    });
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'output_event',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: ids.run,
      stream: 'stdout',
      text: `${JSON.stringify({ type: 'turn.completed' })}\n`,
    });
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'final_message',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: ids.run,
      text: finalAnswer,
    });
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'completed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: ids.run,
      code: 0,
      stdout: JSON.stringify({ type: 'turn.started' }),
      stderr: '',
    });

    const remote = await jobPromise;
    expect(remote.stdout).toContain('openwork_final_message');
    expect(remote.stdout).toContain('turn.completed');

    await completeAgentRun(ids.run, null, { stdout: remote.stdout, stderr: remote.stderr });
    const run = getAgentRun(ids.run) as Record<string, unknown> | null;
    expect(run).toMatchObject({
      id: ids.run,
      status: 'completed',
      triggerType: 'card_assignment',
      agentId: ids.agent,
      cardId: ids.card,
      responseText: finalAnswer,
    });

    const comment = mocks.store
      .getAll('cardComments')
      .find((c: Record<string, unknown>) => c.agentRunId === ids.run && c.cardId === ids.card);
    expect(comment).toMatchObject({ authorId: ids.agent, agentRunId: ids.run });
    expect(String(comment?.content ?? '')).toContain(finalAnswer);
    expect(String(comment?.content ?? '')).toContain(`GET /api/agent-runs/${ids.run}`);

    const app = await buildContractApi();
    try {
      const runRes = await app.inject({ method: 'GET', url: `/api/agent-runs/${ids.run}` });
      expect(runRes.statusCode).toBe(200);
      expect(runRes.json()).toMatchObject({
        id: ids.run,
        triggerType: 'card_assignment',
        agentId: ids.agent,
        cardId: ids.card,
        status: 'completed',
      });
      const commentsRes = await app.inject({ method: 'GET', url: `/api/cards/${ids.card}/comments` });
      expect(commentsRes.statusCode).toBe(200);
      const apiComment = commentsRes
        .json()
        .entries.find((e: Record<string, unknown>) => e.agentRunId === ids.run);
      expect(apiComment?.content).toContain(finalAnswer);
    } finally {
      await app.close();
    }
  });

  it('negative: omits final_message so completion lacks extractable final answer and card run becomes error with evidence', async () => {
    mocks.store.reset();
    const ids = {
      agent: 'qa-contract-agent-neg',
      collection: 'qa-contract-collection-neg',
      card: '00000000-0000-4000-8000-00000000aa02',
      run: 'qa-contract-run-no-final',
    };
    mocks.store.insert('agents', {
      id: ids.agent,
      name: 'contract agent neg',
      model: 'codex',
      modelId: 'gpt-test',
      status: 'active',
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: 'contract collection neg',
    });
    mocks.store.insert('cards', {
      id: ids.card,
      collectionId: ids.collection,
      name: 'contract card neg',
      description: '',
    });
    createAgentRun({
      id: ids.run,
      agentId: ids.agent,
      agentName: 'contract agent neg',
      model: 'codex',
      modelId: 'gpt-test',
      triggerType: 'card_assignment',
      cardId: ids.card,
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);

    const ws = makeOpenSocket();
    const runner = addRunner('runner-contract-neg', ws);
    const jobPromise = dispatchRemoteAgentJob({
      userId: 'user-contract',
      workspaceId: 'ws-contract',
      intent: {
        runId: ids.run,
        agentId: ids.agent,
        agentKind: 'dev_agent',
        provider: 'codex',
        modelPreference: { displayName: 'Codex' },
        prompt: 'hi',
        workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-contract' },
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
    const jobId = readOfferedJobId(ws);
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'output_event',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: ids.run,
      stream: 'stdout',
      text: `${JSON.stringify({ type: 'turn.completed' })}\n`,
    });
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'completed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: ids.run,
      code: 0,
      stdout: '',
      stderr: '',
    });
    const remote = await jobPromise;
    await completeAgentRun(ids.run, null, { stdout: remote.stdout, stderr: remote.stderr });
    const run = getAgentRun(ids.run) as Record<string, unknown> | null;
    expect(run?.status).toBe('error');
    expect(String(run?.errorMessage ?? '')).toMatch(/Agent run completed without a final response/i);
    const comment = mocks.store
      .getAll('cardComments')
      .find((c: Record<string, unknown>) => c.agentRunId === ids.run);
    expect(comment).toBeTruthy();
    expect(String(comment?.content ?? '')).toMatch(/Agent run completed without a final response/i);
  });

  it('rejects dispatch before spawn when runner lacks provider support (no job_offer sent)', async () => {
    mocks.store.reset();
    const ws = makeOpenSocket();
    addRunner('runner-claude-only', ws, { supportedProviders: ['claude'] });
    await expect(
      dispatchRemoteAgentJob({
        userId: 'user-contract',
        workspaceId: 'ws-contract',
        intent: {
          runId: 'run-x',
          agentId: 'a1',
          agentKind: 'dev_agent',
          provider: 'codex',
          modelPreference: { displayName: 'Codex' },
          prompt: 'hi',
          workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-contract' },
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
    ).rejects.toThrow(/No eligible remote agent runner supports codex/i);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('malformed terminal JSON is ignored; job_rejected still surfaces as dispatch failure', async () => {
    mocks.store.reset();
    const ws = makeOpenSocket();
    const runner = addRunner('runner-malformed', ws);
    const p = dispatchRemoteAgentJob(
      {
        userId: 'user-contract',
        workspaceId: 'ws-contract',
        timeoutMs: 5_000,
        intent: {
          runId: 'run-malformed',
          agentId: 'a1',
          agentKind: 'dev_agent',
          provider: 'codex',
          modelPreference: { displayName: 'Codex' },
          prompt: 'hi',
          workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-contract' },
          allowedOperations: {
            tools: ['codex'],
            approvalMode: 'dangerous',
            env: true,
            secrets: true,
            network: true,
            shell: true,
          },
        },
      },
      {},
    );
    const jobId = readOfferedJobId(ws);
    __runnerTestUtils.handleRunnerMessage(runner, parseRunnerServerMessage({ not: 'a message' }));
    expect(__runnerTestUtils.jobsById.has(jobId)).toBe(true);
    __runnerTestUtils.handleRunnerMessage(runner, {
      type: 'job_rejected',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId,
      runId: 'run-malformed',
      code: 'invalid_job',
      message: 'bad payload',
    });
    await expect(p).rejects.toThrow(/invalid_job/);
  });
});
