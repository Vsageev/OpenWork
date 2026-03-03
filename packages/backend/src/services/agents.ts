import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { createApiKey, deleteApiKey } from './api-keys.js';
import { stopAllAgentCronJobs } from './agent-cron.js';
import type { CronJob } from './agent-cron.js';
import { hashPassword } from './auth.js';

const AGENTS_DIR = path.resolve(env.DATA_DIR, 'agents');

// ---------------------------------------------------------------------------
// Preset definitions (loaded from packages/backend/src/presets/)
// ---------------------------------------------------------------------------

interface PresetTextFileDef {
  type: 'file';
  name: string;
  template: string;
  models?: string[];
}

interface PresetSymlinkFileDef {
  type: 'symlink';
  name: string;
  target: string;
  models?: string[];
}

type PresetFileDef = PresetTextFileDef | PresetSymlinkFileDef;

interface PresetDef {
  id: string;
  name: string;
  description: string;
  files: PresetFileDef[];
}
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.resolve(__dirname, '../presets');

function loadPresets(): Record<string, PresetDef> {
  const presets: Record<string, PresetDef> = {};
  if (!fs.existsSync(PRESETS_DIR)) return presets;

  for (const entry of fs.readdirSync(PRESETS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const presetDir = path.join(PRESETS_DIR, entry.name);
    const manifestPath = path.join(presetDir, 'preset.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const files: PresetFileDef[] = manifest.files.map(
      (f: { type: string; name: string; template?: string; target?: string; models?: string[] }) => {
        if (f.type === 'symlink') {
          return { type: 'symlink', name: f.name, target: f.target!, models: f.models } as PresetSymlinkFileDef;
        }
        const templateContent = fs.readFileSync(path.join(presetDir, f.template!), 'utf-8');
        return { type: 'file', name: f.name, template: templateContent, models: f.models } as PresetTextFileDef;
      },
    );

    presets[manifest.id] = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      files,
    };
  }

  return presets;
}

const AGENT_PRESETS = loadPresets();

// ---------------------------------------------------------------------------
// CLI availability check
// ---------------------------------------------------------------------------

interface CliInfo {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  downloadUrl: string;
}

const CLI_DEFS: { id: string; name: string; command: string; downloadUrl: string }[] = [
  { id: 'claude', name: 'Claude', command: 'claude', downloadUrl: 'https://docs.anthropic.com/en/docs/claude-code' },
  { id: 'codex', name: 'Codex', command: 'codex', downloadUrl: 'https://developers.openai.com/codex/quickstart/' },
  { id: 'qwen', name: 'Qwen', command: 'qwen', downloadUrl: 'https://qwenlm.github.io/qwen-code-docs/' },
];

function isCommandAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function checkCliStatus(): CliInfo[] {
  return CLI_DEFS.map((def) => ({
    ...def,
    installed: isCommandAvailable(def.command),
  }));
}

export function listPresets() {
  return Object.values(AGENT_PRESETS).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));
}

// ---------------------------------------------------------------------------
// Agent group record
// ---------------------------------------------------------------------------

export interface AgentGroupRecord {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

function asAgentGroup(rec: Record<string, unknown>): AgentGroupRecord {
  return {
    ...rec,
    order: typeof rec.order === 'number' ? rec.order : 0,
  } as unknown as AgentGroupRecord;
}

export function listAgentGroups(): AgentGroupRecord[] {
  return store.getAll('agentGroups').map(asAgentGroup).sort((a, b) => a.order - b.order);
}

export function createAgentGroup(name: string): AgentGroupRecord {
  const all = store.getAll('agentGroups');
  const maxOrder = all.reduce((max, r) => Math.max(max, typeof r.order === 'number' ? r.order : 0), -1);
  const record = store.insert('agentGroups', {
    id: randomUUID(),
    name,
    order: maxOrder + 1,
  });
  return asAgentGroup(record);
}

export function updateAgentGroup(
  id: string,
  data: Partial<Pick<AgentGroupRecord, 'name' | 'order'>>,
): AgentGroupRecord | null {
  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.order !== undefined) patch.order = data.order;
  const updated = store.update('agentGroups', id, patch);
  return updated ? asAgentGroup(updated) : null;
}

