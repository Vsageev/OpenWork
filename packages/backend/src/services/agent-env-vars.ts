import { store } from '../db/index.js';
import { createAuditLog } from './audit-log.js';
import { decryptSecret, encryptSecret } from '../lib/secret-crypto.js';

const COLLECTION = 'agentEnvVars';
const RESERVED_ENV_VAR_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'HOME',
  'NODE_ENV',
  'OPENAI_API_KEY',
  'PATH',
  'PROJECTS_DIR',
  'PROJECT_PORT',
  'PWD',
  'SHELL',
  'WORKSPACE_API_KEY',
  'WORKSPACE_API_URL',
]);

export interface AgentEnvVarRecord {
  id: string;
  agentId: string;
  key: string;
  description: string | null;
  encryptedValue: string;
  valuePreview: string;
  isActive: boolean;
  createdById: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicAgentEnvVarRecord = Omit<AgentEnvVarRecord, 'encryptedValue'>;

export interface CreateAgentEnvVarParams {
  agentId: string;
  key: string;
  value: string;
  description?: string;
  createdById: string;
  isActive?: boolean;
}

export interface UpdateAgentEnvVarParams {
  key?: string;
  value?: string;
  description?: string | null;
  isActive?: boolean;
}

function normalizeEnvVarKey(value: string): string {
  return value.trim().toUpperCase();
}

function assertValidEnvVarKey(value: string): string {
  const normalized = normalizeEnvVarKey(value);

  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(normalized)) {
    throw new Error('key must match ^[A-Z][A-Z0-9_]{0,127}$');
  }

  if (RESERVED_ENV_VAR_KEYS.has(normalized)) {
    throw new Error(`key "${normalized}" is reserved`);
  }

  return normalized;
}

function assertNonEmptyValue(value: string | undefined, fieldName: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length || 1);
  return `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function sanitize(record: Record<string, unknown>): PublicAgentEnvVarRecord {
  const rest = { ...record };
  delete rest.encryptedValue;

  return {
    id: String(rest.id),
    agentId: String(rest.agentId),
    key: String(rest.key ?? ''),
    description: typeof rest.description === 'string' ? rest.description : null,
    valuePreview: String(rest.valuePreview ?? ''),
    isActive: rest.isActive !== false,
    createdById: String(rest.createdById ?? ''),
    lastUsedAt: typeof rest.lastUsedAt === 'string' ? rest.lastUsedAt : null,
    createdAt: String(rest.createdAt ?? ''),
    updatedAt: String(rest.updatedAt ?? ''),
  };
}

function assertNoKeyCollision(agentId: string, key: string, excludeId?: string): void {
  const existing = store.find(COLLECTION, (record) => {
    if (record.agentId !== agentId) return false;
    if (excludeId && record.id === excludeId) return false;
    return normalizeEnvVarKey(String(record.key ?? '')) === key;
  });

  if (existing.length > 0) {
    throw new Error(`key "${key}" already exists for this agent`);
  }
}

export function listAgentEnvVars(agentId: string): PublicAgentEnvVarRecord[] {
  return store
    .find(COLLECTION, (record) => record.agentId === agentId)
    .sort((left, right) => {
      const leftActive = left.isActive !== false ? 1 : 0;
      const rightActive = right.isActive !== false ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;

      return String(left.key ?? '').localeCompare(String(right.key ?? ''));
    })
    .map(sanitize);
}

export function getAgentEnvVar(agentId: string, id: string): PublicAgentEnvVarRecord | null {
  const record = store.getById(COLLECTION, id);
  if (!record || record.agentId !== agentId) return null;
  return sanitize(record);
}

export async function createAgentEnvVar(
  params: CreateAgentEnvVarParams,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
): Promise<PublicAgentEnvVarRecord> {
  const key = assertValidEnvVarKey(params.key);
  const value = assertNonEmptyValue(params.value, 'value');
  assertNoKeyCollision(params.agentId, key);

  const record = store.insert(COLLECTION, {
    agentId: params.agentId,
    key,
    description: params.description?.trim() || null,
    encryptedValue: encryptSecret(value),
    valuePreview: maskValue(value),
    isActive: params.isActive !== false,
    createdById: params.createdById,
    lastUsedAt: null,
  });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'agent_env_var',
      entityId: String(record.id),
      changes: {
        agentId: params.agentId,
        key,
        description: params.description?.trim() || null,
        isActive: params.isActive !== false,
      },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return sanitize(record);
}

export async function updateAgentEnvVar(
  agentId: string,
  id: string,
  params: UpdateAgentEnvVarParams,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
): Promise<PublicAgentEnvVarRecord | null> {
  const existing = store.getById(COLLECTION, id);
  if (!existing || existing.agentId !== agentId) return null;

  const patch: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};

  if (params.key !== undefined) {
    const key = assertValidEnvVarKey(params.key);
    assertNoKeyCollision(agentId, key, id);
    patch.key = key;
    changes.key = key;
  }

  if (params.value !== undefined) {
    if (params.value.length === 0) {
      throw new Error('value cannot be empty');
    }
    patch.encryptedValue = encryptSecret(params.value);
    patch.valuePreview = maskValue(params.value);
    changes.valueUpdated = true;
  }

  if (params.description !== undefined) {
    patch.description = params.description?.trim() || null;
    changes.description = patch.description;
  }

  if (params.isActive !== undefined) {
    patch.isActive = params.isActive;
    changes.isActive = params.isActive;
  }

  const updated = store.update(COLLECTION, id, patch);
  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'agent_env_var',
      entityId: id,
      changes,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return sanitize(updated);
}

export async function deleteAgentEnvVar(
  agentId: string,
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
): Promise<boolean> {
  const existing = store.getById(COLLECTION, id);
  if (!existing || existing.agentId !== agentId) return false;

  const deleted = store.delete(COLLECTION, id);
  if (!deleted) return false;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'agent_env_var',
      entityId: id,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return true;
}

export function deleteAgentEnvVarsByAgentId(agentId: string): void {
  store.deleteWhere(COLLECTION, (record) => record.agentId === agentId);
}

export function listRuntimeAgentEnvVarBindings(
  agentId: string,
): Array<{ key: string; value: string; description: string | null }> {
  const activeRecords = store.find(
    COLLECTION,
    (record) => record.agentId === agentId && record.isActive !== false,
  );

  if (activeRecords.length === 0) return [];

  const now = new Date().toISOString();

  return activeRecords.map((record) => {
    store.update(COLLECTION, String(record.id), { lastUsedAt: now });

    return {
      key: String(record.key ?? ''),
      value: decryptSecret(String(record.encryptedValue ?? '')),
      description: typeof record.description === 'string' ? record.description : null,
    };
  });
}
