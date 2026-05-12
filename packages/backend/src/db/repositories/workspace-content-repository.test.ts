import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreRecord } from '../store.js';

const records = vi.hoisted(() => new Map<string, StoreRecord[]>());

vi.mock('../connection.js', () => ({
  store: {
    flush: vi.fn(async () => undefined),
    getAll: vi.fn((collection: string) => records.get(collection) ?? []),
    getById: vi.fn((collection: string, id: string) => {
      return (records.get(collection) ?? []).find((row) => row.id === id) ?? null;
    }),
    delete: vi.fn((collection: string, id: string) => {
      const rows = records.get(collection) ?? [];
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return null;
      const [deleted] = rows.splice(index, 1);
      return deleted ?? null;
    }),
    update: vi.fn((collection: string, id: string, patch: StoreRecord) => {
      const rows = records.get(collection) ?? [];
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return null;
      rows[index] = { ...rows[index], ...patch, id };
      return rows[index];
    }),
    reload: vi.fn(async () => undefined),
  },
}));

describe('workspace content repositories', () => {
  beforeEach(() => {
    records.clear();
  });

  it('lists boards with SQL repository semantics for filters, ordering, and pagination', async () => {
    const { listBoardsNative } = await import('./boards-cards-repository.js');
    records.set('boards', [
      { id: 'old', name: 'Roadmap', description: 'Alpha', collectionId: 'c1', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'new', name: 'Roadmap New', description: 'Beta', collectionId: 'c1', createdAt: '2024-02-01T00:00:00.000Z' },
      { id: 'other', name: 'Other', description: 'Beta', collectionId: 'c2', createdAt: '2024-03-01T00:00:00.000Z' },
    ]);

    const result = await listBoardsNative({
      collectionId: 'c1',
      search: 'roadmap',
      limit: 1,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.entries.map((row) => row.id)).toEqual(['new']);
  });

  it('lists cards with tag filters, counts, ordering, and pagination', async () => {
    const { listCardsNative } = await import('./boards-cards-repository.js');
    records.set('cards', [
      { id: 'card-1', collectionId: 'c1', name: 'First', description: 'x', position: 2 },
      { id: 'card-2', collectionId: 'c1', name: 'Second', description: 'needle', position: 1 },
      { id: 'card-3', collectionId: 'c1', name: 'Third', description: 'needle', position: 3 },
    ]);
    records.set('cardTags', [
      { id: 'card-2:t1', cardId: 'card-2', tagId: 't1' },
      { id: 'card-3:t1', cardId: 'card-3', tagId: 't1' },
    ]);

    const result = await listCardsNative({
      collectionId: 'c1',
      search: 'needle',
      tagId: 't1',
      limit: 1,
      offset: 1,
    });

    expect(result.total).toBe(2);
    expect(result.entries.map((row) => row.id)).toEqual(['card-3']);
  });

  it('lists messages by conversation with stable descending order and deletes by conversation', async () => {
    const { deleteAllMessagesForConversationNative, listMessagesByConversationIdNative } =
      await import('./messages-repository.js');
    records.set('messages', [
      { id: 'm1', conversationId: 'c1', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'm2', conversationId: 'c1', createdAt: '2024-01-02T00:00:00.000Z' },
      { id: 'm3', conversationId: 'c2', createdAt: '2024-01-03T00:00:00.000Z' },
    ]);

    const result = await listMessagesByConversationIdNative('c1', {
      order: 'desc',
      limit: 1,
      offset: 0,
    });
    expect(result).toMatchObject({ total: 2 });
    expect(result.entries.map((row) => row.id)).toEqual(['m2']);

    await deleteAllMessagesForConversationNative('c1');
    expect(records.get('messages')?.map((row) => row.id)).toEqual(['m3']);
  });

  it('lists inbox conversations and drafts without agent conversations', async () => {
    const { listConversationsNative } = await import('./conversations-repository.js');
    const { listMessageDraftsNative } = await import('./message-drafts-repository.js');
    records.set('contacts', [{ id: 'contact-1', firstName: 'Ada', lastName: 'Lovelace' }]);
    records.set('conversations', [
      { id: 'conv-1', contactId: 'contact-1', channelType: 'telegram', subject: 'Ada case', status: 'open', isUnread: true, lastMessageAt: '2024-02-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'conv-agent', contactId: 'contact-1', channelType: 'agent', subject: 'Ada agent', status: 'open', isUnread: true, lastMessageAt: '2024-03-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z' },
    ]);
    records.set('messageDrafts', [
      { id: 'draft-1', conversationId: 'conv-1', updatedAt: '2024-02-01T00:00:00.000Z' },
      { id: 'draft-agent', conversationId: 'conv-agent', updatedAt: '2024-03-01T00:00:00.000Z' },
    ]);

    const conversations = await listConversationsNative(
      { search: 'ada', limit: 10, offset: 0 },
      (row) => row.channelType === 'agent',
    );
    const drafts = await listMessageDraftsNative({ limit: 10, offset: 0 });

    expect(conversations.entries.map((row) => row.id)).toEqual(['conv-1']);
    expect(drafts.entries.map((row) => row.id)).toEqual(['draft-1']);
  });
});
