import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const records: Record<string, Array<Record<string, unknown>>> = {};

  const getCollection = (collection: string) => {
    records[collection] ??= [];
    return records[collection];
  };

  const store = {
    getAll: vi.fn((collection: string) => [...getCollection(collection)]),
    getById: vi.fn((collection: string, id: string) =>
      getCollection(collection).find((record) => record.id === id) ?? null,
    ),
    insert: vi.fn((collection: string, data: Record<string, unknown>) => {
      const row = {
        id: `${collection}-${getCollection(collection).length + 1}`,
        createdAt: new Date().toISOString(),
        ...data,
      };
      getCollection(collection).push(row);
      return row;
    }),
    insertMany: vi.fn((collection: string, items: Array<Record<string, unknown>>) =>
      items.map((item) => store.insert(collection, item)),
    ),
    update: vi.fn((collection: string, id: string, data: Record<string, unknown>) => {
      const rows = getCollection(collection);
      const index = rows.findIndex((record) => record.id === id);
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...data };
      return rows[index];
    }),
    delete: vi.fn((collection: string, id: string) => {
      const rows = getCollection(collection);
      const index = rows.findIndex((record) => record.id === id);
      if (index < 0) return null;
      const [removed] = rows.splice(index, 1);
      return removed;
    }),
    transaction: vi.fn(async <T>(op: () => Promise<T> | T) => op()),
    lockAgentBatchRunScope: vi.fn(async () => {}),
    lockAgentChatQueueConversation: vi.fn(async () => {}),
    lockAgentRunRowForUpdate: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    count: vi.fn(() => 0),
  };

  return {
    records,
    store,
    getAgent: vi.fn(),
    executeCardTask: vi.fn(),
    killAgentRun: vi.fn(),
  };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/connection.js', () => ({ store: mocks.store }));
vi.mock('./agents.js', () => ({ getAgent: mocks.getAgent }));
vi.mock('./agent-chat.js', () => ({ executeCardTask: mocks.executeCardTask }));
vi.mock('./agent-runs.js', () => ({ killAgentRun: mocks.killAgentRun }));

import { store } from '../db/index.js';
import {
  AGENT_BATCH_RUN_ITEMS_COLLECTION,
  AGENT_BATCH_RUNS_COLLECTION,
  AGENT_RUNS_COLLECTION,
} from '../db/repositories/agent-execution-repository.js';
import {
  cancelAgentBatchRun,
  enqueueAgentBatchRun,
  getAgentBatchRun,
  initializeAgentBatchQueue,
  listAgentBatchRunItems,
} from './agent-batch-queue.js';

