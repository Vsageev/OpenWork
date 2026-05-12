import { store } from '../db/index.js';
import {
  findAgentEnvVarIdByAgentAndKey,
  getAgentEnvVarRecordById,
  listActiveAgentEnvVarIdsForAgent,
  listAgentEnvVarIdsForAgent,
  listAgentEnvVarRecordsForAgent,
} from '../db/repositories/agent-env-vars-repository.js';
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

async function assertNoKeyCollision(agentId: string, key: string, excludeId?: string): Promise<void> {
  const existingId = await findAgentEnvVarIdByAgentAndKey(agentId, key, excludeId);
  if (existingId) {
    throw new Error(`key "${key}" already exists for this agent`);
  }
}

export async function listAgentEnvVars(agentId: string): Promise<PublicAgentEnvVarRecord[]> {
  const rows = await listAgentEnvVarRecordsForAgent(agentId);
  return rows.map(sanitize);
}

export async function getAgentEnvVar(agentId: string, id: string): Promise<PublicAgentEnvVarRecord | null> {
  const record = await getAgentEnvVarRecordById(id);
  if (!record || record.agentId !== agentId) return null;
  return sanitize(record);
}

export async function createAgentEnvVar(
  params: CreateAgentEnvVarParams,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
): Promise<PublicAgentEnvVarRecord> {
  const key = assertValidEnvVarKey(params.key);
  const value = assertNonEmptyValue(params.value, 'value');
  await assertNoKeyCollision(params.agentId, key);

  const record = await store.insert(COLLECTION, {
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
  const existing = await getAgentEnvVarRecordById(id);
  if (!existing || existing.agentId !== agentId) return null;

  const patch: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};

  if (params.key !== undefined) {
    const key = assertValidEnvVarKey(params.key);
    await assertNoKeyCollision(agentId, key, id);
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

  const updated = await store.update(COLLECTION, id, patch);
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
  const existing = await getAgentEnvVarRecordById(id);
  if (!existing || existing.agentId !== agentId) return false;

  const deleted = await store.delete(COLLECTION, id);
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

export async function deleteAgentEnvVarsByAgentId(agentId: string): Promise<void> {
  const ids = await listAgentEnvVarIdsForAgent(agentId);
  for (const envId of ids) {
    await store.delete(COLLECTION, envId);
  }
}

export async function listRuntimeAgentEnvVarBindings(
  agentId: string,
): Promise<Array<{ key: string; value: string; description: string | null }>> {
  const ids = await listActiveAgentEnvVarIdsForAgent(agentId);

  if (ids.length === 0) return [];

  const now = new Date().toISOString();
  const result: Array<{ key: string; value: string; description: string | null }> = [];

  for (const id of ids) {
    const record = await getAgentEnvVarRecordById(id);
    if (!record || record.agentId !== agentId || record.isActive === false) continue;

    await store.update(COLLECTION, id, { lastUsedAt: now });

    result.push({
      key: String(record.key ?? ''),
      value: decryptSecret(String(record.encryptedValue ?? '')),
      description: typeof record.description === 'string' ? record.description : null,
    });
  }

  return result;
}
