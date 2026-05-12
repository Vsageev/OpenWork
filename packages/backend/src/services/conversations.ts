import { listConversationsNative, markAllConversationsReadNative } from '../db/repositories/conversations-repository.js';
import { deleteAllMessageDraftsForConversationNative } from '../db/repositories/message-drafts-repository.js';
import { deleteAllMessagesForConversationNative, getLatestNonSystemMessageForConversationNative } from '../db/repositories/messages-repository.js';
import { store } from '../db/index.js';
import { createAuditLog } from './audit-log.js';
import { isAgentConversationRecord } from './conversation-scope.js';

export interface ConversationListQuery {
  contactId?: string;
  assigneeId?: string;
  channelType?: string;
  status?: string;
  isUnread?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CreateConversationData {
  contactId: string;
  assigneeId?: string;
  channelType: string;
  status?: string;
  subject?: string;
  externalId?: string;
  metadata?: string;
}

export interface UpdateConversationData {
  assigneeId?: string | null;
  status?: string;
  subject?: string | null;
  isUnread?: boolean;
  metadata?: string | null;
}

export async function listConversations(query: ConversationListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const { entries: conversations, total } = await listConversationsNative(
    { ...query, limit, offset },
    isAgentConversationRecord,
  );

  const entries = await Promise.all(conversations.map(async (conversation) => {
    const contact = conversation.contactId
      ? store.getById('contacts', conversation.contactId as string)
      : null;
    const assignee = conversation.assigneeId
      ? store.getById('users', conversation.assigneeId as string)
      : null;

    const lastMsg = await getLatestNonSystemMessageForConversationNative(conversation.id as string);
    let lastMessagePreview: string | null = null;
    if (lastMsg) {
      const type = lastMsg.type as string;
      const content = lastMsg.content as string | undefined;
      if (type === 'text' && content) {
        // Strip HTML tags and truncate
        const text = content.replace(/<[^>]+>/g, '').trim();
        lastMessagePreview = text.length > 120 ? text.slice(0, 120) + '…' : text || null;
      } else if (type === 'image') {
        lastMessagePreview = '📷 Photo';
      } else if (type === 'video') {
        lastMessagePreview = '🎥 Video';
      } else if (type === 'document') {
        lastMessagePreview = '📄 Document';
      } else if (type === 'voice') {
        lastMessagePreview = '🎤 Voice message';
      } else if (type === 'sticker') {
        lastMessagePreview = '🎭 Sticker';
      } else if (type === 'location') {
        lastMessagePreview = '📍 Location';
      }
    }

    return {
      ...conversation,
      lastMessagePreview,
      lastMessageDirection: (lastMsg?.direction as string | undefined) ?? null,
      contact: contact
        ? {
            id: contact.id,
            firstName: contact.firstName,
            lastName: contact.lastName,
            email: contact.email,
            phone: contact.phone,
          }
        : null,
      assignee: assignee
        ? {
            id: assignee.id,
            firstName: assignee.firstName,
            lastName: assignee.lastName,
          }
        : null,
    };
  }));

  return { entries, total };
}

export async function getConversationById(id: string) {
  const conversation = store.getById('conversations', id);
  if (!conversation || isAgentConversationRecord(conversation)) return null;

  const contact = conversation.contactId
    ? store.getById('contacts', conversation.contactId as string)
    : null;
  const assignee = conversation.assigneeId
    ? store.getById('users', conversation.assigneeId as string)
    : null;

  return {
    ...conversation,
    contact: contact
      ? {
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone,
        }
      : null,
    assignee: assignee
      ? {
          id: assignee.id,
          firstName: assignee.firstName,
          lastName: assignee.lastName,
        }
      : null,
  };
}

export async function createConversation(
  data: CreateConversationData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const conversation = store.insert('conversations', {
    ...data,
    status: data.status ?? 'open',
    isUnread: false,
  });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'conversation',
      entityId: conversation.id as string,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return conversation;
}

export async function updateConversation(
  id: string,
  data: UpdateConversationData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const existing = store.getById('conversations', id);
  if (!existing || isAgentConversationRecord(existing)) return null;

  const setData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setData[key] = value;
    }
  }

  // If closing, set closedAt
  if (data.status === 'closed') {
    setData.closedAt = new Date();
  }

  const updated = store.update('conversations', id, setData);

  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'conversation',
      entityId: id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return updated;
}

export async function markConversationRead(id: string) {
  const existing = store.getById('conversations', id);
  if (!existing || isAgentConversationRecord(existing)) return null;
  const updated = store.update('conversations', id, { isUnread: false });
  return updated ?? null;
}

export async function markAllConversationsRead(): Promise<number> {
  return markAllConversationsReadNative();
}

export async function deleteConversation(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const existing = store.getById('conversations', id);
  if (!existing || isAgentConversationRecord(existing)) return false;

  // Delete all messages and drafts belonging to this conversation
  await deleteAllMessagesForConversationNative(id);
  await deleteAllMessageDraftsForConversationNative(id);

  const deleted = store.delete('conversations', id);
  if (!deleted) return false;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'conversation',
      entityId: id,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return true;
}