export function deleteAgentGroup(id: string): boolean {
  const group = store.getById('agentGroups', id);
  if (!group) return false;
  // Unassign agents from this group
  const agents = store.find('agents', (r: Record<string, unknown>) => r.groupId === id);
  for (const agent of agents) {
    store.update('agents', agent.id as string, { groupId: null });
  }
  store.delete('agentGroups', id);
  return true;
}

export function reorderAgentGroups(ids: string[]): AgentGroupRecord[] {
  for (let i = 0; i < ids.length; i++) {
    store.update('agentGroups', ids[i], { order: i });
  }
  return listAgentGroups();
}

// ---------------------------------------------------------------------------
// Agent record interface
// ---------------------------------------------------------------------------

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  model: string;
  modelId: string | null;
  thinkingLevel: 'low' | 'medium' | 'high' | null;
  preset: string;
  status: 'active' | 'inactive' | 'error';
  apiKeyId: string;
  apiKeyName: string;
  apiKeyPrefix: string;
  capabilities: string[];
  skipPermissions: boolean;
  cronJobs: CronJob[];
  groupId: string | null;
  workspaceApiKey: string | null;
  workspaceApiKeyId: string | null;
  serviceUserId: string | null;
  lastActivity: string | null;
  avatarIcon: string;
  avatarBgColor: string;
  avatarLogoColor: string;
  createdAt: string;
  updatedAt: string;
}

