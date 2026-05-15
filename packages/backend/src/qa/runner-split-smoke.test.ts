import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    count(name: string) {
      return collection(name).size;
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
    insertMany(name: string, items: Record<string, unknown>[]) {
      return items.map((item) => store.insert(name, item));
    },
    update(name: string, id: string, data: Record<string, unknown>) {
      const existing = collection(name).get(id);
      if (!existing) return null;
      const record = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
      collection(name).set(id, record);
      return record;
    },
    delete(name: string, id: string) {
      const existing = collection(name).get(id) ?? null;
      collection(name).delete(id);
      return existing;
    },
    async transaction<T>(operation: () => T | Promise<T>) {
      return operation();
    },
    async lockAgentChatQueueConversation() {},
    async lockAgentRunRowForUpdate() {},
    async reload() {},
    async flush() {},
  };

  return {
    store,
    cancelRemoteAgentRun: vi.fn(() => true),
    dispatchRemoteAgentJob: vi.fn(),
    hasAvailableRemoteAgentRunner: vi.fn(() => true),
    hasConnectedRemoteAgentRunner: vi.fn(() => true),
  };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/connection.js', () => ({ store: mocks.store }));
vi.mock('../services/agent-runners.js', () => ({
  cancelRemoteAgentRun: mocks.cancelRemoteAgentRun,
  dispatchRemoteAgentJob: mocks.dispatchRemoteAgentJob,
  getRemoteAgentRunnerUnavailableMessage: vi.fn(() => 'No remote agent runner is connected.'),
  hasAvailableRemoteAgentRunner: mocks.hasAvailableRemoteAgentRunner,
  hasConnectedRemoteAgentRunner: mocks.hasConnectedRemoteAgentRunner,
}));
vi.mock('../services/audit-log.js', () => ({
  createAuditLog: vi.fn(async () => ({ id: 'qa-smoke-audit-log' })),
}));

import {
  createAgentConversation,
  enqueueAgentPrompt,
  getAgentConversation,
  getConversationExecutionItems,
} from '../services/agent-chat.js';
import { agentRunRoutes } from '../routes/agent-runs.js';
import { cardRoutes } from '../routes/cards.js';
import {
  completeAgentRun,
  createAgentRun,
  failAgentRunCompletionSideEffect,
  getAgentRun,
  killAgentRun,
  reconcileRunsOnStartup,
} from '../services/agent-runs.js';
import { createCard, getCardById, listCards } from '../services/cards.js';

type SmokeCheck =
  | { ok: true; reason: string; ids?: Record<string, string> }
  | { ok: false; reason: string; ids?: Record<string, string> };

function assertQueueAlignment(params: {
  conversationId: string;
  queueItem: Record<string, unknown>;
  queuedMessageId: string;
}): SmokeCheck {
  const ids = {
    conversationId: params.conversationId,
    queueId: String(params.queueItem.id ?? ''),
    queuedMessageId: params.queuedMessageId,
  };
  if (params.queueItem.conversationId !== params.conversationId) {
    return {
      ok: false,
      reason: `queued chat alignment failed: queue conversation ${String(params.queueItem.conversationId)} did not match conversation ${params.conversationId}`,
      ids,
    };
  }
  if (params.queueItem.queuedMessageId !== params.queuedMessageId) {
    return {
      ok: false,
      reason: `queued chat alignment failed: queued message ${String(params.queueItem.queuedMessageId)} did not match expected ${params.queuedMessageId}`,
      ids,
    };
  }
  return { ok: true, reason: 'queued chat alignment matched conversation and queued message ids', ids };
}

