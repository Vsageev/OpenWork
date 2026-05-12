import { randomBytes, createHash } from 'node:crypto';
import {
  deleteApiKeyRecord,
  filterApiKeysByCreatedById,
  findActiveApiKeyByKeyHash,
  getApiKeyRecord,
  insertApiKeyRecord,
  listApiKeyRecords,
  updateApiKeyRecord,
} from '../db/repositories/api-keys-repository.js';
import { createAuditLog } from './audit-log.js';

const API_KEY_BYTE_LENGTH = 32;
const API_KEY_PREFIX = 'ws_';

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function isActive(record: Record<string, unknown>): boolean {
  return record.isActive === true;
}

export interface CreateApiKeyParams {
  name: string;
  permissions: string[];
  createdById: string;
  description?: string;
  expiresAt?: Date;
}

export interface UpdateApiKeyParams {
  name?: string;
  permissions?: string[];
  description?: string | null;
  isActive?: boolean;
  expiresAt?: Date | null;
}

// Fields to expose (exclude keyHash)
function sanitize(record: Record<string, unknown>) {
  const rest = { ...record };
  delete rest.keyHash;
  return {
    ...rest,
    isActive: isActive(rest),
    expiresAt: rest.expiresAt ?? null,
    lastUsedAt: rest.lastUsedAt ?? null,
    description: rest.description ?? null,
  };
}

/**
 * Create a new API key. Returns the full key (only shown once) along with
 * the persisted record.
 */
export async function createApiKey(
  params: CreateApiKeyParams,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const rawKey = API_KEY_PREFIX + randomBytes(API_KEY_BYTE_LENGTH).toString('base64url');
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8);

  const record = await insertApiKeyRecord({
    name: params.name,
    keyHash,
    keyPrefix,
    permissions: params.permissions,
    createdById: params.createdById,
    isActive: true,
    description: params.description ?? null,
    expiresAt: params.expiresAt ?? null,
    lastUsedAt: null,
  });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'api_key',
      entityId: record.id as string,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return { ...sanitize(record), rawKey };
}

/**
 * List all API keys for a given user (or all if userId is omitted — admin).
 */
export async function listApiKeys(filters?: { createdById?: string; limit?: number; offset?: number }) {
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const all = (
    filters?.createdById
      ? await filterApiKeysByCreatedById(filters.createdById)
      : await listApiKeyRecords()
  ).sort(
    (a, b) =>
      new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime(),
  );

  const total = all.length;
  const entries = all.slice(offset, offset + limit).map(sanitize);

  return { entries, total };
}

/**
 * Get a single API key by id (never returns the hash).
 */
export async function getApiKeyById(id: string) {
  const key = await getApiKeyRecord(id);
  if (!key) return null;
  return sanitize(key);
}

/**
 * Update an API key.
 */
export async function updateApiKey(
  id: string,
  params: UpdateApiKeyParams,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const updated = await updateApiKeyRecord(id, params as Record<string, unknown>);
  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'api_key',
      entityId: id,
      changes: params as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return sanitize(updated);
}

/**
 * Delete (revoke) an API key.
 */
export async function deleteApiKey(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const deleted = await deleteApiKeyRecord(id);

  if (!deleted) return false;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'api_key',
      entityId: id,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return true;
}

/**
 * Validate a raw API key. Returns the key record if valid, null otherwise.
 * Also updates lastUsedAt timestamp.
 */
export async function validateApiKey(rawKey: string) {
  const keyHash = hashKey(rawKey);

  const key = await findActiveApiKeyByKeyHash(keyHash);

  if (!key) return null;

  // Check expiry
  if (key.expiresAt && new Date(key.expiresAt as string) < new Date()) {
    return null;
  }

  // Update lastUsedAt (fire-and-forget)
  try {
    await updateApiKeyRecord(key.id as string, { lastUsedAt: new Date() } as Record<string, unknown>);
  } catch {
    // ignore
  }

  return key;
}
