import { randomUUID } from 'node:crypto';
import { store } from '../db/index.js';
import { maxAgentGroupOrder } from '../db/repositories/agents-query-repository.js';
import { createAuditLog } from './audit-log.js';

export interface WorkspaceListQuery {
  userId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CreateWorkspaceData {
  name: string;
  userId: string;
  boardIds?: string[];
  collectionIds?: string[];
  agentGroupIds?: string[];
}

export interface UpdateWorkspaceData {
  name?: string;
  boardIds?: string[];
  collectionIds?: string[];
  agentGroupIds?: string[];
}

type WorkspaceRecord = {
  id: string;
  name: string;
  userId: string;
  boardIds: string[];
  collectionIds: string[];
  agentGroupIds: string[];
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_WORKSPACE_AGENT_GROUP_NAME = 'Agents';

function asWorkspace(rec: Record<string, unknown>): WorkspaceRecord {
  const now = new Date().toISOString();
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    name: typeof rec.name === 'string' ? rec.name : '',
    userId: typeof rec.userId === 'string' ? rec.userId : '',
    boardIds: Array.isArray(rec.boardIds) ? (rec.boardIds as string[]) : [],
    collectionIds: Array.isArray(rec.collectionIds) ? (rec.collectionIds as string[]) : [],
    agentGroupIds: Array.isArray(rec.agentGroupIds) ? (rec.agentGroupIds as string[]) : [],
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : now,
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : now,
  };
}

export async function listWorkspaces(query: WorkspaceListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  if (query.userId) {
    await ensureDefaultWorkspaceForUser(query.userId);
  }

  let all = store.getAll('workspaces') as any[];

  if (query.userId) {
    all = all.filter((w: any) => w.userId === query.userId);
  }

  if (query.search) {
    const term = query.search.toLowerCase();
    all = all.filter((w: any) => w.name?.toLowerCase().includes(term));
  }

  all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = all.length;
  const entries = all.slice(offset, offset + limit).map(asWorkspace);

  return { entries, total };
}

export async function getWorkspaceById(id: string) {
  const workspace = store.getById('workspaces', id);
  return workspace ? asWorkspace(workspace) : null;
}

async function createWorkspaceAgentGroup(
  name = DEFAULT_WORKSPACE_AGENT_GROUP_NAME,
): Promise<string> {
  const maxOrder = await maxAgentGroupOrder();
  const group = store.insert('agentGroups', {
    id: randomUUID(),
    name,
    order: maxOrder + 1,
  }) as Record<string, unknown>;
  return String(group.id);
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function recordBelongsToWorkspaceUser(
  record: Record<string, unknown>,
  userId: string,
  workspaceAgentGroupIds: Set<string>,
): boolean {
  if (!record.createdById || record.createdById === userId) return true;

  const creator = store.getById('users', String(record.createdById));
  if (!creator || creator.type !== 'agent' || typeof creator.agentId !== 'string') return false;

  const agent = store.getById('agents', creator.agentId);
  return typeof agent?.groupId === 'string' && workspaceAgentGroupIds.has(agent.groupId);
}

function listWorkspaceBoardIds(): Set<string> {
  const ids = new Set<string>();
  for (const workspace of store.getAll('workspaces')) {
    if (!Array.isArray(workspace.boardIds)) continue;
    for (const id of workspace.boardIds) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

function listWorkspaceCollectionIds(): Set<string> {
  const ids = new Set<string>();
  for (const workspace of store.getAll('workspaces')) {
    if (!Array.isArray(workspace.collectionIds)) continue;
    for (const id of workspace.collectionIds) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

function listWorkspaceAgentGroupIds(): Set<string> {
  const groupIds = new Set<string>();
  for (const workspace of store.getAll('workspaces')) {
    if (!Array.isArray(workspace.agentGroupIds)) continue;
    for (const groupId of workspace.agentGroupIds) {
      if (typeof groupId === 'string' && groupId) {
        groupIds.add(groupId);
      }
    }
  }
  return groupIds;
}

export async function addWorkspaceContent(
  workspaceId: string,
  content: { boardIds?: string[]; collectionIds?: string[] },
): Promise<WorkspaceRecord | null> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) return null;

  const updated = store.update('workspaces', workspaceId, {
    boardIds: uniqueIds([...workspace.boardIds, ...(content.boardIds ?? [])]),
    collectionIds: uniqueIds([...workspace.collectionIds, ...(content.collectionIds ?? [])]),
    updatedAt: new Date().toISOString(),
  });
  return updated ? asWorkspace(updated) : workspace;
}

function listExistingAgentGroupIds(): Set<string> {
  return new Set(
    store
      .getAll('agentGroups')
      .map((group) => (typeof group.id === 'string' ? group.id : ''))
      .filter(Boolean),
  );
}

function listAgentWorkspaceRepairTargets(): {
  missingGroupAgents: Record<string, unknown>[];
  orphanGroupIds: string[];
} {
  const workspaceGroupIds = listWorkspaceAgentGroupIds();
  const existingGroupIds = listExistingAgentGroupIds();
  const missingGroupAgents: Record<string, unknown>[] = [];
  const orphanGroupIds = new Set<string>();

  for (const agent of store.getAll('agents')) {
    if (!agent.groupId || typeof agent.groupId !== 'string') {
      missingGroupAgents.push(agent);
      continue;
    }
    if (workspaceGroupIds.has(agent.groupId)) continue;
    if (existingGroupIds.has(agent.groupId)) {
      orphanGroupIds.add(agent.groupId);
    } else {
      missingGroupAgents.push(agent);
    }
  }

  return { missingGroupAgents, orphanGroupIds: [...orphanGroupIds] };
}

async function updateWorkspaceAgentGroupIds(
  workspace: WorkspaceRecord,
  agentGroupIds: string[],
): Promise<WorkspaceRecord> {
  const updated = store.update('workspaces', workspace.id, {
    agentGroupIds: uniqueIds(agentGroupIds),
    updatedAt: new Date().toISOString(),
  });
  return updated ? asWorkspace(updated) : workspace;
}

export async function ensureAgentGroupForWorkspace(
  workspaceId: string,
  groupId?: string | null,
): Promise<string> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) throw new Error('Workspace not found');

  if (groupId) {
    if (!workspace.agentGroupIds.includes(groupId)) {
      await updateWorkspaceAgentGroupIds(workspace, [...workspace.agentGroupIds, groupId]);
    }
    return groupId;
  }

  const existingDefaultGroup = store
    .getAll('agentGroups')
    .find(
      (group) =>
        workspace.agentGroupIds.includes(String(group.id)) &&
        String(group.name) === DEFAULT_WORKSPACE_AGENT_GROUP_NAME,
    );
  if (existingDefaultGroup) return String(existingDefaultGroup.id);

  const newGroupId = await createWorkspaceAgentGroup();
  await updateWorkspaceAgentGroupIds(workspace, [...workspace.agentGroupIds, newGroupId]);
  return newGroupId;
}

export async function ensureDefaultWorkspaceForUser(userId: string): Promise<WorkspaceRecord> {
  const existing = (store.getAll('workspaces') as Record<string, unknown>[])
    .filter((workspace) => workspace.userId === userId)
    .sort(
      (a, b) =>
        new Date(String(a.createdAt)).getTime() - new Date(String(b.createdAt)).getTime(),
    )[0];

  if (existing) {
    const workspace = asWorkspace(existing);
    let ensured = workspace;
    if (ensured.agentGroupIds.length === 0) {
      await ensureAgentGroupForWorkspace(workspace.id);
      ensured = (await getWorkspaceById(workspace.id)) ?? workspace;
    }
    await ensureLegacyAgentsAssignedToWorkspace(ensured.id, userId);
    return (await ensureWorkspaceContentAssignedToWorkspace(ensured.id, userId)) ?? ensured;
  }

  const created = await createWorkspace({ name: 'Default Workspace', userId });
  await ensureLegacyAgentsAssignedToWorkspace(created.id, userId);
  return (await ensureWorkspaceContentAssignedToWorkspace(created.id, userId)) ?? created;
}

export async function ensureWorkspaceContentAssignedToWorkspace(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRecord | null> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace || workspace.userId !== userId) return workspace;

  const workspaceBoardIds = listWorkspaceBoardIds();
  const workspaceCollectionIds = listWorkspaceCollectionIds();
  const workspaceAgentGroupIds = new Set(workspace.agentGroupIds);
  const boardIds: string[] = [];
  const collectionIds = new Set<string>();

  for (const board of store.getAll('boards')) {
    if (typeof board.id !== 'string') continue;
    if (workspaceBoardIds.has(board.id)) continue;
    if (!recordBelongsToWorkspaceUser(board, userId, workspaceAgentGroupIds)) continue;
    boardIds.push(board.id);
    if (typeof board.collectionId === 'string') collectionIds.add(board.collectionId);
    if (typeof board.defaultCollectionId === 'string') collectionIds.add(board.defaultCollectionId);
  }

  for (const collection of store.getAll('collections')) {
    if (typeof collection.id !== 'string') continue;
    if (workspaceCollectionIds.has(collection.id)) continue;
    if (
      !recordBelongsToWorkspaceUser(collection, userId, workspaceAgentGroupIds) &&
      !collectionIds.has(collection.id)
    ) {
      continue;
    }
    collectionIds.add(collection.id);
  }

  if (boardIds.length === 0 && collectionIds.size === 0) return workspace;

  return addWorkspaceContent(workspace.id, {
    boardIds,
    collectionIds: [...collectionIds],
  });
}

export async function ensureLegacyAgentsAssignedToWorkspace(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRecord | null> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace || workspace.userId !== userId) return workspace;