function inspectCompletedCardAssignment(params: {
  runId: string;
  cardId: string;
  agentId: string;
  expectedFinalAnswer: string;
  expectedStatus?: 'completed' | 'error';
}): SmokeCheck {
  const run = getAgentRun(params.runId);
  const comments = mocks.store
    .getAll('cardComments')
    .filter((entry: Record<string, unknown>) => entry.cardId === params.cardId);
  const linkedComment = comments.find(
    (entry: Record<string, unknown>) => entry.agentRunId === params.runId,
  );
  const ids = {
    runId: params.runId,
    cardId: params.cardId,
    agentId: params.agentId,
    commentId: linkedComment ? String(linkedComment.id) : '',
  };

  if (!run) return { ok: false, reason: 'agent run was not persisted', ids };
  const runRecord = run as Record<string, unknown>;
  if (runRecord.id !== params.runId || runRecord.agentId !== params.agentId || runRecord.cardId !== params.cardId) {
    return { ok: false, reason: 'agent run identity did not match expected agent/card ids', ids };
  }
  if (runRecord.triggerType !== 'card_assignment') {
    return { ok: false, reason: `agent run trigger type was ${String(runRecord.triggerType)}, expected card_assignment`, ids };
  }
  const expectedStatus = params.expectedStatus ?? 'completed';
  if (runRecord.status !== expectedStatus) {
    return { ok: false, reason: `agent run terminal status was ${String(runRecord.status)}, expected ${expectedStatus}`, ids };
  }
  if (runRecord.responseText !== params.expectedFinalAnswer) {
    return { ok: false, reason: 'agent run final output extraction did not match expected final answer', ids };
  }
  if (!linkedComment) {
    return { ok: false, reason: 'missing automatic completion comment linked by cardId and agentRunId', ids };
  }
  if (linkedComment.authorId !== params.agentId) {
    return { ok: false, reason: 'automatic completion comment author did not match agent id', ids };
  }
  const content = String(linkedComment.content ?? '');
  const requiredFragments = [
    `Agent run terminal status: ${expectedStatus}`,
    `Run ID: ${params.runId}`,
    `Card ID: ${params.cardId}`,
    `Agent ID: ${params.agentId}`,
    'Trigger type: card_assignment',
    params.expectedFinalAnswer,
  ];
  const missingFragment = requiredFragments.find((fragment) => !content.includes(fragment));
  if (missingFragment) {
    return { ok: false, reason: `automatic completion comment missed required fragment: ${missingFragment}`, ids };
  }
  return { ok: true, reason: 'completed card-assignment run and automatic comment matched', ids };
}

function inspectTerminalCardAssignmentComment(params: {
  runId: string;
  cardId: string;
  agentId: string;
  expectedStatus: 'completed' | 'error';
  expectedSummaryFragment: string;
}): SmokeCheck {
  const run = getAgentRun(params.runId);
  const linkedComment = mocks.store
    .getAll('cardComments')
    .find(
      (entry: Record<string, unknown>) =>
        entry.cardId === params.cardId && entry.agentRunId === params.runId,
    );
  const ids = {
    runId: params.runId,
    cardId: params.cardId,
    agentId: params.agentId,
    commentId: linkedComment ? String(linkedComment.id) : '',
  };

  if (!run) return { ok: false, reason: 'agent run was not persisted', ids };
  const runRecord = run as Record<string, unknown>;
  if (runRecord.id !== params.runId || runRecord.agentId !== params.agentId || runRecord.cardId !== params.cardId) {
    return { ok: false, reason: 'agent run identity did not match expected agent/card ids', ids };
  }
  if (runRecord.triggerType !== 'card_assignment') {
    return { ok: false, reason: `agent run trigger type was ${String(runRecord.triggerType)}, expected card_assignment`, ids };
  }
  if (runRecord.status !== params.expectedStatus) {
    return { ok: false, reason: `agent run terminal status was ${String(runRecord.status)}, expected ${params.expectedStatus}`, ids };
  }
  if (!linkedComment) {
    return { ok: false, reason: 'missing automatic completion comment linked by cardId and agentRunId', ids };
  }
  if (linkedComment.authorId !== params.agentId) {
    return { ok: false, reason: 'automatic completion comment author did not match agent id', ids };
  }

  const content = String(linkedComment.content ?? '');
  const requiredFragments = [
    `Agent run terminal status: ${params.expectedStatus}`,
    `Run ID: ${params.runId}`,
    `Card ID: ${params.cardId}`,
    `Agent ID: ${params.agentId}`,
    'Trigger type: card_assignment',
    'Final summary:',
    params.expectedSummaryFragment,
    `- GET /api/agent-runs/${params.runId}`,
    `- GET /api/cards/${params.cardId}/comments`,
  ];
  const missingFragment = requiredFragments.find((fragment) => !content.includes(fragment));
  if (missingFragment) {
    return { ok: false, reason: `automatic completion comment missed required fragment: ${missingFragment}`, ids };
  }
  return { ok: true, reason: 'terminal card-assignment run and automatic comment matched', ids };
}

