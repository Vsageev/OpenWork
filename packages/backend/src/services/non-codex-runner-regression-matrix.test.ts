/**
 * Card-driven regression matrix: non-Codex `RunnerProvider` values must complete through the
 * remote runner protocol, persist terminal `agent_runs`, emit automatic card comments, and
 * expose the same fields over HTTP as Codex runs.
 *
 * Matrix rows are logged as JSON for CI / independent checker grep (`qa-non-codex-matrix-row`).
 */
import Fastify, { type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerCapabilities,
  type RunnerProvider,
} from 'shared';
import { __runnerTestUtils, dispatchRemoteAgentJob } from './agent-runners.js';
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

const NON_CODEX_PROVIDERS = ['claude', 'qwen', 'cursor', 'opencode'] as const satisfies readonly RunnerProvider[];

const MATRIX_CARD_IDS: Record<(typeof NON_CODEX_PROVIDERS)[number], string> = {
  claude: '00000000-0000-4000-8000-0000000000c1',
  qwen: '00000000-0000-4000-8000-0000000000c2',
  cursor: '00000000-0000-4000-8000-0000000000c3',
  opencode: '00000000-0000-4000-8000-0000000000c4',
};

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
    userId: 'user-matrix',
    workspaceId: 'ws-matrix',
    name: 'matrix-runner',
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

async function buildMatrixApi() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    request.user = { sub: 'user-matrix' };
  });
  await app.register(agentRunRoutes);
  await app.register(cardRoutes);
  return app;
}

function logMatrixRow(row: Record<string, unknown>) {
  console.info(`qa-non-codex-matrix-row: ${JSON.stringify(row)}`);
}

afterEach(() => {
  __runnerTestUtils.runners.clear();
  __runnerTestUtils.jobsById.clear();
  __runnerTestUtils.jobRunnerById.clear();
  __runnerTestUtils.jobIdByRunId.clear();
});

