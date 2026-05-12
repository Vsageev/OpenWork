import { randomBytes } from 'node:crypto';
import { store } from '../db/index.js';
import {
  getWebhookRecordById,
  listActiveWebhooksForEvent,
  listWebhooksNative,
} from '../db/repositories/webhooks-repository.js';
import { createAuditLog } from './audit-log.js';

export interface WebhookListQuery {
  isActive?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CreateWebhookData {
  url: string;
  description?: string;
  events: string[];
  secret?: string;
  isActive?: boolean;
  createdById?: string;
}

export interface UpdateWebhookData {
  url?: string;
  description?: string | null;
  events?: string[];
  secret?: string;
  isActive?: boolean;
}

export async function listWebhooks(query: WebhookListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  return listWebhooksNative({
    isActive: query.isActive,
    search: query.search,
    limit,
    offset,
  });
}

export async function getWebhookById(id: string) {
  return (await getWebhookRecordById(id)) ?? null;
}

/**
 * Returns all active webhooks that subscribe to a given event name.
 * Used by the webhook delivery service to know which endpoints to call.
 */
export async function getActiveWebhooksByEvent(event: string) {
  return listActiveWebhooksForEvent(event);
}

export async function createWebhook(
  data: CreateWebhookData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const secret = data.secret || randomBytes(32).toString('hex');

  const webhook = store.insert('webhooks', {
    url: data.url,
    description: data.description,
    events: data.events,
    secret,
    isActive: data.isActive ?? true,
    createdById: data.createdById,
  });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'webhook',
      entityId: webhook.id as string,
      changes: { url: data.url, events: data.events } as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return webhook;
}

export async function updateWebhook(
  id: string,
  data: UpdateWebhookData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const setData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setData[key] = value;
    }
  }

  const updated = store.update('webhooks', id, setData);
  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'webhook',
      entityId: id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return updated;
}

export async function deleteWebhook(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const deleted = store.delete('webhooks', id);

  if (deleted && audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'webhook',
      entityId: id,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return deleted ?? null;
}