async function buildSmokeApi() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = { sub: 'qa-smoke-user-runner-split' };
  });
  await app.register(agentRunRoutes);
  await app.register(cardRoutes);
  return app;
}

describe('runner-split QA backend smoke', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('seeds an agent conversation and card through service helpers, then exposes the queued chat state contract', async () => {
    vi.useFakeTimers();
    mocks.store.reset();
    mocks.dispatchRemoteAgentJob.mockClear();
    const ids = {
      agent: 'qa-smoke-agent-runner-split',
      group: 'qa-smoke-group-runner-split',
      workspace: 'qa-smoke-workspace-runner-split',
      collection: 'qa-smoke-collection-runner-split',
      user: 'qa-smoke-user-runner-split',
      queuedMessage: 'qa-smoke-message-runner-split',
      run: 'qa-smoke-runner-split-run',
    };
    mocks.store.insert('users', {
      id: ids.user,
      email: 'qa-smoke@example.test',
      firstName: 'QA',
      lastName: 'Smoke',
      type: 'human',
      isActive: true,
    });
    mocks.store.insert('agents', {
      id: ids.agent,
      name: '[qa-smoke] runner split agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: null,
      groupId: ids.group,
      status: 'active',
      separateFolderPerChat: false,
    });
    mocks.store.insert('workspaces', {
      id: ids.workspace,
      userId: ids.user,
      name: '[qa-smoke] runner split workspace',
      agentGroupIds: [ids.group],
      collectionIds: [ids.collection],
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: '[qa-smoke] runner split collection',
      description: 'Temporary smoke harness collection',
    });

    const conversation = createAgentConversation(
      ids.agent,
      '[qa-smoke] runner split conversation',
    ) as Record<string, unknown>;
    const card = await createCard({
      collectionId: ids.collection,
      name: '[qa-smoke] runner split card',
      description: 'Temporary smoke harness card',
      customFields: { qaSmoke: true },
    });
    const finalAnswer = [
      'QA_RUNNER_SPLIT_FINAL_ANSWER',
      '',
      'Verification commands/API checks used:',
      '- pnpm smoke:runner-split',
      `- GET /api/agent-runs/${ids.run}`,
      `- GET /api/cards/${String(card.id)}/comments`,
    ].join('\n');
    const finalStdout = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: `openwork-final-message-${ids.run}`,
          type: 'openwork_final_message',
          text: finalAnswer,
        },
      }),
    ].join('\n');
    const queued = enqueueAgentPrompt(
      ids.agent,
      String(conversation.id),
      'runner split smoke prompt',
      {
        queuedMessageId: ids.queuedMessage,
      },
    );

    const fetchedConversation = getAgentConversation(ids.agent, String(conversation.id));
    const fetchedCard = await getCardById(String(card.id));
    const cards = await listCards({ collectionId: ids.collection });
    const queueItems = getConversationExecutionItems(ids.agent, String(conversation.id));
    const queueAlignment = assertQueueAlignment({
      conversationId: String(conversation.id),
      queueItem: queued.queueItem,
      queuedMessageId: ids.queuedMessage,
    });

    expect(fetchedConversation).toMatchObject({
      id: conversation.id,
      metadata: expect.stringContaining(ids.agent),
      queuedCount: 0,
      isBusy: true,
    });
    expect(fetchedCard).toMatchObject({
      id: card.id,
      collectionId: ids.collection,
      customFields: { qaSmoke: true },
    });
    expect(cards.entries.map((entry) => entry.id)).toEqual([card.id]);
    expect(queued.queueItem).toMatchObject({
      id: expect.any(String),
      agentId: ids.agent,
      conversationId: conversation.id,
      status: 'queued',
      queuedMessageId: ids.queuedMessage,
    });
    expect(queueItems).toHaveLength(1);
    expect(queueItems[0]).toMatchObject({
      id: queued.queueItem.id,
      queuedMessageId: ids.queuedMessage,
      status: 'queued',
      prompt: 'runner split smoke prompt',
    });
    expect(queueAlignment).toMatchObject({
      ok: true,
      reason: 'queued chat alignment matched conversation and queued message ids',
    });
    expect(mocks.hasConnectedRemoteAgentRunner).toHaveBeenCalledWith(ids.workspace);
    expect(mocks.hasAvailableRemoteAgentRunner).toHaveBeenCalledWith(ids.workspace, 'codex');

    const run = createAgentRun({
      id: ids.run,
      agentId: ids.agent,
      agentName: '[qa-smoke] runner split agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      triggerType: 'card_assignment',
      cardId: String(card.id),
      triggerPrompt: 'runner split smoke prompt',
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);
    const runId = String(run.id);
    const completed = await completeAgentRun(runId, null, { stdout: finalStdout, stderr: '' });
    expect(completed).toMatchObject({
      id: runId,
      status: 'completed',
      responseText: finalAnswer,
    });

    const completionCheck = inspectCompletedCardAssignment({
      runId,
      cardId: String(card.id),
      agentId: ids.agent,
      expectedFinalAnswer: finalAnswer,
    });
    expect(completionCheck).toMatchObject({ ok: true });

    const app = await buildSmokeApi();
    try {
      const runResponse = await app.inject({
        method: 'GET',
        url: `/api/agent-runs/${runId}`,
      });
      expect(runResponse.statusCode).toBe(200);
      expect(runResponse.json()).toMatchObject({
        id: runId,
        triggerType: 'card_assignment',
        agentId: ids.agent,
        cardId: card.id,
        status: 'completed',
        responseText: finalAnswer,
      });

      const commentsResponse = await app.inject({
        method: 'GET',
        url: `/api/cards/${String(card.id)}/comments`,
      });
      expect(commentsResponse.statusCode).toBe(200);
      const comments = commentsResponse.json();
      const apiComment = comments.entries.find(
        (entry: Record<string, unknown>) => entry.agentRunId === runId,
      );
      expect(apiComment).toMatchObject({
        cardId: card.id,
        authorId: ids.agent,
        agentRunId: runId,
      });
      expect(apiComment.content).toContain(`Run ID: ${runId}`);
      expect(apiComment.content).toContain(`Card ID: ${String(card.id)}`);
      expect(apiComment.content).toContain(finalAnswer);
    } finally {
      await app.close();
    }

    console.info(
      `qa-smoke resources: agent=${ids.agent} workspace=${ids.workspace} conversation=${String(conversation.id)} card=${String(card.id)} queue=${String(queued.queueItem.id)} run=${runId} comment=${completionCheck.ids?.commentId ?? ''}`,
    );
    console.info(
      `qa-smoke report: ${JSON.stringify({ check: 'backend API/service smoke', status: 'PASS', reason: completionCheck.reason, ids: completionCheck.ids })}`,
    );
  });

  it('persists automatic comments for terminal card-assignment states across runner outcomes', async () => {
    mocks.store.reset();
    mocks.cancelRemoteAgentRun.mockClear();
    const ids = {
      agent: 'qa-smoke-agent-terminal-states',
      collection: 'qa-smoke-collection-terminal-states',
      successCard: '00000000-0000-4000-8000-000000000101',
      failureCard: '00000000-0000-4000-8000-000000000102',
      cancelledCard: '00000000-0000-4000-8000-000000000103',
      unavailableCard: '00000000-0000-4000-8000-000000000104',
      reconciledCard: '00000000-0000-4000-8000-000000000105',
      nonCodexCard: '00000000-0000-4000-8000-000000000106',
    };
    mocks.store.insert('agents', {
      id: ids.agent,
      name: '[qa-smoke] terminal states agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      status: 'active',
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: '[qa-smoke] terminal states collection',
    });
    for (const cardId of [
      ids.successCard,
      ids.failureCard,
      ids.cancelledCard,
      ids.unavailableCard,
      ids.reconciledCard,
      ids.nonCodexCard,
    ]) {
      mocks.store.insert('cards', {
        id: cardId,
        collectionId: ids.collection,
        name: `[qa-smoke] ${cardId}`,
        description: 'Temporary terminal-state card',
        customFields: { qaSmoke: true },
      });
    }

    const finalStdout = (runId: string, text: string) =>
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: `openwork-final-message-${runId}`,
          type: 'openwork_final_message',
          text,
        },
      });
    const createRunningRun = (runId: string, cardId: string, model = 'codex') =>
      createAgentRun({
        id: runId,
        agentId: ids.agent,
        agentName: '[qa-smoke] terminal states agent',
        model,
        modelId: model === 'codex' ? 'gpt-5.3-codex' : 'claude-sonnet-4.5',
        triggerType: 'card_assignment',
        cardId,
        executor: 'remote',
        status: 'running',
      } as Parameters<typeof createAgentRun>[0]);

    createRunningRun('qa-smoke-run-terminal-success', ids.successCard);
    await completeAgentRun('qa-smoke-run-terminal-success', null, {
      stdout: finalStdout('qa-smoke-run-terminal-success', 'QA terminal success final answer'),
      stderr: '',
    });

    createRunningRun('qa-smoke-run-terminal-failure', ids.failureCard);
    await completeAgentRun('qa-smoke-run-terminal-failure', 'Remote runner exited with code 1', {
      stdout: '',
      stderr: 'provider failure',
    });

    createRunningRun('qa-smoke-run-terminal-cancelled', ids.cancelledCard);
    await killAgentRun('qa-smoke-run-terminal-cancelled');

    createRunningRun('qa-smoke-run-terminal-unavailable', ids.unavailableCard);
    await failAgentRunCompletionSideEffect(
      'qa-smoke-run-terminal-unavailable',
      'No remote agent runner is connected.',
      { stderr: 'runner unavailable' },
    );

    createRunningRun('qa-smoke-run-terminal-reconciled', ids.reconciledCard);
    await reconcileRunsOnStartup();

    createRunningRun('qa-smoke-run-terminal-non-codex', ids.nonCodexCard, 'claude');
    await completeAgentRun('qa-smoke-run-terminal-non-codex', null, {
      stdout: finalStdout('qa-smoke-run-terminal-non-codex', 'QA non-Codex final answer'),
      stderr: '',
    });

    const checks = [
      inspectTerminalCardAssignmentComment({
        runId: 'qa-smoke-run-terminal-success',
        cardId: ids.successCard,
        agentId: ids.agent,
        expectedStatus: 'completed',
        expectedSummaryFragment: 'QA terminal success final answer',
      }),
      inspectTerminalCardAssignmentComment({
        runId: 'qa-smoke-run-terminal-failure',
        cardId: ids.failureCard,
        agentId: ids.agent,
        expectedStatus: 'error',
        expectedSummaryFragment: 'Remote runner exited with code 1',
      }),
      inspectTerminalCardAssignmentComment({
        runId: 'qa-smoke-run-terminal-cancelled',
        cardId: ids.cancelledCard,
        agentId: ids.agent,
        expectedStatus: 'error',
        expectedSummaryFragment: 'Killed by user',
      }),
      inspectTerminalCardAssignmentComment({
        runId: 'qa-smoke-run-terminal-unavailable',
        cardId: ids.unavailableCard,
        agentId: ids.agent,
        expectedStatus: 'error',
        expectedSummaryFragment: 'No remote agent runner is connected.',
      }),
      inspectTerminalCardAssignmentComment({
        runId: 'qa-smoke-run-terminal-reconciled',
        cardId: ids.reconciledCard,
        agentId: ids.agent,
        expectedStatus: 'error',
        expectedSummaryFragment: 'Process died (server restarted or process killed)',
      }),
      inspectTerminalCardAssignmentComment({
        runId: 'qa-smoke-run-terminal-non-codex',
        cardId: ids.nonCodexCard,
        agentId: ids.agent,
        expectedStatus: 'completed',
        expectedSummaryFragment: 'QA non-Codex final answer',
      }),
    ];
    expect(checks).toEqual(checks.map((check) => ({ ...check, ok: true })));
    expect(mocks.cancelRemoteAgentRun).toHaveBeenCalledWith('qa-smoke-run-terminal-cancelled');

    const app = await buildSmokeApi();
    try {
      for (const check of checks) {
        const runId = check.ids?.runId ?? '';
        const cardId = check.ids?.cardId ?? '';
        const runResponse = await app.inject({
          method: 'GET',
          url: `/api/agent-runs/${runId}`,
        });
        expect(runResponse.statusCode).toBe(200);
        expect(runResponse.json()).toMatchObject({
          id: runId,
          triggerType: 'card_assignment',
          agentId: ids.agent,
          cardId,
          status: expect.stringMatching(/^(completed|error)$/),
        });

        const commentsResponse = await app.inject({
          method: 'GET',
          url: `/api/cards/${cardId}/comments`,
        });
        expect(commentsResponse.statusCode).toBe(200);
        const linkedComment = commentsResponse
          .json()
          .entries.find((entry: Record<string, unknown>) => entry.agentRunId === runId);
        expect(linkedComment).toMatchObject({
          cardId,
          authorId: ids.agent,
          agentRunId: runId,
        });
        expect(linkedComment.content).toContain(`Run ID: ${runId}`);
        expect(linkedComment.content).toContain(`Card ID: ${cardId}`);
      }
    } finally {
      await app.close();
    }

    console.info(
      `qa-smoke report: ${JSON.stringify({ check: 'terminal card-run comments', status: 'PASS', reason: 'terminal success, failure, cancellation, runner unavailable, reconciliation, and non-Codex model runs all produced linked comments', ids })}`,
    );
  });

  it('negative controls fail for missing comments and mismatched queue identity', async () => {
    mocks.store.reset();
    const ids = {
      agent: 'qa-smoke-agent-runner-split',
      group: 'qa-smoke-group-runner-split-negative',
      workspace: 'qa-smoke-workspace-runner-split-negative',
      collection: 'qa-smoke-collection-runner-split',
      user: 'qa-smoke-user-runner-split-negative',
      card: '00000000-0000-4000-8000-000000000201',
      run: 'qa-smoke-runner-split-run-no-comment',
      queuedMessage: 'qa-smoke-message-negative-expected',
    };
    const finalAnswer = 'QA_RUNNER_SPLIT_NEGATIVE_FINAL_ANSWER';
    const finalStdout = JSON.stringify({
      type: 'item.completed',
      item: {
        id: `openwork-final-message-${ids.run}`,
        type: 'openwork_final_message',
        text: finalAnswer,
      },
    });

    mocks.store.insert('agents', {
      id: ids.agent,
      name: '[qa-smoke] runner split agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      groupId: ids.group,
      status: 'active',
    });
    mocks.store.insert('workspaces', {
      id: ids.workspace,
      userId: ids.user,
      name: '[qa-smoke] runner split negative workspace',
      agentGroupIds: [ids.group],
      collectionIds: [ids.collection],
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: '[qa-smoke] runner split collection',
    });
    mocks.store.insert('cards', {
      id: ids.card,
      collectionId: ids.collection,
      name: '[qa-smoke] runner split negative card',
      description: 'Temporary smoke harness card',
      customFields: {},
    });
    const run = createAgentRun({
      id: ids.run,
      agentId: ids.agent,
      agentName: '[qa-smoke] runner split agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      triggerType: 'card_assignment',
      cardId: ids.card,
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);
    const runId = String(run.id);
    await completeAgentRun(runId, null, { stdout: finalStdout, stderr: '' });

    const completedWithAutoComment = inspectCompletedCardAssignment({
      runId,
      cardId: ids.card,
      agentId: ids.agent,
      expectedFinalAnswer: finalAnswer,
    });
    expect(completedWithAutoComment).toMatchObject({ ok: true });

    const disabledRunId = `${ids.run}-disabled-writer`;
    const disabledCardId = '00000000-0000-4000-8000-000000000202';
    mocks.store.insert('cards', {
      id: disabledCardId,
      collectionId: ids.collection,
      name: '[qa-smoke] runner split disabled writer card',
      description: 'Temporary smoke harness card',
      customFields: {},
    });
    const disabledRun = createAgentRun({
      id: disabledRunId,
      agentId: ids.agent,
      agentName: '[qa-smoke] runner split agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      triggerType: 'card_assignment',
      cardId: disabledCardId,
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);
    const actualDisabledRunId = String(disabledRun.id);

    const originalInsert = mocks.store.insert;
    const insertSpy = vi.spyOn(mocks.store, 'insert').mockImplementation((name, data) => {
      if (name === 'cardComments') {
        return {
          ...data,
          id: 'qa-smoke-comment-writer-disabled',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      return originalInsert(name, data);
    });
    await completeAgentRun(actualDisabledRunId, null, { stdout: finalStdout, stderr: '' });
    insertSpy.mockRestore();

    const missingComment = inspectCompletedCardAssignment({
      runId: actualDisabledRunId,
      cardId: disabledCardId,
      agentId: ids.agent,
      expectedFinalAnswer: finalAnswer,
    });
    expect(missingComment).toMatchObject({
      ok: false,
      reason: 'missing automatic completion comment linked by cardId and agentRunId',
    });

    const app = await buildSmokeApi();
    try {
      const commentsResponse = await app.inject({
        method: 'GET',
        url: `/api/cards/${disabledCardId}/comments`,
      });
      expect(commentsResponse.statusCode).toBe(200);
      expect(
        commentsResponse
          .json()
          .entries.some((entry: Record<string, unknown>) => entry.agentRunId === actualDisabledRunId),
      ).toBe(false);
    } finally {
      await app.close();
    }

    const conversation = createAgentConversation(
      ids.agent,
      '[qa-smoke] negative queue alignment conversation',
    ) as Record<string, unknown>;
    const queued = enqueueAgentPrompt(
      ids.agent,
      String(conversation.id),
      'runner split negative queue prompt',
      {
        queuedMessageId: ids.queuedMessage,
      },
    );
    const corruptedQueueItem = mocks.store.update('agentChatQueue', String(queued.queueItem.id), {
      conversationId: 'qa-smoke-conversation-mismatched',
      queuedMessageId: 'qa-smoke-message-mismatched',
    });
    const mismatchedQueue = assertQueueAlignment({
      conversationId: String(conversation.id),
      queuedMessageId: ids.queuedMessage,
      queueItem: corruptedQueueItem ?? queued.queueItem,
    });
    expect(mismatchedQueue).toMatchObject({
      ok: false,
      reason: expect.stringContaining('queued chat alignment failed'),
    });

    console.info(
      `qa-smoke report: ${JSON.stringify({ check: 'backend negative controls', status: 'PASS', reason: 'sentinels rejected disabled automatic comment writer and mismatched queue identity', ids: { runId: disabledRunId, cardId: disabledCardId, conversationId: String(conversation.id), queueId: String(queued.queueItem.id) }, evidence: { missingComment: missingComment.reason, mismatchedQueue: mismatchedQueue.reason } })}`,
    );
  });

  it('marks Claude stream-json runs without a terminal result event as error', async () => {
    mocks.store.reset();
    const runId = 'qa-smoke-run-incomplete-claude-stream';
    createAgentRun({
      id: runId,
      agentId: 'qa-smoke-agent-incomplete-claude-stream',
      agentName: '[qa-smoke] incomplete Claude stream agent',
      model: 'claude',
      modelId: 'claude-opus-4-7',
      triggerType: 'chat',
      conversationId: 'qa-smoke-conversation-incomplete-claude-stream',
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);

    const incompleteClaudeStdout = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/workspace' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I started, but did not finish.' }],
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
        },
      }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' } }),
      JSON.stringify({ type: 'rate_limit_event' }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }),
    ].join('\n');

    const completed = await completeAgentRun(runId, null, {
      stdout: incompleteClaudeStdout,
      stderr: '',
    });

    expect(completed).toMatchObject({
      id: runId,
      status: 'error',
      errorMessage: 'Agent stream-json output ended without a terminal result event.',
      responseText: null,
    });
  });
});
