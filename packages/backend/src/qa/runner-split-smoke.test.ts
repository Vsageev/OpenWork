import Fastify, { type FastifyRequest } from 'fastify';
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
  editMessageAndBranch,
  getActiveMessagePath,
  getAgentConversation,
  getConversationExecutionItems,
  saveAgentConversationMessage,
} from '../services/agent-chat.js';
import { createAgentChatTurn, listAgentChatTurns } from '../services/agent-chat-turns.js';
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
import * as agentOutput from '../lib/agent-output.js';

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
  const requiredFragments = [params.expectedFinalAnswer];
  const missingFragment = requiredFragments.find((fragment) => !content.includes(fragment));
  if (missingFragment) {
    return { ok: false, reason: `automatic completion comment missed required fragment: ${missingFragment}`, ids };
  }
  return {
    ok: true,
    reason: 'completed card-assignment run and automatic comment matched',
    ids: { ...ids, expectedCommentBody: params.expectedFinalAnswer },
  };
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
  const requiredFragments = [params.expectedSummaryFragment];
  const missingFragment = requiredFragments.find((fragment) => !content.includes(fragment));
  if (missingFragment) {
    return { ok: false, reason: `automatic completion comment missed required fragment: ${missingFragment}`, ids };
  }
  return {
    ok: true,
    reason: 'terminal card-assignment run and automatic comment matched',
    ids: { ...ids, expectedCommentBody: params.expectedSummaryFragment },
  };
}

