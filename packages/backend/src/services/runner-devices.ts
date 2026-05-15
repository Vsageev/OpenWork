import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RunnerAgentKind, RunnerApprovalMode, RunnerProvider, RunnerProtocolVersion } from 'shared';
import { store } from '../db/index.js';
import { createAuditLog } from './audit-log.js';
import { getWorkspaceById } from './workspaces.js';

export interface RunnerCapabilities {
  protocolVersion?: RunnerProtocolVersion;
  os?: string;
  arch?: string;
  runnerVersion?: string;
  version?: string;
  workspaceRoot?: string;
  supportedAgentKinds?: RunnerAgentKind[];
  supportedProviders?: RunnerProvider[];
  supportsCancellation?: boolean;
  supportsArtifacts?: boolean;
  policy?: {
    workspaceRootRequired?: boolean;
    allowedTools?: RunnerProvider[];
    approvalModes?: RunnerApprovalMode[];
    envAccess?: boolean;
    secretAccess?: boolean;
    network?: boolean;
    shell?: boolean;
  };
  models?: string[];
  commands?: string[];
}

export interface AuditCtx {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface RunnerRecord {
  id: string;
  userId: string;
  workspaceId: string;
  displayName: string;
  credentialHash: string;
  credentialPrefix: string;
  status: string;
  lastSeenAt: string | null;
  version: string | null;
  capabilities: RunnerCapabilities;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerRoutingScope {
  userId: string;
  workspaceId: string;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const RUNNER_STALE_AFTER_MS = 2 * 60 * 1000;
export type RunnerLiveStatus = 'online' | 'busy' | 'stale';

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function publicRunner(record: Record<string, unknown>, liveStatus?: RunnerLiveStatus) {
  const lastSeenAt = typeof record.lastSeenAt === 'string' ? record.lastSeenAt : null;
  const revokedAt = typeof record.revokedAt === 'string' ? record.revokedAt : null;
  let status = 'offline';
  if (revokedAt) {
    status = 'revoked';
  } else if (liveStatus) {
    status = liveStatus;
  }

  return {
    id: String(record.id),
    userId: String(record.userId),
    workspaceId: String(record.workspaceId),
    displayName: String(record.displayName),
    status,
    lastSeenAt,
    version: typeof record.version === 'string' ? record.version : null,
    capabilities:
      record.capabilities && typeof record.capabilities === 'object'
        ? (record.capabilities as RunnerCapabilities)
        : {},
    revoked: Boolean(revokedAt),
    revokedAt,
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  };
}

function normalizeCode(code: string): string {
  return code.trim().replace(/[\s-]/g, '').toUpperCase();
}

function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = randomBytes(8);
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

function generateCredential(): string {
  return `owrun_${randomBytes(32).toString('base64url')}`;
}

export async function createRunnerPairingCode(
  params: { userId: string; workspaceId: string; displayName: string },
  audit?: AuditCtx,
) {
  const workspace = await getWorkspaceById(params.workspaceId);
  if (!workspace || workspace.userId !== params.userId) {
    throw new Error('Workspace not found');
  }

  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
  const record = await store.insert('agentRunnerPairingCodes', {
    userId: params.userId,
    workspaceId: params.workspaceId,
    displayName: params.displayName.trim() || 'Runner',
    codeHash: hashSecret(normalizeCode(code)),
    expiresAt,
    usedAt: null,
  });

  await createAuditLog({
    userId: audit?.userId ?? params.userId,
    action: 'runner_pairing_code_created',
    entityType: 'agent_runner_pairing_code',
    entityId: String(record.id),
    changes: { workspaceId: params.workspaceId, displayName: params.displayName },
    ipAddress: audit?.ipAddress,
    userAgent: audit?.userAgent,
  });

  return { id: String(record.id), code, expiresAt };
}

export async function pairRunnerWithCode(params: {
  code: string;
  displayName?: string;
  version?: string;
  capabilities?: RunnerCapabilities;
}) {
  const codeHash = hashSecret(normalizeCode(params.code));
  const now = new Date().toISOString();
  const pairing = store
    .getAll('agentRunnerPairingCodes')
    .find(
      (record) =>
        typeof record.codeHash === 'string' &&
        safeEqualHex(record.codeHash, codeHash) &&
        !record.usedAt &&
        new Date(String(record.expiresAt)).getTime() > Date.now(),
    );

  if (!pairing) {
    await createAuditLog({
      action: 'runner_pairing_failed',
      entityType: 'agent_runner',
      changes: { reason: 'invalid_or_expired_code' },
    });
    throw new Error('Invalid or expired pairing code');
  }

  const credential = generateCredential();
  const displayName =
    params.displayName?.trim() || String(pairing.displayName || '').trim() || 'Runner';
  const runner = await store.insert('agentRunners', {
    userId: pairing.userId,
    workspaceId: pairing.workspaceId,
    displayName,
    credentialHash: hashSecret(credential),
    credentialPrefix: credential.slice(0, 12),
    status: 'offline',
    lastSeenAt: now,
    version: params.version ?? null,
    capabilities: params.capabilities ?? {},
    revokedAt: null,
  });
  await store.update('agentRunnerPairingCodes', String(pairing.id), { usedAt: now });

  await createAuditLog({
    userId: String(pairing.userId),
    action: 'runner_paired',
    entityType: 'agent_runner',
    entityId: String(runner.id),
    changes: { workspaceId: pairing.workspaceId, displayName },
  });

  return { runner: publicRunner(runner), credential };
}

export async function authenticateRunnerCredential(credential: string): Promise<RunnerRecord | null> {
  const hash = hashSecret(credential);
  const record = store
    .getAll('agentRunners')
    .find((candidate) => typeof candidate.credentialHash === 'string' && safeEqualHex(candidate.credentialHash, hash));
  if (!record) {
    await createAuditLog({
      action: 'runner_auth_failed',
      entityType: 'agent_runner',
      changes: { reason: 'unknown_credential' },
    });
    return null;
  }
  if (record.revokedAt) {
    await createAuditLog({
      userId: String(record.userId),
      action: 'runner_auth_failed',
      entityType: 'agent_runner',
      entityId: String(record.id),
      changes: { reason: 'revoked' },
    });
    return null;
  }
  return record as unknown as RunnerRecord;
}

export async function noteRunnerConnected(
  runnerId: string,
  params: { displayName?: string; version?: string; capabilities?: RunnerCapabilities },
) {
  const patch: Record<string, unknown> = {
    status: 'online',
    lastSeenAt: new Date().toISOString(),
  };
  if (params.displayName) patch.displayName = params.displayName;
  if (params.version !== undefined) patch.version = params.version;
  if (params.capabilities) patch.capabilities = params.capabilities;
  const updated = await store.update('agentRunners', runnerId, patch);
  if (updated) {
    await createAuditLog({
      userId: String(updated.userId),
      action: 'runner_reconnected',
      entityType: 'agent_runner',
      entityId: runnerId,
      changes: { workspaceId: updated.workspaceId },
    });
  }
}

export function noteRunnerSeen(runnerId: string, status: 'online' | 'busy' = 'online') {
  store.update('agentRunners', runnerId, {
    status,
    lastSeenAt: new Date().toISOString(),
  });
}

export function noteRunnerDisconnected(runnerId: string) {
  store.update('agentRunners', runnerId, { status: 'offline' });
}

export function listRunnerDevices(
  userId: string,
  workspaceId: string | undefined,
  liveStatus: Map<string, RunnerLiveStatus>,
) {
  return store
    .getAll('agentRunners')
    .filter((record) => record.userId === userId && (!workspaceId || record.workspaceId === workspaceId))
    .sort((a, b) => new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime())
    .map((record) => publicRunner(record, liveStatus.get(String(record.id))));
}

export async function renameRunnerDevice(
  userId: string,
  runnerId: string,
  displayName: string,
  audit?: AuditCtx,
) {
  const runner = store.getById('agentRunners', runnerId);
  if (!runner || runner.userId !== userId) return null;
  const updated = await store.update('agentRunners', runnerId, { displayName: displayName.trim() });
  await createAuditLog({
    userId,
    action: 'runner_renamed',
    entityType: 'agent_runner',
    entityId: runnerId,
    changes: { displayName },
    ipAddress: audit?.ipAddress,
    userAgent: audit?.userAgent,
  });
  return updated ? publicRunner(updated) : null;
}

export async function revokeRunnerDevice(userId: string, runnerId: string, audit?: AuditCtx) {
  const runner = store.getById('agentRunners', runnerId);
  if (!runner || runner.userId !== userId) return null;
  const updated = await store.update('agentRunners', runnerId, {
    revokedAt: new Date().toISOString(),
    status: 'revoked',
  });
  await createAuditLog({
    userId,
    action: 'runner_revoked',
    entityType: 'agent_runner',
    entityId: runnerId,
    changes: { workspaceId: runner.workspaceId },
    ipAddress: audit?.ipAddress,
    userAgent: audit?.userAgent,
  });
  return updated ? publicRunner(updated) : null;
}

export function workspaceIdsForAgentGroup(groupId: string | null | undefined): string[] {
  return runnerRoutingScopesForAgentGroup(groupId).map((scope) => scope.workspaceId);
}

export function runnerRoutingScopesForAgentGroup(
  groupId: string | null | undefined,
): RunnerRoutingScope[] {
  if (!groupId) return [];

  const seen = new Set<string>();
  const scopes: RunnerRoutingScope[] = [];

  for (const workspace of store.getAll('workspaces')) {
    if (!Array.isArray(workspace.agentGroupIds) || !workspace.agentGroupIds.includes(groupId)) {
      continue;
    }

    const userId = typeof workspace.userId === 'string' ? workspace.userId : '';
    const workspaceId = typeof workspace.id === 'string' ? workspace.id : '';
    if (!userId || !workspaceId) continue;

    const key = `${userId}:${workspaceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ userId, workspaceId });
  }

  return scopes;
}
