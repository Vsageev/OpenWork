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

  const predicate = (r: Record<string, unknown>) => {
    if (isAgentConversationRecord(r)) return false;
    if (query.contactId && r.contactId !== query.contactId) return false;
    if (query.assigneeId && r.assigneeId !== query.assigneeId) return false;
    if (query.channelType && r.channelType !== query.channelType) return false;
    if (query.status && r.status !== query.status) return false;
    if (query.isUnread !== undefined && r.isUnread !== query.isUnread) return false;
    if (query.search) {
      const needle = query.search.toLowerCase();
      const subject = r.subject as string | undefined;
      const subjectMatch = subject?.toLowerCase().includes(needle);
      // Also search by contact name
      let contactMatch = false;
      if (r.contactId) {
        const contact = store.getById('contacts', r.contactId as string);
        if (contact) {
          const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').toLowerCase();
          contactMatch = fullName.includes(needle);
        }
      }
      if (!subjectMatch && !contactMatch) return false;
    }
    return true;
  };

  const allMatching = store.find('conversations', predicate);
  const total = allMatching.length;

  if (limit === 0) {
    return { entries: [], total };
  }

  const sorted = allMatching.sort((a, b) => {
    const aLast = new Date(a.lastMessageAt as string).getTime() || 0;
    const bLast = new Date(b.lastMessageAt as string).getTime() || 0;
    if (bLast !== aLast) return bLast - aLast;
    return new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime();
  });

  const entries = sorted.slice(offset, offset + limit).map((conversation) => {
    const contact = conversation.contactId
      ? store.getById('contacts', conversation.contactId as string)
      : null;
    const assignee = conversation.assigneeId
      ? store.getById('users', conversation.assigneeId as string)
      : null;

    // Find last non-system message for preview
    const convMessages = store.find('messages', (r: Record<string, unknown>) =>
      r.conversationId === conversation.id && r.type !== 'system'
    );
    const lastMsg = convMessages.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime()
    )[0] as Record<string, unknown> | undefined;

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
  });

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
  const conversation = store.insert('conversations', { ...data });

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

export function markAllConversationsRead(): number {
  const unread = store.find(
    'conversations',
    (r: Record<string, unknown>) => r.isUnread === true && !isAgentConversationRecord(r),
  );
  for (const conv of unread) {
    store.update('conversations', conv.id as string, { isUnread: false });
  }
  return unread.length;
}

export async function deleteConversation(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const existing = store.getById('conversations', id);
  if (!existing || isAgentConversationRecord(existing)) return false;

  // Delete all messages and drafts belonging to this conversation
  store.deleteWhere('messages', (r: any) => r.conversationId === id);
  store.deleteWhere('messageDrafts', (r: any) => r.conversationId === id);

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