  const { missingGroupAgents, orphanGroupIds } = listAgentWorkspaceRepairTargets();
  const groupId = await ensureAgentGroupForWorkspace(workspace.id);

  if (orphanGroupIds.length > 0) {
    await updateWorkspaceAgentGroupIds(workspace, [...workspace.agentGroupIds, ...orphanGroupIds]);
  }

  for (const agent of missingGroupAgents) {
    if (typeof agent.id !== 'string') continue;
    store.update('agents', agent.id, { groupId });
  }

  return getWorkspaceById(workspace.id);
}

export async function createWorkspace(
  data: CreateWorkspaceData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const agentGroupIds =
    data.agentGroupIds && data.agentGroupIds.length > 0
      ? data.agentGroupIds
      : [await createWorkspaceAgentGroup()];
  const workspace = store.insert('workspaces', {
    name: data.name,
    userId: data.userId,
    boardIds: data.boardIds ?? [],
    collectionIds: data.collectionIds ?? [],
    agentGroupIds,
  }) as any;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'workspace',
      entityId: workspace.id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return asWorkspace(workspace);
}

export async function updateWorkspace(
  id: string,
  data: UpdateWorkspaceData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const setData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setData[key] = value;
    }
  }
  setData.updatedAt = new Date().toISOString();

  const updated = store.update('workspaces', id, setData);
  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'workspace',
      entityId: id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return asWorkspace(updated);
}

export async function deleteWorkspace(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const deleted = store.delete('workspaces', id);

  if (deleted && audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'workspace',
      entityId: id,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return deleted ?? null;
}