export type PublicAgentRecord = Omit<AgentRecord, 'workspaceApiKey' | 'workspaceApiKeyId'>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureAgentsDir() {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

function agentDir(agentId: string): string {
  return path.join(AGENTS_DIR, agentId);
}

function asAgent(rec: Record<string, unknown>): AgentRecord {
  return {
    ...rec,
    modelId: typeof rec.modelId === 'string' ? rec.modelId : null,
    thinkingLevel: ['low', 'medium', 'high'].includes(rec.thinkingLevel as string)
      ? (rec.thinkingLevel as AgentRecord['thinkingLevel'])
      : null,
    skipPermissions: Boolean(rec.skipPermissions),
    cronJobs: Array.isArray(rec.cronJobs) ? rec.cronJobs : [],
    avatarIcon: typeof rec.avatarIcon === 'string' ? rec.avatarIcon : 'spark',
    avatarBgColor:
      typeof rec.avatarBgColor === 'string' ? rec.avatarBgColor : '#1a1a2e',
    avatarLogoColor:
      typeof rec.avatarLogoColor === 'string' ? rec.avatarLogoColor : '#e94560',
  } as unknown as AgentRecord;
}

export function asPublicAgent(agent: AgentRecord): PublicAgentRecord {
  const publicAgent = { ...agent };
  delete (publicAgent as Partial<AgentRecord>).workspaceApiKey;
  delete (publicAgent as Partial<AgentRecord>).workspaceApiKeyId;
  return publicAgent;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateAgentParams {
  name: string;
  description: string;
  model: string;
  modelId?: string | null;
  thinkingLevel?: 'low' | 'medium' | 'high' | null;
  preset: string;
  apiKeyId: string;
  apiKeyName: string;
  apiKeyPrefix: string;
  capabilities: string[];
  skipPermissions?: boolean;
  groupId?: string | null;
  avatarIcon?: string;
  avatarBgColor?: string;
  avatarLogoColor?: string;
}

const WORKSPACE_API_PERMISSIONS = [
  'cards:write',
  'messages:write',
  'storage:write',
  'collections:write',
  'boards:write',
  'tags:write',
  'settings:read',
  'conversations:write',
];

const AGENT_USER_EMAIL_DOMAIN = 'agents.local';

function agentServiceEmail(agentId: string): string {
  return `agent-${agentId}@${AGENT_USER_EMAIL_DOMAIN}`;
}

function findAgentServiceUser(agentId: string): Record<string, unknown> | null {
  const byAgentId = store.findOne(
    'users',
    (r: Record<string, unknown>) => r.type === 'agent' && r.agentId === agentId,
  );
  if (byAgentId) return byAgentId;

  return store.findOne(
    'users',
    (r: Record<string, unknown>) => r.email === agentServiceEmail(agentId),
  );
}

async function createAgentServiceUser(
  agentId: string,
  agentName: string,
): Promise<Record<string, unknown>> {
  return store.insert('users', {
    email: agentServiceEmail(agentId),
    // Agent users never log in interactively; keep a real hash for safety.
    passwordHash: await hashPassword(randomUUID()),
    firstName: agentName,
    lastName: '',
    isActive: true,
    type: 'agent',
    agentId,
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
  });
}

function normalizeAgentServiceUser(
  userId: string,
  agentId: string,
  agentName: string,
): Record<string, unknown> {
  const updated = store.update('users', userId, {
    email: agentServiceEmail(agentId),
    firstName: agentName,
    lastName: '',
    isActive: true,
    type: 'agent',
    agentId,
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
  });

  if (!updated) {
    throw new Error(`Agent service user not found: ${userId}`);
  }

  return updated;
}

export async function createAgent(params: CreateAgentParams): Promise<AgentRecord> {
  const preset = AGENT_PRESETS[params.preset];
  if (!preset) throw new Error(`Unknown preset: ${params.preset}`);

  const agentId = randomUUID();
  let serviceUserId: string | null = null;
  let wsKeyId: string | null = null;

  try {
    // Step 1: Create service user
    const serviceUser = await createAgentServiceUser(agentId, params.name);
    serviceUserId = serviceUser.id as string;

    // Step 2: Create workspace API key
    const wsKey = await createApiKey({
      name: `Agent: ${params.name}`,
      permissions: WORKSPACE_API_PERMISSIONS,
      createdById: serviceUserId,
      description: `Auto-created workspace API key for agent "${params.name}"`,
    });
    wsKeyId = (wsKey as Record<string, unknown>).id as string;

    // Step 3: Insert agent record
    const record = store.insert('agents', {
      id: agentId,
      name: params.name,
      description: params.description,
      model: params.model,
      modelId: params.modelId ?? null,
      thinkingLevel: params.thinkingLevel ?? null,
      preset: params.preset,
      status: 'active',
      apiKeyId: params.apiKeyId,
      apiKeyName: params.apiKeyName,
      apiKeyPrefix: params.apiKeyPrefix,
      capabilities: params.capabilities,
      skipPermissions: params.skipPermissions ?? false,
      groupId: params.groupId ?? null,
      workspaceApiKey: wsKey.rawKey,
      workspaceApiKeyId: wsKeyId,
      serviceUserId,
      lastActivity: null,
      avatarIcon: params.avatarIcon ?? 'spark',
      avatarBgColor: params.avatarBgColor ?? '#1a1a2e',
      avatarLogoColor: params.avatarLogoColor ?? '#e94560',
    });

    // Step 4: Scaffold workspace folder
    ensureAgentsDir();
    const dir = agentDir(record.id as string);
    fs.mkdirSync(dir, { recursive: true });

    const applicableFiles = preset.files.filter(
      (f) => !f.models || f.models.includes(params.model),
    );

    for (const fileDef of applicableFiles) {
      const filePath = path.join(dir, fileDef.name);
      if (fileDef.type === 'file') {
        const content = renderTemplate(fileDef.template, {
          agentName: params.name,
          description: params.description || 'Agent workspace.',
        });
        fs.writeFileSync(filePath, content, 'utf-8');
        continue;
      }

      fs.symlinkSync(fileDef.target, filePath);
    }

    return asAgent(record);
  } catch (error) {
    // Rollback: delete created resources on failure
    if (wsKeyId) {
      await deleteApiKey(wsKeyId).catch(() => {});
    }
    if (serviceUserId) {
      store.delete('users', serviceUserId);
    }
    if (agentId) {
      store.delete('agents', agentId);
    }
    const dir = agentDir(agentId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}

export function listAgents(): AgentRecord[] {
  return store.getAll('agents').map(asAgent);
}

export function getAgent(id: string): AgentRecord | null {
  const rec = store.getById('agents', id);
  return rec ? asAgent(rec) : null;
}

export function updateAgent(
  id: string,
  data: Partial<Pick<AgentRecord, 'name' | 'description' | 'model' | 'modelId' | 'thinkingLevel' | 'status' | 'skipPermissions' | 'cronJobs' | 'groupId' | 'avatarIcon' | 'avatarBgColor' | 'avatarLogoColor'>>,
): AgentRecord | null {
  const current = store.getById('agents', id);
  if (!current) return null;

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.model !== undefined) patch.model = data.model;
  if (data.modelId !== undefined) patch.modelId = data.modelId;
  if (data.thinkingLevel !== undefined) patch.thinkingLevel = data.thinkingLevel;
  if (data.status !== undefined) patch.status = data.status;
  if (data.skipPermissions !== undefined) patch.skipPermissions = data.skipPermissions;
  if (data.cronJobs !== undefined) patch.cronJobs = data.cronJobs;
  if (data.groupId !== undefined) patch.groupId = data.groupId;
  if (data.avatarIcon !== undefined) patch.avatarIcon = data.avatarIcon;
  if (data.avatarBgColor !== undefined) patch.avatarBgColor = data.avatarBgColor;
  if (data.avatarLogoColor !== undefined) patch.avatarLogoColor = data.avatarLogoColor;

  const updated = store.update('agents', id, patch);
  if (!updated) return null;

  if (data.name !== undefined) {
    const serviceUserId = updated.serviceUserId as string | null | undefined;
    if (serviceUserId) {
      normalizeAgentServiceUser(serviceUserId, id, data.name);
    } else {
      const fallbackUser = findAgentServiceUser(id);
      if (fallbackUser) {
        normalizeAgentServiceUser(fallbackUser.id as string, id, data.name);
        store.update('agents', id, { serviceUserId: fallbackUser.id as string });
      }
    }
  }

  return asAgent(updated);
}

export async function deleteAgent(id: string): Promise<boolean> {
  const agent = store.getById('agents', id);
  if (!agent) return false;

  // Stop any running cron tasks for this agent
  stopAllAgentCronJobs(id);

  // Delete the auto-created workspace API key
  if (agent.workspaceApiKeyId) {
    await deleteApiKey(agent.workspaceApiKeyId as string).catch(() => {});
  }

  const serviceUserId =
    (agent.serviceUserId as string | null | undefined) ??
    (findAgentServiceUser(id)?.id as string | undefined);
  if (serviceUserId) {
    store.update('users', serviceUserId, { isActive: false, type: 'agent', agentId: id });
    store.deleteWhere('refreshTokens', (r: Record<string, unknown>) => r.userId === serviceUserId);
  }

  // Close related conversations and preserve agent name in metadata
  const agentConversations = store.find('conversations', (r: Record<string, unknown>) => {
    if (r.channelType !== 'agent' && r.channelType !== 'other') return false;
    try {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
      return meta?.agentId === id;
    } catch {
      return false;
    }
  });

  for (const conv of agentConversations) {
    let meta: Record<string, unknown> = {};
    try {
      meta = typeof conv.metadata === 'string' ? JSON.parse(conv.metadata) : (conv.metadata as Record<string, unknown>) ?? {};
    } catch { /* ignore */ }

    meta.agentDeleted = true;
    meta.agentName = agent.name;

    store.update('conversations', conv.id as string, {
      status: 'closed',
      closedAt: new Date().toISOString(),
      metadata: JSON.stringify(meta),
    });
  }

  store.delete('agents', id);

  // Remove workspace folder
  const dir = agentDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return true;
}

export async function ensureAgentServiceAccounts(): Promise<void> {
  const agents = store.getAll('agents') as Record<string, unknown>[];

  for (const rawAgent of agents) {
    const agentId = rawAgent.id as string;
    const agentName = String(rawAgent.name ?? 'Agent');

    const directServiceUserId = rawAgent.serviceUserId as string | null | undefined;
    const directServiceUser = directServiceUserId
      ? store.getById('users', directServiceUserId)
      : null;

    const existingServiceUser = directServiceUser ?? findAgentServiceUser(agentId);
    const serviceUser = existingServiceUser
      ? normalizeAgentServiceUser(existingServiceUser.id as string, agentId, agentName)
      : await createAgentServiceUser(agentId, agentName);
    const serviceUserId = serviceUser.id as string;

    const currentKeyId = rawAgent.workspaceApiKeyId as string | null | undefined;
    const currentKey = currentKeyId ? store.getById('apiKeys', currentKeyId) : null;
    const keyOwnerMatches = currentKey?.createdById === serviceUserId;
    const currentKeyValue = (rawAgent.workspaceApiKey as string | null | undefined) ?? null;

    let nextKeyId = currentKeyId ?? null;
    let nextKeyValue = currentKeyValue;

    if (!currentKey || !keyOwnerMatches || !currentKeyValue) {
      const wsKey = await createApiKey({
        name: `Agent: ${agentName}`,
        permissions: WORKSPACE_API_PERMISSIONS,
        createdById: serviceUserId,
        description: `Auto-created workspace API key for agent "${agentName}"`,
      });
      nextKeyId = (wsKey as Record<string, unknown>).id as string;
      nextKeyValue = wsKey.rawKey;
      if (currentKeyId) {
        await deleteApiKey(currentKeyId).catch(() => {});
      }
    }

    store.update('agents', agentId, {
      serviceUserId,
      workspaceApiKeyId: nextKeyId,
      workspaceApiKey: nextKeyValue,
    });
  }
}

// ---------------------------------------------------------------------------
// Workspace file operations (scoped to data/agents/{agentId}/)
// ---------------------------------------------------------------------------

export interface AgentFileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  createdAt: string;
  isReference?: boolean;
  target?: string;
}

function normalizePath(p: string): string {
  let normalized = p.trim().replace(/\\/g, '/');
  if (!normalized) normalized = '/';
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  if (normalized !== '/' && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function resolveAgentDiskPath(agentId: string, filePath: string): string {
  const dir = agentDir(agentId);
  return path.resolve(dir, '.' + filePath);
}

function validateAgentPath(agentId: string, p: string): string {
  const normalized = normalizePath(p);
  const resolved = resolveAgentDiskPath(agentId, normalized);
  const root = agentDir(agentId);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootPrefix)) {
    throw new Error('Path traversal detected');
  }
  return normalized;
}

export function listAgentFiles(agentId: string, dirPath: string): AgentFileEntry[] {
  const normalized = validateAgentPath(agentId, dirPath);
  const diskDir = resolveAgentDiskPath(agentId, normalized);

  if (!fs.existsSync(diskDir)) return [];
  const stats = fs.statSync(diskDir);
  if (!stats.isDirectory()) throw new Error('Path is not a directory');

  return fs
    .readdirSync(diskDir, { withFileTypes: true })
    .map((entry) => {
      const fullPath = path.join(diskDir, entry.name);
      if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) return null;

      // Resolve symlinks to expose their target kind in the file explorer.
      let st: fs.Stats;
      try {
        st = fs.statSync(fullPath);
      } catch {
        return null;
      }

      const resolvedType = st.isFile() ? 'file' : st.isDirectory() ? 'folder' : null;
      if (!resolvedType) return null;

      const isSymlink = entry.isSymbolicLink();
      const relative = path.relative(agentDir(agentId), fullPath).split(path.sep).join('/');
      const createdAtSource =
        Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtime : st.mtime;
      const fileEntry: AgentFileEntry = {
        name: entry.name,
        path: normalizePath('/' + relative),
        type: resolvedType,
        size: resolvedType === 'file' ? st.size : 0,
        createdAt: createdAtSource.toISOString(),
      };

      if (isSymlink) {
        fileEntry.isReference = true;
        fileEntry.target = fs.readlinkSync(fullPath);
      }

      return fileEntry;
    })
    .filter((e): e is AgentFileEntry => e !== null);
}

export function getAgentFilePath(agentId: string, filePath: string): string | null {
  const normalized = validateAgentPath(agentId, filePath);
  const diskPath = resolveAgentDiskPath(agentId, normalized);
  if (!fs.existsSync(diskPath)) return null;
  const stats = fs.statSync(diskPath);
  if (!stats.isFile()) return null;
  return diskPath;
}

export function getAgentEntryPath(agentId: string, entryPath: string): string | null {
  const normalized = validateAgentPath(agentId, entryPath);
  const diskPath = resolveAgentDiskPath(agentId, normalized);
  if (!fs.existsSync(diskPath)) return null;
  return diskPath;
}

export function readAgentFileContent(agentId: string, filePath: string): string | null {
  const diskPath = getAgentFilePath(agentId, filePath);
  if (!diskPath) return null;
  return fs.readFileSync(diskPath, 'utf-8');
}

export async function uploadAgentFile(
  agentId: string,
  dirPath: string,
  fileName: string,
  _mimeType: string,
  buffer: Buffer,
): Promise<AgentFileEntry> {
  const parentPath = validateAgentPath(agentId, dirPath);
  const safeName = fileName.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!safeName) throw new Error('Invalid file name');

  const fullPath = parentPath === '/' ? '/' + safeName : parentPath + '/' + safeName;
  validateAgentPath(agentId, fullPath);

  const diskPath = resolveAgentDiskPath(agentId, fullPath);
  const diskDir = path.dirname(diskPath);
  if (!fs.existsSync(diskDir)) {
    fs.mkdirSync(diskDir, { recursive: true });
  }

  fs.writeFileSync(diskPath, buffer);

  const st = fs.statSync(diskPath);
  const createdAtSource =
    Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtime : st.mtime;

  return {
    name: safeName,
    path: fullPath,
    type: 'file',
    size: buffer.length,
    createdAt: createdAtSource.toISOString(),
  };
}

