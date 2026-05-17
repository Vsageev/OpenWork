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
        id: data.id ?? `${collection}-${getCollection(collection).length + 1}`,
        createdAt: data.createdAt ?? new Date().toISOString(),
        updatedAt: data.updatedAt ?? new Date().toISOString(),
        ...data,
      };
      getCollection(collection).push(row);
      return row;
    }),
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
    transaction: vi.fn(async <T>(operation: () => Promise<T> | T) => operation()),
  };

  return {
    records,
    store,
    createAuditLog: vi.fn(),
    executeCardTask: vi.fn(),
    getAgent: vi.fn(),
  };
});

vi.mock('../db/index.js', () => ({ store: mocks.store }));
vi.mock('../db/connection.js', () => ({ store: mocks.store }));
vi.mock('./audit-log.js', () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock('./agents.js', () => ({ getAgent: mocks.getAgent }));
vi.mock('./agent-chat.js', () => ({ executeCardTask: mocks.executeCardTask }));

import { deleteCard } from './cards.js';

describe('deleteCard', () => {
  beforeEach(() => {
    for (const collection of Object.keys(mocks.records)) {
      delete mocks.records[collection];
    }
    vi.clearAllMocks();
    mocks.store.transaction.mockImplementation(async <T>(operation: () => Promise<T> | T) =>
      operation(),
    );
  });

  it('removes dependent rows and detaches agent run history before deleting the card', async () => {
    mocks.store.insert('cards', {
      id: 'card-1',
      collectionId: 'collection-1',
      name: 'Delete me',
      customFields: {},
      position: 0,
    });
    mocks.store.insert('cardComments', { id: 'comment-1', cardId: 'card-1' });
    mocks.store.insert('cardTags', { id: 'card-1:tag-1', cardId: 'card-1', tagId: 'tag-1' });
    mocks.store.insert('boardCards', { id: 'board-card-1', cardId: 'card-1' });
    mocks.store.insert('cardLinks', {
      id: 'link-1',
      sourceCardId: 'card-1',
      targetCardId: 'card-2',
    });
    mocks.store.insert('agent_runs', {
      id: 'run-1',
      cardId: 'card-1',
      status: 'completed',
    });
    mocks.store.insert('agentBatchRunItems', {
      id: 'batch-item-1',
      cardId: 'card-1',
      runId: 'batch-run-1',
    });

    await expect(deleteCard('card-1')).resolves.toMatchObject({ id: 'card-1' });

    expect(mocks.store.getById('cards', 'card-1')).toBeNull();
    expect(mocks.store.getAll('cardComments')).toHaveLength(0);
    expect(mocks.store.getAll('cardTags')).toHaveLength(0);
    expect(mocks.store.getAll('boardCards')).toHaveLength(0);
    expect(mocks.store.getAll('cardLinks')).toHaveLength(0);
    expect(mocks.store.getAll('agentBatchRunItems')).toHaveLength(0);
    expect(mocks.store.getById('agent_runs', 'run-1')).toMatchObject({ cardId: null });

    expect(mocks.store.update).toHaveBeenCalledWith('agent_runs', 'run-1', { cardId: null });
    expect(mocks.store.delete).toHaveBeenCalledWith('cards', 'card-1');
    const cardDeleteIndex = mocks.store.delete.mock.calls.findIndex((call) => call[0] === 'cards');
    expect(mocks.store.update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.store.delete.mock.invocationCallOrder[cardDeleteIndex],
    );
  });
});
