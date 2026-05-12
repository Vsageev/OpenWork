import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  AGENT_BATCH_RUN_ITEMS_COLLECTION,
  AGENT_BATCH_RUNS_COLLECTION,
} from '../db/repositories/agent-execution-repository.js';
import { enqueueAgentBatchRun } from './agent-batch-queue.js';

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
});
