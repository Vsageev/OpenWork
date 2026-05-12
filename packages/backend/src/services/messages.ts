import { listMessagesByConversationIdNative } from '../db/repositories/messages-repository.js';
import { store } from '../db/index.js';
import { createAuditLog } from './audit-log.js';
import { isAgentConversationRecord } from './conversation-scope.js';

export interface MessageListQuery {
  conversationId: string;
  limit?: number;
  offset?: number;
}

export interface SendMessageData {
  conversationId: string;
  senderId?: string;
  direction: 'inbound' | 'outbound';
  type?: 'text' | 'image' | 'video' | 'document' | 'voice' | 'sticker' | 'location' | 'system';
  content?: string;
  externalId?: string;
  attachments?: unknown;
  metadata?: string;
}

export async function listMessages(query: MessageListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const conversation = store.getById('conversations', query.conversationId);
  if (!conversation || isAgentConversationRecord(conversation)) {
    return { entries: [], total: 0 };
  }

  const { entries: messages, total } = await listMessagesByConversationIdNative(query.conversationId, {
    order: 'desc',
    limit,
    offset,
  });

  const entries = messages.map((message) => {
    const sender = message.senderId
      ? store.getById('users', message.senderId as string)
      : null;

    return {
      ...message,
      sender: sender
        ? {
            id: sender.id,
            firstName: sender.firstName,
            lastName: sender.lastName,
          }
        : null,
    };
  });

  return { entries, total };
}

export async function getMessageById(id: string) {
  const message = store.getById('messages', id);
  if (!message) return null;
  const conversation = store.getById('conversations', message.conversationId as string);
  if (!conversation || isAgentConversationRecord(conversation)) return null;

  const sender = message.senderId
    ? store.getById('users', message.senderId as string)
    : null;

  return {
    ...message,
    sender: sender
      ? {
          id: sender.id,
          firstName: sender.firstName,
          lastName: sender.lastName,
        }
      : null,
  };
}

export async function sendMessage(
  data: SendMessageData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  // Verify conversation exists
  const conversation = store.getById('conversations', data.conversationId);
  if (!conversation || isAgentConversationRecord(conversation)) return null;

  const message = await store.transaction(async () => {
    const created = await store.insert('messages', {
      conversationId: data.conversationId,
      senderId: data.senderId,
      direction: data.direction,
      type: data.type ?? 'text',
      content: data.content,
      status: data.direction === 'outbound' ? 'sent' : 'delivered',
      externalId: data.externalId,
      attachments: data.attachments,
      metadata: data.metadata,
    });

    // Update conversation's lastMessageAt and mark unread for inbound
    await store.update('conversations', data.conversationId, {
      lastMessageAt: new Date().toISOString(),
      isUnread: data.direction === 'inbound',
    });

    return created;
  });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'message',
      entityId: message.id as string,
      changes: {
        conversationId: data.conversationId,
        direction: data.direction,
        type: data.type ?? 'text',
      },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return message;
}

export async function updateMessageStatus(
  id: string,
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed',
) {
  const message = store.getById('messages', id);
  if (!message) return null;
  const conversation = store.getById('conversations', message.conversationId as string);
  if (!conversation || isAgentConversationRecord(conversation)) return null;
  const updated = await store.update('messages', id, { status });
  return updated ?? null;
}