export function createAgentFolder(agentId: string, dirPath: string, name: string): AgentFileEntry {
  const parentPath = validateAgentPath(agentId, dirPath);
  const safeName = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!safeName) throw new Error('Invalid folder name');

  const fullPath = parentPath === '/' ? '/' + safeName : parentPath + '/' + safeName;
  validateAgentPath(agentId, fullPath);

  const diskPath = resolveAgentDiskPath(agentId, fullPath);
  if (fs.existsSync(diskPath)) {
    throw new Error('A file or folder with this name already exists');
  }
  fs.mkdirSync(diskPath, { recursive: true });

  const st = fs.statSync(diskPath);
  const createdAtSource =
    Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtime : st.mtime;

  return {
    name: safeName,
    path: fullPath,
    type: 'folder',
    size: 0,
    createdAt: createdAtSource.toISOString(),
  };
}

export function createAgentReference(agentId: string, dirPath: string, name: string, target: string): AgentFileEntry {
  const parentPath = validateAgentPath(agentId, dirPath);
  const safeName = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!safeName) throw new Error('Invalid reference name');

  const fullPath = parentPath === '/' ? '/' + safeName : parentPath + '/' + safeName;
  validateAgentPath(agentId, fullPath);

  const diskPath = resolveAgentDiskPath(agentId, fullPath);
  if (fs.existsSync(diskPath)) {
    throw new Error('A file or folder with this name already exists');
  }

  fs.symlinkSync(target, diskPath);

  let st: fs.Stats;
  try {
    st = fs.statSync(diskPath);
  } catch {
    throw new Error('Failed to create reference — target may be invalid');
  }

  const resolvedType = st.isFile() ? 'file' : st.isDirectory() ? 'folder' : null;
  if (!resolvedType) throw new Error('Failed to create reference — target is not a file or folder');

  const createdAtSource =
    Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtime : st.mtime;

  return {
    name: safeName,
    path: fullPath,
    type: resolvedType,
    size: resolvedType === 'file' ? st.size : 0,
    createdAt: createdAtSource.toISOString(),
    isReference: true,
    target,
  };
}

export function deleteAgentFile(agentId: string, filePath: string): boolean {
  const normalized = validateAgentPath(agentId, filePath);
  if (normalized === '/') return false;

  const diskPath = resolveAgentDiskPath(agentId, normalized);
  if (!fs.existsSync(diskPath)) return false;
  fs.rmSync(diskPath, { recursive: true, force: true });
  return true;
}