describe('non-Codex runner regression matrix (protocol → run → card comment → HTTP)', () => {
  it.each(NON_CODEX_PROVIDERS)(
    'provider %s: remote job completes, extracts final answer, persists linked card comment, GET /api/agent-runs + /comments contract',
    async (provider) => {
      mocks.store.reset();
      const ids = {
        agent: `qa-matrix-agent-${provider}`,
        collection: 'qa-matrix-collection',
        card: MATRIX_CARD_IDS[provider],
        run: `qa-matrix-run-${provider}`,
      };
      mocks.store.insert('agents', {
        id: ids.agent,
        name: `[qa-matrix] ${provider}`,
        model: `${provider}-latest`,
        modelId: `${provider}-model-id`,
        status: 'active',
      });
      mocks.store.insert('collections', {
        id: ids.collection,
        name: 'qa matrix collection',
      });
      mocks.store.insert('cards', {
        id: ids.card,
        collectionId: ids.collection,
        name: `[qa-matrix] ${provider} card`,
        description: '',
      });

      createAgentRun({
        id: ids.run,
        agentId: ids.agent,
        agentName: `[qa-matrix] ${provider}`,
        model: `${provider}-latest`,
        modelId: `${provider}-model-id`,
        triggerType: 'card_assignment',
        cardId: ids.card,
        executor: 'remote',
        status: 'running',
      } as Parameters<typeof createAgentRun>[0]);

      const ws = makeOpenSocket();
      addRunner(`runner-matrix-${provider}`, ws, { supportedProviders: [provider] });
      const finalAnswer = [
        `QA_MATRIX_${provider.toUpperCase()}_OK`,
        '',
        'Verification commands/API checks used:',
        `- pnpm --filter backend test -- src/services/non-codex-runner-regression-matrix.test.ts`,
        `- GET /api/agent-runs/${ids.run}`,
        `- GET /api/cards/${ids.card}/comments`,
      ].join('\n');

      const finalStdout = JSON.stringify({
        type: 'item.completed',
        item: {
          id: `openwork-final-message-${ids.run}`,
          type: 'openwork_final_message',
          text: finalAnswer,
        },
      });

      const jobPromise = dispatchRemoteAgentJob({
        userId: 'user-matrix',
        workspaceId: 'ws-matrix',
        intent: {
          runId: ids.run,
          agentId: ids.agent,
          agentKind: 'dev_agent',
          provider,
          modelPreference: { displayName: provider, modelId: `${provider}-model-id` },
          prompt: `matrix prompt ${provider}`,
          workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-matrix' },
          allowedOperations: {
            tools: [provider],
            approvalMode: 'dangerous',
            env: true,
            secrets: true,
            network: true,
            shell: true,
          },
        },
      });

      const runner = __runnerTestUtils.runners.get(`runner-matrix-${provider}`)!;
      const jobId = readOfferedJobId(ws);
      __runnerTestUtils.handleRunnerMessage(runner, {
        type: 'job_accepted',
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        jobId,
        runId: ids.run,
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
        stdout: finalStdout,
        stderr: '',
      });

      const remote = await jobPromise;
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
      expect(String(comment?.content ?? '')).toContain(`GET /api/agent-runs/${ids.run}`);
      expect(String(comment?.content ?? '')).toContain(`GET /api/cards/${ids.card}/comments`);

      const app = await buildMatrixApi();
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

      logMatrixRow({
        provider,
        agentKind: 'dev_agent',
        disposition: 'tested',
        reason: 'runner job_offer → final_message → completed → completeAgentRun → automatic card comment + HTTP GET contract',
        evidence: {
          tests: ['src/services/non-codex-runner-regression-matrix.test.ts'],
          runId: ids.run,
          cardId: ids.card,
        },
      });
    },
  );

  it('matrix: codex baseline is out of scope for this file (documented skip)', () => {
    logMatrixRow({
      provider: 'codex',
      agentKind: 'dev_agent',
      disposition: 'skipped',
      reason:
        'Codex remote path is covered by agent-runner-protocol.contract.test.ts and runner-split-smoke.test.ts; this matrix focuses on non-Codex RunnerProvider values only.',
      evidence: {
        tests: [
          'src/services/agent-runner-protocol.contract.test.ts',
          'src/qa/runner-split-smoke.test.ts',
        ],
      },
    });
    expect(true).toBe(true);
  });

  it('matrix: no runner socket — opencode dispatch fails immediately (no silent local fallback)', async () => {
    mocks.store.reset();
    await expect(
      dispatchRemoteAgentJob({
        userId: 'user-matrix',
        workspaceId: 'ws-matrix',
        intent: {
          runId: 'qa-matrix-run-no-runner',
          agentId: 'qa-matrix-agent-no-runner',
          agentKind: 'dev_agent',
          provider: 'opencode',
          modelPreference: { displayName: 'opencode' },
          prompt: 'x',
          workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-matrix' },
          allowedOperations: {
            tools: ['opencode'],
            approvalMode: 'dangerous',
            env: true,
            secrets: true,
            network: true,
            shell: true,
          },
        },
      }),
    ).rejects.toThrow(/No remote agent runner is connected/i);
    logMatrixRow({
      provider: 'opencode',
      agentKind: 'dev_agent',
      disposition: 'tested_negative_no_runner',
      reason:
        'With zero connected runners, dispatchRemoteAgentJob must reject with an explicit connectivity message instead of falling back to a hidden local executor.',
      evidence: { assertion: 'dispatchRemoteAgentJob rejects when __runnerTestUtils.runners is empty' },
    });
  });

  it('matrix: qwen job with claude-only runner — dispatch rejected before job_offer (actionable capability error)', async () => {
    mocks.store.reset();
    const ws = makeOpenSocket();
    addRunner('runner-matrix-claude-only', ws, { supportedProviders: ['claude'] });
    await expect(
      dispatchRemoteAgentJob({
        userId: 'user-matrix',
        workspaceId: 'ws-matrix',
        intent: {
          runId: 'qa-matrix-run-mismatch',
          agentId: 'qa-matrix-agent-mismatch',
          agentKind: 'dev_agent',
          provider: 'qwen',
          modelPreference: { displayName: 'qwen' },
          prompt: 'x',
          workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-matrix' },
          allowedOperations: {
            tools: ['qwen'],
            approvalMode: 'dangerous',
            env: true,
            secrets: true,
            network: true,
            shell: true,
          },
        },
      }),
    ).rejects.toThrow(/supports qwen/i);
    expect(ws.send).not.toHaveBeenCalled();
    logMatrixRow({
      provider: 'qwen',
      agentKind: 'dev_agent',
      disposition: 'unsupported_runner_configuration',
      reason:
        'Connected runner advertised supportedProviders without qwen; dispatch must fail with install/configure guidance instead of silently picking an incompatible runner.',
      evidence: { assertion: 'dispatchRemoteAgentJob rejects; ws.send not called (no job_offer)' },
    });
  });

  it('matrix: claude remote run without final_message — terminal error + automatic card evidence', async () => {
    mocks.store.reset();
    const ids = {
      agent: 'qa-matrix-agent-claude-neg',
      collection: 'qa-matrix-collection-neg',
      card: '00000000-0000-4000-8000-00000000bb01',
      run: 'qa-matrix-run-claude-no-final',
    };
    mocks.store.insert('agents', {
      id: ids.agent,
      name: 'matrix claude neg',
      model: 'claude-sonnet',
      modelId: 'claude-model',
      status: 'active',
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: 'qa matrix collection neg',
    });
    mocks.store.insert('cards', {
      id: ids.card,
      collectionId: ids.collection,
      name: 'matrix claude neg card',
      description: '',
    });
    createAgentRun({
      id: ids.run,
      agentId: ids.agent,
      agentName: 'matrix claude neg',
      model: 'claude-sonnet',
      modelId: 'claude-model',
      triggerType: 'card_assignment',
      cardId: ids.card,
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);

    const ws = makeOpenSocket();
    addRunner('runner-matrix-claude-neg', ws, { supportedProviders: ['claude'] });
    const jobPromise = dispatchRemoteAgentJob({
      userId: 'user-matrix',
      workspaceId: 'ws-matrix',
      intent: {
        runId: ids.run,
        agentId: ids.agent,
        agentKind: 'dev_agent',
        provider: 'claude',
        modelPreference: { displayName: 'Claude' },
        prompt: 'hi',
        workspace: { type: 'local_path', path: '/tmp', workspaceId: 'ws-matrix' },
        allowedOperations: {
          tools: ['claude'],
          approvalMode: 'dangerous',
          env: true,
          secrets: true,
          network: true,
          shell: true,
        },
      },
    });
    const runner = __runnerTestUtils.runners.get('runner-matrix-claude-neg')!;
    const jobId = readOfferedJobId(ws);
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
    logMatrixRow({
      provider: 'claude',
      agentKind: 'dev_agent',
      disposition: 'tested_negative_missing_final_output',
      reason:
        'Non-Codex/Codex-equivalent completion hygiene: empty protocol completion must not mark run clean without extractable final answer; card receives automatic error comment.',
      evidence: { runId: ids.run, cardId: ids.card },
    });
  });
});