describe('agent batch queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const collection of Object.keys(mocks.records)) {
      delete mocks.records[collection];
    }
    mocks.getAgent.mockReturnValue({ id: 'agent-1', name: 'Agent', status: 'active' });
    mocks.executeCardTask.mockReset();
    mocks.killAgentRun.mockReset();
    mocks.killAgentRun.mockResolvedValue({ ok: true });
    mocks.store.getAll.mockClear();
    mocks.store.getById.mockClear();
    mocks.store.insert.mockClear();
    mocks.store.insertMany.mockClear();
    mocks.store.update.mockClear();
    mocks.store.delete.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows empty prompts and runs cards through the default card assignment prompt', async () => {
    const result = enqueueAgentBatchRun({
      sourceType: 'board',
      sourceId: 'board-1',
      agentId: 'agent-1',
      prompt: '',
      cards: [
        {
          id: 'card-1',
          name: 'Move me',
          description: 'The card already has enough detail.',
          collectionId: 'collection-1',
        },
      ],
    });

    expect(result.runId).toBeTruthy();
    expect(mocks.records[AGENT_BATCH_RUNS_COLLECTION]?.[0]?.prompt).toBe('');
    expect(mocks.records[AGENT_BATCH_RUN_ITEMS_COLLECTION]).toHaveLength(1);

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.executeCardTask).toHaveBeenCalledTimes(1);
    expect(mocks.executeCardTask.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('dispatches cards in stable list order when maxParallel is 1', async () => {
    mocks.executeCardTask.mockImplementation((_agentId, card, callbacks) => {
      callbacks.onDone();
    });
    enqueueAgentBatchRun({
      sourceType: 'board',
      sourceId: 'board-order',
      agentId: 'agent-1',
      maxParallel: 1,
      cards: [
        { id: 'card-a', name: 'A', description: null, collectionId: 'col-1' },
        { id: 'card-b', name: 'B', description: null, collectionId: 'col-1' },
        { id: 'card-c', name: 'C', description: null, collectionId: 'col-1' },
      ],
    });
    await vi.runOnlyPendingTimersAsync();
    const callOrder = mocks.executeCardTask.mock.calls.map((call) => (call[1] as { id: string }).id);
    expect(callOrder).toEqual(['card-a', 'card-b', 'card-c']);
  });

  it('does not double-dispatch the same card when multiple drain timers flush together', async () => {
    mocks.executeCardTask.mockImplementation((_agentId, _card, callbacks) => {
      callbacks.onDone();
    });
    enqueueAgentBatchRun({
      sourceType: 'board',
      sourceId: 'board-dup',
      agentId: 'agent-1',
      maxParallel: 1,
      cards: [{ id: 'card-only', name: 'Only', description: null, collectionId: 'col-1' }],
    });
    await Promise.all([
      vi.runOnlyPendingTimersAsync(),
      vi.runOnlyPendingTimersAsync(),
      vi.runOnlyPendingTimersAsync(),
    ]);
    expect(mocks.executeCardTask).toHaveBeenCalledTimes(1);
  });

  it('respects maxParallel by overlapping in-flight card tasks before the next slot opens', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    mocks.executeCardTask.mockImplementation((_agentId, _card, callbacks) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        callbacks.onDone();
      }, 5);
    });
    enqueueAgentBatchRun({
      sourceType: 'board',
      sourceId: 'board-parallel',
      agentId: 'agent-1',
      maxParallel: 2,
      cards: [
        { id: 'p1', name: 'P1', description: null, collectionId: 'col-1' },
        { id: 'p2', name: 'P2', description: null, collectionId: 'col-1' },
        { id: 'p3', name: 'P3', description: null, collectionId: 'col-1' },
      ],
    });
    await vi.runOnlyPendingTimersAsync();
    expect(peakInFlight).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    await vi.runOnlyPendingTimersAsync();
    expect(mocks.executeCardTask).toHaveBeenCalledTimes(3);
    const runId = mocks.records[AGENT_BATCH_RUNS_COLLECTION]?.[0]?.id as string;
    expect(getAgentBatchRun(runId)?.status).toBe('completed');
  });

  it('cancels a queued card while another is hung in processing without double work', async () => {
    mocks.executeCardTask.mockImplementation((_agentId, card, callbacks) => {
      if (card.id === 'card-hung') {
        callbacks.onRunCreated?.('run-hung-1');
        return;
      }
      callbacks.onDone();
    });
    const { runId } = enqueueAgentBatchRun({
      sourceType: 'board',
      sourceId: 'board-cancel',
      agentId: 'agent-1',
      maxParallel: 1,
      cards: [
        { id: 'card-hung', name: 'Hung', description: null, collectionId: 'col-1' },
        { id: 'card-wait', name: 'Wait', description: null, collectionId: 'col-1' },
      ],
    });
    expect(runId).toBeTruthy();
    await vi.runOnlyPendingTimersAsync();
    expect(mocks.executeCardTask).toHaveBeenCalledTimes(1);
    await cancelAgentBatchRun(runId!, 'stop batch');
    expect(mocks.killAgentRun).toHaveBeenCalledWith('run-hung-1');
    await vi.runOnlyPendingTimersAsync();
    const items = listAgentBatchRunItems(runId!);
    const byCard = Object.fromEntries(
      items.entries.map((row) => [row.cardId as string, row.status as string]),
    );
    expect(byCard['card-hung']).toBe('cancelled');
    expect(byCard['card-wait']).toBe('cancelled');
    expect(getAgentBatchRun(runId!)?.status).toBe('cancelled');
  });

  it('surfaces repeated card task failures on the batch run after exhausting retries', async () => {
    mocks.executeCardTask.mockImplementation((_agentId, _card, callbacks) => {
      callbacks.onError('forced card failure');
    });
    const { runId } = enqueueAgentBatchRun({
      sourceType: 'board',
      sourceId: 'board-fail',
      agentId: 'agent-1',
      maxParallel: 1,
      cards: [{ id: 'card-fail', name: 'Fail', description: null, collectionId: 'col-1' }],
    });
    expect(runId).toBeTruthy();
    for (let i = 0; i < 24; i += 1) {
      await vi.advanceTimersByTimeAsync(35_000);
      await vi.runOnlyPendingTimersAsync();
      const status = getAgentBatchRun(runId!)?.status as string | undefined;
      if (status === 'failed') break;
    }
    expect(getAgentBatchRun(runId!)?.status).toBe('failed');
    const item = listAgentBatchRunItems(runId!).entries[0];
    expect(item?.status).toBe('failed');
    expect(String(item?.errorMessage ?? '')).toContain('forced card failure');
  });

  it('reconciles a processing batch item from persistence when the linked agent run already finished', async () => {
    const runId = 'batch-recover-run';
    const itemId = 'batch-recover-item';
    store.insert(AGENT_BATCH_RUNS_COLLECTION, {
      id: runId,
      sourceType: 'board',
      sourceId: 'board-recover',
      agentId: 'agent-1',
      prompt: '',
      maxParallel: 2,
      status: 'running',
      total: 1,
      queued: 0,
      processing: 1,
      completed: 0,
      failed: 0,
      cancelled: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorMessage: null,
      stageCount: 0,
      dependencyItemCount: 0,
    });
    store.insert(AGENT_BATCH_RUN_ITEMS_COLLECTION, {
      id: itemId,
      runId,
      sourceType: 'board',
      sourceId: 'board-recover',
      agentId: 'agent-1',
      cardId: 'card-recover',
      cardName: 'Recover',
      cardDescription: null,
      cardCollectionId: 'col-1',
      order: 0,
      status: 'processing',
      dependsOnItemIds: [],
      blockingMode: null,
      stageId: null,
      attempts: 1,
      maxAttempts: 4,
      nextAttemptAt: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
      agentRunId: 'agent-run-recover-1',
    });
    store.insert(AGENT_RUNS_COLLECTION, {
      id: 'agent-run-recover-1',
      agentId: 'agent-1',
      agentName: 'Agent',
      triggerType: 'card_assignment',
      status: 'completed',
      cardId: 'card-recover',
      executor: 'remote',
      killedByUser: false,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    await initializeAgentBatchQueue({ preserveActiveProcessing: false });
    await vi.runOnlyPendingTimersAsync();
    const item = store.getById(AGENT_BATCH_RUN_ITEMS_COLLECTION, itemId);
    expect(item?.status).toBe('completed');
    expect(getAgentBatchRun(runId)?.status).toBe('completed');
  });
});
