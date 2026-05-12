import {
  deleteAllMessageDraftsForConversationNative,
  findMessageDraftByConversationIdNative,
  listMessageDraftsNative,
} from '../db/repositories/message-drafts-repository.js';
import { store } from '../db/index.js';
import { isAgentConversationRecord } from './conversation-scope.js';

export interface DraftListQuery {
  conversationId?: string;
  limit?: number;
  offset?: number;
}

export interface UpsertDraftData {
  conversationId: string;
  content: string;
  attachments?: unknown;
  metadata?: string;
}

export async function listDrafts(query: DraftListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  return listMessageDraftsNative({ ...query, limit, offset });
}

export async function getDraftById(id: string) {
  const draft = store.getById('messageDrafts', id);
  if (!draft) return null;
  const conversation = store.getById('conversations', draft.conversationId as string);
  if (!conversation || isAgentConversationRecord(conversation)) return null;
  return draft;
}

export async function upsertDraft(data: UpsertDraftData) {
  const conversation = store.getById('conversations', data.conversationId);
  if (!conversation || isAgentConversationRecord(conversation)) return null;

  const existing = await findMessageDraftByConversationIdNative(data.conversationId);

  if (existing) {
    const updated = store.update('messageDrafts', existing.id as string, {
      content: data.content,
      attachments: data.attachments ?? null,
      metadata: data.metadata ?? null,
    });
    return updated;
  }

  return store.insert('messageDrafts', {
    conversationId: data.conversationId,
    content: data.content,
    attachments: data.attachments ?? null,
    metadata: data.metadata ?? null,
  });
}

export async function deleteDraft(id: string) {
  const draft = store.getById('messageDrafts', id);
  if (!draft) return false;
  const conversation = store.getById('conversations', draft.conversationId as string);
  if (!conversation || isAgentConversationRecord(conversation)) return false;
  return store.delete('messageDrafts', id);
}

export async function deleteDraftByConversationId(conversationId: string) {
  const conversation = store.getById('conversations', conversationId);
  if (!conversation || isAgentConversationRecord(conversation)) return false;

  const existing = await findMessageDraftByConversationIdNative(conversationId);
  if (!existing) return false;

  await deleteAllMessageDraftsForConversationNative(conversationId);
  return true;
}