async function buildSmokeApi() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
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
    expect(mocks.hasConnectedRemoteAgentRunner).toHaveBeenCalledWith(ids.user, ids.workspace);
    expect(mocks.hasAvailableRemoteAgentRunner).toHaveBeenCalledWith(ids.user, ids.workspace, 'codex');

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

  it('repairs stale processing chat queue rows when their linked run is already terminal', () => {
    mocks.store.reset();

    const agentId = 'qa-smoke-agent-stale-queue';
    const conversationId = 'qa-smoke-conversation-stale-queue';
    const userMessageId = 'qa-smoke-message-stale-user';
    const responseMessageId = 'qa-smoke-message-stale-response';
    const runId = 'qa-smoke-run-stale-terminal';
    const queueItemId = 'qa-smoke-queue-stale-processing';
    const runStartedAt = '2026-01-01T00:00:00.000Z';

    mocks.store.insert('agents', {
      id: agentId,
      name: '[qa-smoke] stale queue agent',
      model: 'codex',
      modelId: null,
      groupId: null,
      status: 'active',
    });
    mocks.store.insert('conversations', {
      id: conversationId,
      contactId: null,
      channelType: 'agent',
      subject: '[qa-smoke] stale queue conversation',
      status: 'open',
      isUnread: false,
      lastMessageAt: runStartedAt,
      metadata: JSON.stringify({ agentId }),
    });
    mocks.store.insert('messages', {
      id: userMessageId,
      conversationId,
      direction: 'outbound',
      content: 'stale queue prompt',
      type: 'text',
      status: 'sent',
      parentId: null,
      previousUserMessageId: null,
      metadata: null,
      createdAt: runStartedAt,
    });
    mocks.store.insert('messages', {
      id: responseMessageId,
      conversationId,
      direction: 'inbound',
      content: 'terminal answer',
      type: 'text',
      status: 'sent',
      parentId: userMessageId,
      previousUserMessageId: null,
      metadata: JSON.stringify({ runId }),
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    mocks.store.insert('agent_runs', {
      id: runId,
      agentId,
      agentName: '[qa-smoke] stale queue agent',
      triggerType: 'chat',
      status: 'completed',
      conversationId,
      responseParentId: userMessageId,
      startedAt: runStartedAt,
      finishedAt: '2026-01-01T00:00:02.000Z',
      responseText: 'terminal answer',
      stdout: '',
      stderr: '',
      errorMessage: null,
    });
    mocks.store.insert('agentChatQueue', {
      id: queueItemId,
      agentId,
      conversationId,
      mode: 'respond_to_message',
      prompt: '',
      status: 'processing',
      attempts: 1,
      runId,
      lastRunId: runId,
      targetMessageId: userMessageId,
      queuedMessageId: null,
      startedAt: runStartedAt,
      completedAt: null,
      errorMessage: null,
    });

    const items = getConversationExecutionItems(agentId, conversationId);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: queueItemId,
      status: 'completed',
      runId: null,
      responseMessageId,
    });
  });

  it('keeps completed chat run responses idempotent and hides persisted duplicates from the active path', () => {
    mocks.store.reset();

    const agentId = 'qa-smoke-agent-duplicate-final';
    const conversationId = 'qa-smoke-conversation-duplicate-final';
    const userMessageId = 'qa-smoke-message-duplicate-user';
    const runId = 'qa-smoke-run-duplicate-final';

    mocks.store.insert('conversations', {
      id: conversationId,
      contactId: null,
      channelType: 'agent',
      subject: '[qa-smoke] duplicate final conversation',
      status: 'open',
      isUnread: false,
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      metadata: JSON.stringify({ agentId }),
    });
    mocks.store.insert('messages', {
      id: userMessageId,
      conversationId,
      direction: 'outbound',
      content: 'prompt',
      type: 'text',
      status: 'sent',
      parentId: null,
      previousUserMessageId: null,
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const first = saveAgentConversationMessage({
      conversationId,
      direction: 'inbound',
      content: 'final answer',
      type: 'text',
      parentId: userMessageId,
      metadata: { runId },
    });
    const second = saveAgentConversationMessage({
      conversationId,
      direction: 'inbound',
      content: 'final answer',
      type: 'text',
      parentId: userMessageId,
      metadata: { runId },
    });

    expect(second.id).toBe(first.id);
    expect(
      mocks.store
        .getAll('messages')
        .filter(
          (message) => message.conversationId === conversationId && message.direction === 'inbound',
        ),
    ).toHaveLength(1);

    mocks.store.update('messages', String(first.id), {
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    mocks.store.insert('messages', {
      id: 'qa-smoke-message-duplicate-response-copy',
      conversationId,
      direction: 'inbound',
      content: 'final answer',
      type: 'text',
      status: 'delivered',
      parentId: userMessageId,
      previousUserMessageId: null,
      metadata: JSON.stringify({ runId }),
      createdAt: '2026-01-01T00:00:02.000Z',
    });

    const activePath = getActiveMessagePath(conversationId);
    expect(activePath.map((message) => message.id)).toEqual([userMessageId, first.id]);
    expect(activePath[1]?.siblingCount).toBeUndefined();
    expect(activePath[1]?.siblingIds).toBeUndefined();
  });

  it('keeps queue, conversation, active run, and pending prompts aligned across multiple enqueues while a chat run is active', async () => {
    vi.useFakeTimers();
    mocks.store.reset();
    mocks.dispatchRemoteAgentJob.mockClear();
    const ids = {
      agent: 'qa-smoke-agent-multi-queue',
      group: 'qa-smoke-group-multi-queue',
      workspace: 'qa-smoke-workspace-multi-queue',
      collection: 'qa-smoke-collection-multi-queue',
      user: 'qa-smoke-user-multi-queue',
      chatRun: 'qa-smoke-chat-run-active-multi',
    };
    mocks.store.insert('users', {
      id: ids.user,
      email: 'qa-smoke-multi@example.test',
      firstName: 'QA',
      lastName: 'Multi',
      type: 'human',
      isActive: true,
    });
    mocks.store.insert('agents', {
      id: ids.agent,
      name: '[qa-smoke] multi-queue agent',
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
      name: '[qa-smoke] multi-queue workspace',
      agentGroupIds: [ids.group],
      collectionIds: [ids.collection],
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: '[qa-smoke] multi-queue collection',
      description: 'Temporary smoke harness collection',
    });

    const conversation = createAgentConversation(
      ids.agent,
      '[qa-smoke] multi enqueue conversation',
    ) as Record<string, unknown>;
    const convId = String(conversation.id);

    saveAgentConversationMessage({
      id: 'qa-msg-root',
      conversationId: convId,
      direction: 'outbound',
      content: 'root prompt being answered',
      previousUserMessageId: null,
    });
    createAgentChatTurn({
      id: 'qa-turn-root',
      agentId: ids.agent,
      conversationId: convId,
      userMessageId: 'qa-msg-root',
      status: 'running',
      source: 'qa_smoke',
      runId: ids.chatRun,
    });
    createAgentRun({
      id: ids.chatRun,
      agentId: ids.agent,
      agentName: '[qa-smoke] multi-queue agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      triggerType: 'chat',
      conversationId: convId,
      responseParentId: 'qa-msg-root',
      turnId: 'qa-turn-root',
      executor: 'remote',
      status: 'running',
    } as Parameters<typeof createAgentRun>[0]);

    const activeRun = getAgentRun(ids.chatRun) as Record<string, unknown> | null;
    expect(activeRun).toMatchObject({
      id: ids.chatRun,
      status: 'running',
      triggerType: 'chat',
      conversationId: convId,
      agentId: ids.agent,
    });

    const convBeforeEnqueue = getAgentConversation(ids.agent, convId);
    expect(convBeforeEnqueue).toMatchObject({ isBusy: true });

    const expectedPrompts = ['queued prompt alpha', 'queued prompt beta', 'queued prompt gamma'];
    const expectedQueuedMessageIds = ['qa-msg-q1', 'qa-msg-q2', 'qa-msg-q3'];

    enqueueAgentPrompt(ids.agent, convId, expectedPrompts[0], {
      queuedMessageId: expectedQueuedMessageIds[0],
      previousUserMessageId: 'qa-msg-root',
    });
    enqueueAgentPrompt(ids.agent, convId, expectedPrompts[1], {
      queuedMessageId: expectedQueuedMessageIds[1],
      previousUserMessageId: 'qa-msg-q1',
    });
    enqueueAgentPrompt(ids.agent, convId, expectedPrompts[2], {
      queuedMessageId: expectedQueuedMessageIds[2],
      previousUserMessageId: 'qa-msg-q2',
    });

    const convAfter = getAgentConversation(ids.agent, convId);
    expect(convAfter?.isBusy).toBe(true);
    expect(convAfter?.queuedCount).toBe(3);

    const queueItems = getConversationExecutionItems(ids.agent, convId);
    expect(queueItems).toHaveLength(3);
    expect(queueItems.map((item) => item.prompt)).toEqual(expectedPrompts);
    expect(queueItems.map((item) => item.queuedMessageId)).toEqual(expectedQueuedMessageIds);
    expect(queueItems.every((item) => typeof item.turnId === 'string')).toBe(true);

    for (let i = 0; i < queueItems.length; i += 1) {
      const check = assertQueueAlignment({
        conversationId: convId,
        queueItem: queueItems[i],
        queuedMessageId: expectedQueuedMessageIds[i],
      });
      expect(check).toMatchObject({ ok: true });
    }

    const outboundMessages = mocks.store
      .getAll('messages')
      .filter(
        (row: Record<string, unknown>) =>
          row.conversationId === convId && row.direction === 'outbound',
      )
      .sort(
        (a: Record<string, unknown>, b: Record<string, unknown>) =>
          String(a.createdAt).localeCompare(String(b.createdAt)),
      );
    expect(outboundMessages.map((row: Record<string, unknown>) => row.id)).toEqual([
      'qa-msg-root',
      'qa-msg-q1',
      'qa-msg-q2',
      'qa-msg-q3',
    ]);
    const tail = outboundMessages[outboundMessages.length - 1] as Record<string, unknown>;
    expect(tail.id).toBe('qa-msg-q3');
    expect(tail.previousUserMessageId).toBe('qa-msg-q2');
    expect(outboundMessages.slice(1).map((row: Record<string, unknown>) => row.content)).toEqual(
      expectedPrompts,
    );

    const turns = listAgentChatTurns(ids.agent, convId);
    const turnsById = new Map(turns.map((turn) => [String(turn.id), turn]));
    const queuedTurns = queueItems.map((item) => {
      const turn = turnsById.get(String(item.turnId));
      if (!turn) {
        throw new Error(`missing agentChatTurn for queue item ${String(item.id)}`);
      }
      return turn;
    });
    expect(queuedTurns.map((turn) => turn.userMessageId)).toEqual(expectedQueuedMessageIds);
    expect(queuedTurns.map((turn) => turn.status)).toEqual(['queued', 'queued', 'queued']);
    expect(queuedTurns.map((turn) => turn.id)).toEqual(queueItems.map((item) => item.turnId));

    console.info(
      `qa-smoke report: ${JSON.stringify({
        check: 'multi enqueue while chat run active',
        status: 'PASS',
        reason:
          'queue item ids, conversation id, active chat run id, pending prompts, and tail outbound ownership stayed consistent',
        ids: {
          agent: ids.agent,
          workspace: ids.workspace,
          conversation: convId,
          activeRunId: ids.chatRun,
          queueItemIds: queueItems.map((item) => String(item.id)),
        },
      })}`,
    );
  });

  it('tracks chat turns for stop, edit, failed, follow-up, and attachment prompts', async () => {
    vi.useFakeTimers();
    mocks.store.reset();
    mocks.cancelRemoteAgentRun.mockClear();
    const ids = {
      agent: 'qa-smoke-agent-turn-paths',
      group: 'qa-smoke-group-turn-paths',
      workspace: 'qa-smoke-workspace-turn-paths',
      collection: 'qa-smoke-collection-turn-paths',
      user: 'qa-smoke-user-turn-paths',
    };
    mocks.store.insert('users', {
      id: ids.user,
      email: 'qa-smoke-turns@example.test',
      firstName: 'QA',
      lastName: 'Turns',
      type: 'human',
      isActive: true,
    });
    mocks.store.insert('agents', {
      id: ids.agent,
      name: '[qa-smoke] turn paths agent',
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
      name: '[qa-smoke] turn paths workspace',
      agentGroupIds: [ids.group],
      collectionIds: [ids.collection],
    });
    mocks.store.insert('collections', {
      id: ids.collection,
      name: '[qa-smoke] turn paths collection',
      description: 'Temporary turn path smoke collection',
    });

    const conversation = createAgentConversation(
      ids.agent,
      '[qa-smoke] turn paths conversation',
    ) as Record<string, unknown>;
    const convId = String(conversation.id);

    const root = enqueueAgentPrompt(ids.agent, convId, 'root prompt', {
      queuedMessageId: 'qa-turn-msg-root',
    });
    const rootTurnId = String(root.queueItem.turnId);
    expect(root.userMessage).toMatchObject({
      id: 'qa-turn-msg-root',
      direction: 'outbound',
      content: 'root prompt',
    });
    expect(listAgentChatTurns(ids.agent, convId)[0]).toMatchObject({
      id: rootTurnId,
      userMessageId: 'qa-turn-msg-root',
      status: 'queued',
    });

    createAgentRun({
      id: 'qa-turn-run-root',
      agentId: ids.agent,
      agentName: '[qa-smoke] turn paths agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      triggerType: 'chat',
      conversationId: convId,
      responseParentId: 'qa-turn-msg-root',
      executor: 'remote',
      status: 'running',
      turnId: rootTurnId,
    } as Parameters<typeof createAgentRun>[0]);
    const activeBeforeStop = getActiveMessagePath(convId).map((message) => message.id);
    await killAgentRun('qa-turn-run-root');
    expect(mocks.cancelRemoteAgentRun).toHaveBeenCalledWith('qa-turn-run-root');
    expect(getActiveMessagePath(convId).map((message) => message.id)).toEqual(activeBeforeStop);
    expect(mocks.store.getById('agentChatTurns', rootTurnId)).toMatchObject({
      status: 'stopped',
      runId: 'qa-turn-run-root',
    });

    const afterStop = enqueueAgentPrompt(ids.agent, convId, 'after stop follow-up', {
      queuedMessageId: 'qa-turn-msg-after-stop',
      previousUserMessageId: 'qa-turn-msg-root',
    });
    expect(mocks.store.getById('agentChatTurns', String(afterStop.queueItem.turnId))).toMatchObject(
      {
        parentTurnId: rootTurnId,
        userMessageId: 'qa-turn-msg-after-stop',
        status: 'queued',
      },
    );

    const editedMessage = editMessageAndBranch(convId, 'qa-turn-msg-root', 'edited root prompt', {
      newMessageId: 'qa-turn-msg-root-edit',
    });
    const editQueue = enqueueAgentPrompt(ids.agent, convId, 'edited root prompt', {
      mode: 'respond_to_message',
      targetMessageId: String(editedMessage.id),
      turnType: 'edit',
      supersedesMessageId: 'qa-turn-msg-root',
    });
    const editTurnId = String(editQueue.queueItem.turnId);
    expect(mocks.store.getById('agentChatTurns', editTurnId)).toMatchObject({
      turnType: 'edit',
      supersedesTurnId: rootTurnId,
      userMessageId: 'qa-turn-msg-root-edit',
      status: 'queued',
    });
    expect(mocks.store.getById('agentChatTurns', rootTurnId)).toMatchObject({
      status: 'superseded',
    });

    const afterEdit = enqueueAgentPrompt(ids.agent, convId, 'after edit follow-up', {
      queuedMessageId: 'qa-turn-msg-after-edit',
      previousUserMessageId: 'qa-turn-msg-root-edit',
    });
    expect(mocks.store.getById('agentChatTurns', String(afterEdit.queueItem.turnId))).toMatchObject({
      parentTurnId: editTurnId,
      userMessageId: 'qa-turn-msg-after-edit',
      status: 'queued',
    });

    const failed = enqueueAgentPrompt(ids.agent, convId, 'failed prompt', {
      queuedMessageId: 'qa-turn-msg-failed',
    });
    const failedTurnId = String(failed.queueItem.turnId);
    createAgentRun({
      id: 'qa-turn-run-failed',
      agentId: ids.agent,
      agentName: '[qa-smoke] turn paths agent',
      model: 'codex',
      modelId: 'gpt-5.3-codex',
      triggerType: 'chat',
      conversationId: convId,
      responseParentId: 'qa-turn-msg-failed',
      executor: 'remote',
      status: 'running',
      turnId: failedTurnId,
    } as Parameters<typeof createAgentRun>[0]);
    await failAgentRunCompletionSideEffect('qa-turn-run-failed', 'runner failed hard');
    expect(mocks.store.getById('agentChatTurns', failedTurnId)).toMatchObject({
      status: 'failed',
      runId: 'qa-turn-run-failed',
      metadata: { errorMessage: 'runner failed hard' },
    });

    const attachment = {
      type: 'file',
      fileName: 'spec.txt',
      mimeType: 'text/plain',
      fileSize: 42,
      storagePath: '/chat-uploads/spec.txt',
    };
    const attachmentPrompt = enqueueAgentPrompt(ids.agent, convId, '', {
      queuedMessageId: 'qa-turn-msg-attachment',
      attachments: [attachment],
    });
    expect(attachmentPrompt.userMessage).toMatchObject({
      id: 'qa-turn-msg-attachment',
      type: 'file',
      attachments: [attachment],
    });
    expect(attachmentPrompt.queueItem).toMatchObject({
      queuedMessageId: 'qa-turn-msg-attachment',
      attachments: [attachment],
    });
    expect(mocks.store.getById('agentChatTurns', String(attachmentPrompt.queueItem.turnId))).toMatchObject({
      userMessageId: 'qa-turn-msg-attachment',
      status: 'queued',
    });
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
        const snippet = check.ids?.expectedCommentBody;
        expect(snippet).toBeTruthy();
        expect(String(linkedComment.content)).toContain(String(snippet));
      }
    } finally {
      await app.close();
    }

    console.info(
      `qa-smoke report: ${JSON.stringify({ check: 'terminal card-run comments', status: 'PASS', reason: 'terminal success, failure, cancellation, runner unavailable, reconciliation, and non-Codex model runs all produced linked comments', ids })}`,
    );
  });

  it('negative controls fail for mismatched queue identity', async () => {
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
      `qa-smoke report: ${JSON.stringify({ check: 'backend negative controls', status: 'PASS', reason: 'sentinel rejected mismatched queue identity (unsupported runner capability is asserted in the runner startup smoke layer)', ids: { runId, conversationId: String(conversation.id), queueId: String(queued.queueItem.id) }, evidence: { mismatchedQueue: mismatchedQueue.reason } })}`,
    );
  });

  it('marks card-assignment runs as error when final response extraction throws', async () => {
    const spy = vi.spyOn(agentOutput, 'extractFinalResponseText').mockImplementation(() => {
      throw new Error('forced extraction failure');
    });
    try {
      mocks.store.reset();
      const runId = 'qa-smoke-run-extract-throw';
      const cardId = '00000000-0000-4000-8000-000000000301';
      const agentId = 'qa-smoke-agent-extract-throw';
      const collectionId = 'qa-smoke-collection-extract-throw';
      mocks.store.insert('agents', {
        id: agentId,
        name: '[qa-smoke] extract throw agent',
        model: 'codex',
        modelId: 'gpt-5.3-codex',
        status: 'active',
      });
      mocks.store.insert('collections', {
        id: collectionId,
        name: '[qa-smoke] extract throw collection',
      });
      mocks.store.insert('cards', {
        id: cardId,
        collectionId,
        name: '[qa-smoke] extract throw card',
        description: 'Harness card',
        customFields: { qaSmoke: true },
      });
      createAgentRun({
        id: runId,
        agentId,
        agentName: '[qa-smoke] extract throw agent',
        model: 'codex',
        modelId: 'gpt-5.3-codex',
        triggerType: 'card_assignment',
        cardId,
        executor: 'remote',
        status: 'running',
      } as Parameters<typeof createAgentRun>[0]);
      const finalStdout = JSON.stringify({
        type: 'item.completed',
        item: {
          id: `openwork-final-message-${runId}`,
          type: 'openwork_final_message',
          text: 'QA extract throw body',
        },
      });
      const done = await completeAgentRun(runId, null, { stdout: finalStdout, stderr: '' });
      expect(done).toMatchObject({
        id: runId,
        status: 'error',
        errorMessage: expect.stringMatching(/Failed to extract agent final response/i),
      });
      const terminal = inspectTerminalCardAssignmentComment({
        runId,
        cardId,
        agentId,
        expectedStatus: 'error',
        expectedSummaryFragment: 'Failed to extract agent final response',
      });
      expect(terminal).toMatchObject({ ok: true });
    } finally {
      spy.mockRestore();
    }
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
