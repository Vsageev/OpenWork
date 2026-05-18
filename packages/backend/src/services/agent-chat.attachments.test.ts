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
    update: (col: string, id: string, patch: Record<string, unknown>) => mockUpdate(col, id, patch),
  },
}));

import {
  activateMessagePathForSearchResult,
  getActiveMessagePath,
  getConversationAttachmentDiskPaths,
  serializeAllConversationMessageEntries,
  updateQueueItem,
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
    mockGetById.mockImplementation(
      (col: string, id: string) =>
        (recordsByCollection[col] ?? []).find((record) => record.id === id) ?? null,
    );
    mockUpdate.mockImplementation((col: string, id: string, patch: Record<string, unknown>) => {
      const record = (recordsByCollection[col] ?? []).find((entry) => entry.id === id);
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    });

    vi.spyOn(fs, 'existsSync').mockImplementation((targetPath) => {
      const normalized = typeof targetPath === 'string' ? targetPath : targetPath.toString();
      return !normalized.includes('missing');
    });
  });

  it('stores attachments on a queued prompt before its future message exists', () => {
    recordsByCollection.agentChatQueue = [
      {
        id: 'queue-1',
        agentId: 'agent-1',
        conversationId: CONV_ID,
        mode: 'append_prompt',
        prompt: 'Attach this later',
        status: 'queued',
        queuedMessageId: 'queued-message-1',
      },
    ];

    const updated = updateQueueItem('queue-1', 'agent-1', CONV_ID, {
      prompt: '',
      attachments: [
        {
          storagePath: '/chat-uploads/spec.txt',
          fileName: 'spec.txt',
          type: 'file',
          mimeType: 'text/plain',
          fileSize: 12,
        },
      ],
      keepStoragePaths: [],
    });

    expect(updated).not.toBeNull();
    expect(updated!.prompt).toBe('');
    expect(updated!.attachments).toEqual([
      {
        storagePath: '/chat-uploads/spec.txt',
        fileName: 'spec.txt',
        type: 'file',
        mimeType: 'text/plain',
        fileSize: 12,
      },
    ]);
  });

  it('edits the target message for queued branch-response items', () => {
    recordsByCollection.messages = [
      {
        id: 'target-message-1',
        conversationId: CONV_ID,
        direction: 'outbound',
        type: 'text',
        content: 'Original branch prompt',
        attachments: null,
      },
    ];
    recordsByCollection.agentChatQueue = [
      {
        id: 'queue-branch-1',
        agentId: 'agent-1',
        conversationId: CONV_ID,
        mode: 'respond_to_message',
        prompt: '',
        status: 'queued',
        targetMessageId: 'target-message-1',
      },
    ];

    const updated = updateQueueItem('queue-branch-1', 'agent-1', CONV_ID, {
      prompt: 'Updated branch prompt',
    });

    expect(updated).toMatchObject({
      id: 'queue-branch-1',
      mode: 'respond_to_message',
      prompt: '',
    });
    expect(recordsByCollection.messages[0]).toMatchObject({
      id: 'target-message-1',
      content: 'Updated branch prompt',
      type: 'text',
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
    expect(result.attachments).toMatchObject([
      {
        type: 'file',
        filename: 'pasted-text-1.txt',
        mimeType: 'text/plain',
        textExtraction: { status: 'available' },
        manifest: { storagePath: '/chat-uploads/pasted-text-1.txt' },
      },
      {
        type: 'image',
        filename: 'image-1.png',
        mimeType: 'image/png',
        textExtraction: { status: 'not_applicable' },
        manifest: { storagePath: '/chat-uploads/image-1.png' },
      },
      {
        type: 'file',
        filename: 'pasted-text-2.txt',
        mimeType: 'text/plain',
        textExtraction: { status: 'available' },
        manifest: { storagePath: '/chat-uploads/pasted-text-2.txt' },
      },
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
          agentId: 'agent-1',
          activeBranches: {
            'turn:__root__': 'turn-u1',
            'turn:turn-u1': 'turn-u2b',
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
    recordsByCollection.agentChatTurns = [
      {
        id: 'turn-u1',
        agentId: 'agent-1',
        conversationId: CONV_ID,
        parentTurnId: null,
        userMessageId: 'u1',
        assistantMessageId: 'a1',
        status: 'completed',
        turnType: 'follow_up',
        createdAt: '2026-05-07T10:00:00.000Z',
      },
      {
        id: 'turn-u2a',
        agentId: 'agent-1',
        conversationId: CONV_ID,
        parentTurnId: 'turn-u1',
        userMessageId: 'u2a',
        assistantMessageId: 'r2a',
        status: 'completed',
        turnType: 'follow_up',
        createdAt: '2026-05-07T10:02:00.000Z',
      },
      {
        id: 'turn-u2b',
        agentId: 'agent-1',
        conversationId: CONV_ID,
        parentTurnId: 'turn-u1',
        userMessageId: 'u2b',
        assistantMessageId: 'r2b',
        status: 'completed',
        turnType: 'follow_up',
        createdAt: '2026-05-07T10:04:00.000Z',
      },
    ];

    activateMessagePathForSearchResult(CONV_ID, 'r2a');

    const metadata = JSON.parse(String(recordsByCollection.conversations[0].metadata));
    expect(metadata.activeBranches).toMatchObject({
      'turn:__root__': 'turn-u1',
      'turn:turn-u1': 'turn-u2a',
    });
  });

  it('collapses duplicate final assistant messages from the same run and parent', () => {
    recordsByCollection.conversations = [
      {
        id: CONV_ID,
        metadata: JSON.stringify({
          activeBranches: {
            'user:root': 'u1',
            'reply:u1': 'r1-duplicate',
          },
        }),
      },
    ];
    recordsByCollection.messages = [
      {
        id: 'u1',
        conversationId: CONV_ID,
        direction: 'outbound',
        content: 'do the work',
        parentId: null,
        createdAt: '2026-05-16T01:20:55.088Z',
      },
      {
        id: 'r1',
        conversationId: CONV_ID,
        direction: 'inbound',
        content: 'done',
        parentId: 'u1',
        metadata: JSON.stringify({ runId: 'run-1', model: 'codex' }),
        createdAt: '2026-05-16T01:23:10.102Z',
      },
      {
        id: 'r1-duplicate',
        conversationId: CONV_ID,
        direction: 'inbound',
        content: 'done',
        parentId: 'u1',
        metadata: JSON.stringify({ runId: 'run-1', model: 'codex' }),
        createdAt: '2026-05-16T01:23:10.140Z',
      },
    ];

    expect(getActiveMessagePath(CONV_ID).map((message) => message.id)).toEqual(['u1', 'r1']);
    expect(serializeAllConversationMessageEntries(CONV_ID).map((message) => message.id)).toEqual([
      'u1',
      'r1',
    ]);
  });
});
