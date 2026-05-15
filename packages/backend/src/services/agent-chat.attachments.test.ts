import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFind = vi.fn();
const mockGetAll = vi.fn();
const mockGetById = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../db/connection.js', () => ({
  store: {
    find: (col: string, predicate: (record: Record<string, unknown>) => boolean) =>
      mockFind(col, predicate),
    getAll: (col: string) => mockGetAll(col),
    getById: (col: string, id: string) => mockGetById(col, id),
    update: (col: string, id: string, patch: Record<string, unknown>) =>
      mockUpdate(col, id, patch),
  },
}));

import {
  activateMessagePathForSearchResult,
  getActiveMessagePath,
  getConversationAttachmentDiskPaths,
} from './agent-chat.js';

const CONV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('getConversationAttachmentDiskPaths', () => {
  let recordsByCollection: Record<string, Array<Record<string, unknown>>>;

  beforeEach(() => {
    recordsByCollection = {
      conversations: [{ id: CONV_ID, metadata: null }],
      messages: [],
    };

    mockFind.mockImplementation(
      (col: string, predicate: (record: Record<string, unknown>) => boolean) =>
        (recordsByCollection[col] ?? []).filter((record) => predicate(record)),
    );
    mockGetAll.mockImplementation((col: string) => [...(recordsByCollection[col] ?? [])]);
    mockGetById.mockImplementation((col: string, id: string) =>
      (recordsByCollection[col] ?? []).find((record) => record.id === id) ?? null,
    );
    mockUpdate.mockImplementation((col: string, id: string, patch: Record<string, unknown>) => {
      const record = (recordsByCollection[col] ?? []).find((entry) => entry.id === id);
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    });

    vi.spyOn(fs, 'existsSync').mockImplementation((targetPath) => {
      const normalized =
        typeof targetPath === 'string' ? targetPath : targetPath.toString();
      return !normalized.includes('missing');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockFind.mockReset();
    mockGetAll.mockReset();
    mockGetById.mockReset();
    mockUpdate.mockReset();
  });

  it('includes attachments from every attachment-bearing message in a linear conversation', () => {
    recordsByCollection.messages = [
      {
        id: 'm1',
        conversationId: CONV_ID,
        direction: 'outbound',
        createdAt: '2026-05-07T10:00:00.000Z',
        attachments: null,
      },
      {
        id: 'm2',
        conversationId: CONV_ID,
        direction: 'outbound',
        createdAt: '2026-05-07T10:01:00.000Z',
        attachments: [
          { storagePath: '/chat-uploads/pasted-text-1.txt', type: 'file' },
          { storagePath: '/chat-uploads/image-1.png', type: 'image' },
        ],
      },
      {
        id: 'm3',
        conversationId: CONV_ID,
        direction: 'inbound',
        createdAt: '2026-05-07T10:02:00.000Z',
        attachments: null,
      },
      {
        id: 'm4',
        conversationId: CONV_ID,
        direction: 'outbound',
        createdAt: '2026-05-07T10:03:00.000Z',
        attachments: [
          { storagePath: '/chat-uploads/pasted-text-2.txt', type: 'file' },
          { storagePath: '/chat-uploads/pasted-text-1.txt', type: 'file' },
          { storagePath: '/chat-uploads/missing.txt', type: 'file' },
        ],
      },
    ];

    const result = getConversationAttachmentDiskPaths(CONV_ID);

    expect(result.imagePaths.map((entry) => path.basename(entry))).toEqual(['image-1.png']);
    expect(result.filePaths.map((entry) => path.basename(entry))).toEqual([
      'pasted-text-1.txt',
      'pasted-text-2.txt',
    ]);
  });

  it('limits attachments to the selected branch path when a leaf message is specified', () => {
    recordsByCollection.messages = [
      {
        id: 'u1',
        conversationId: CONV_ID,
        direction: 'outbound',
        parentId: null,
        previousUserMessageId: null,
        createdAt: '2026-05-07T10:00:00.000Z',
        attachments: [{ storagePath: '/chat-uploads/root.txt', type: 'file' }],
      },
      {
        id: 'a1',
        conversationId: CONV_ID,
        direction: 'inbound',
        parentId: 'u1',
        createdAt: '2026-05-07T10:01:00.000Z',
        attachments: [{ storagePath: '/chat-uploads/reply.txt', type: 'file' }],
      },
      {
        id: 'u2a',
        conversationId: CONV_ID,
        direction: 'outbound',
        parentId: 'a1',
        previousUserMessageId: 'u1',
        createdAt: '2026-05-07T10:02:00.000Z',
        attachments: [{ storagePath: '/chat-uploads/branch-a.txt', type: 'file' }],
      },
      {
        id: 'r2a',
        conversationId: CONV_ID,
        direction: 'inbound',
        parentId: 'u2a',
        createdAt: '2026-05-07T10:03:00.000Z',
        attachments: null,
      },
      {
        id: 'u2b',
        conversationId: CONV_ID,
        direction: 'outbound',
        parentId: 'a1',
        previousUserMessageId: 'u1',
        createdAt: '2026-05-07T10:04:00.000Z',
        attachments: [{ storagePath: '/chat-uploads/branch-b.txt', type: 'file' }],
      },
    ];

    const result = getConversationAttachmentDiskPaths(CONV_ID, 'r2a');

    expect(result.filePaths.map((entry) => path.basename(entry))).toEqual([
      'root.txt',
      'reply.txt',
      'branch-a.txt',
    ]);
  });

  it('activates the branch path that contains a searched message', () => {
    recordsByCollection.conversations = [
      {
        id: CONV_ID,
        metadata: JSON.stringify({
          activeBranches: {
            'user:root': 'u1',
            'reply:u1': 'a1',
            'user:u1': 'u2b',
            'reply:u2b': 'r2b',
          },
        }),
      },
    ];
    recordsByCollection.messages = [
      {
        id: 'u1',
        conversationId: CONV_ID,
        direction: 'outbound',
        parentId: null,
        previousUserMessageId: null,
        createdAt: '2026-05-07T10:00:00.000Z',
      },
      {
        id: 'a1',
        conversationId: CONV_ID,
        direction: 'inbound',
        parentId: 'u1',
        createdAt: '2026-05-07T10:01:00.000Z',
      },
      {
        id: 'u2a',
        conversationId: CONV_ID,
        direction: 'outbound',
        parentId: 'a1',
        previousUserMessageId: 'u1',
        createdAt: '2026-05-07T10:02:00.000Z',
      },
      {
        id: 'r2a',
        conversationId: CONV_ID,
        direction: 'inbound',
        parentId: 'u2a',
        createdAt: '2026-05-07T10:03:00.000Z',
      },
      {
        id: 'u2b',
        conversationId: CONV_ID,
        direction: 'outbound',
        parentId: 'a1',
        previousUserMessageId: 'u1',
        createdAt: '2026-05-07T10:04:00.000Z',
      },
      {
        id: 'r2b',
        conversationId: CONV_ID,
        direction: 'inbound',
        parentId: 'u2b',
        createdAt: '2026-05-07T10:05:00.000Z',
      },
    ];

    activateMessagePathForSearchResult(CONV_ID, 'r2a');

    expect(getActiveMessagePath(CONV_ID).map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2a',
      'r2a',
    ]);
    const metadata = JSON.parse(String(recordsByCollection.conversations[0].metadata));
    expect(metadata.activeBranches).toMatchObject({
      'user:root': 'u1',
      'reply:u1': 'a1',
      'user:u1': 'u2a',
      'reply:u2a': 'r2a',
    });
  });
});
