import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { createApiKey, deleteApiKey, validateApiKey } from './api-keys.js';
import { stopAllAgentCronJobs } from './agent-cron.js';
import type { CronJob } from './agent-cron.js';
import { hashPassword } from './auth.js';
import { attachSkillToAgent } from './skills.js';

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

interface PresetParameterDef {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  type: 'text' | 'directory';
  contentTemplate?: string;
  emptyContentTemplate?: string;
}

interface PresetDef {
  id: string;
  name: string;
  description: string;
  files: PresetFileDef[];
  parameters: PresetParameterDef[];
  defaultSkills: string[];
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
    const parameters: PresetParameterDef[] = Array.isArray(manifest.parameters)
      ? manifest.parameters.map(
          (parameter: {
            key: string;
            label: string;
            description?: string;
            placeholder?: string;
            required?: boolean;
            type?: string;
            contentTemplate?: string;
            emptyContentTemplate?: string;
          }) => {
            if (!/^\w+$/.test(parameter.key)) {
              throw new Error(
                `Invalid preset parameter key "${parameter.key}" in preset "${manifest.id}"`,
              );
            }
            return {
              key: parameter.key,
              label: parameter.label,
              description: parameter.description,
              placeholder: parameter.placeholder,
              required: Boolean(parameter.required),
              type: parameter.type === 'directory' ? 'directory' : 'text',
              contentTemplate:
                typeof parameter.contentTemplate === 'string'
                  ? parameter.contentTemplate
                  : undefined,
              emptyContentTemplate:
                typeof parameter.emptyContentTemplate === 'string'
                  ? parameter.emptyContentTemplate
                  : undefined,
            };
          },
        )
      : [];
    const files: PresetFileDef[] = manifest.files.map(
      (f: {
        type: string;
        name: string;
        template?: string;
        target?: string;
        models?: string[];
      }) => {
        if (f.type === 'symlink') {
          return {
            type: 'symlink',
            name: f.name,
            target: f.target!,
            models: f.models,
          } as PresetSymlinkFileDef;
        }
        const templateContent = fs.readFileSync(path.join(presetDir, f.template!), 'utf-8');
        return {
          type: 'file',
          name: f.name,
          template: templateContent,
          models: f.models,
        } as PresetTextFileDef;
      },
    );

    presets[manifest.id] = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      files,
      parameters,
      defaultSkills: Array.isArray(manifest.defaultSkills) ? manifest.defaultSkills : [],
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
  {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    downloadUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    downloadUrl: 'https://developers.openai.com/codex/quickstart/',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    command: 'qwen',
    downloadUrl: 'https://qwenlm.github.io/qwen-code-docs/',
  },
];

const MODEL_ID_BY_ALIAS = new Map<string, string>(
  CLI_DEFS.flatMap((def) => [
    [def.id, def.id],
    [def.name.toLowerCase(), def.id],
  ]),
);

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
    parameters: p.parameters.map(({ contentTemplate, emptyContentTemplate, ...parameter }) => ({
      ...parameter,
    })),
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

export interface AgentAvatarPresetRecord {
  id: string;
  name: string;
  avatarIcon: string;
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
  return store
    .getAll('agentGroups')
    .map(asAgentGroup)
    .sort((a, b) => a.order - b.order);
}

export function createAgentGroup(name: string): AgentGroupRecord {
  const all = store.getAll('agentGroups');
  const maxOrder = all.reduce(
    (max, r) => Math.max(max, typeof r.order === 'number' ? r.order : 0),
    -1,
  );
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

function asAgentAvatarPreset(rec: Record<string, unknown>): AgentAvatarPresetRecord {
  return {
    ...rec,
    name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled preset',
    avatarIcon: typeof rec.avatarIcon === 'string' ? rec.avatarIcon : 'spark',
  } as AgentAvatarPresetRecord;
}

export function listAgentAvatarPresets(): AgentAvatarPresetRecord[] {
  return store
    .getAll('agentAvatarPresets')
    .map(asAgentAvatarPreset)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createAgentAvatarPreset(params: {
  name: string;
  avatarIcon: string;
}): AgentAvatarPresetRecord {
  const record = store.insert('agentAvatarPresets', {
    name: params.name.trim(),
    avatarIcon: params.avatarIcon,
  });
  return asAgentAvatarPreset(record);
}

export function updateAgentAvatarPreset(
  id: string,
  data: Partial<Pick<AgentAvatarPresetRecord, 'name' | 'avatarIcon'>>,
): AgentAvatarPresetRecord | null {
  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name.trim();
  if (data.avatarIcon !== undefined) patch.avatarIcon = data.avatarIcon;
  const updated = store.update('agentAvatarPresets', id, patch);
  return updated ? asAgentAvatarPreset(updated) : null;
}

export function deleteAgentAvatarPreset(id: string): boolean {
  return Boolean(store.delete('agentAvatarPresets', id));
}

// ---------------------------------------------------------------------------
// Agent color presets (saved bg+logo color combos)
// ---------------------------------------------------------------------------

export interface AgentColorPresetRecord {
  id: string;
  name: string;
  bgColor: string;
  logoColor: string;
  createdAt: string;
  updatedAt: string;
}

function asAgentColorPreset(rec: Record<string, unknown>): AgentColorPresetRecord {
  return {
    ...rec,
    name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled',
    bgColor: typeof rec.bgColor === 'string' ? rec.bgColor : '#1a1a2e',
    logoColor: typeof rec.logoColor === 'string' ? rec.logoColor : '#e94560',
  } as AgentColorPresetRecord;
}

export function listAgentColorPresets(): AgentColorPresetRecord[] {
  return store
    .getAll('agentColorPresets')
    .map(asAgentColorPreset)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createAgentColorPreset(params: {
  name: string;
  bgColor: string;
  logoColor: string;
}): AgentColorPresetRecord {
  const record = store.insert('agentColorPresets', {
    name: params.name.trim(),
    bgColor: params.bgColor,
    logoColor: params.logoColor,
  });
  return asAgentColorPreset(record);
}

export function updateAgentColorPreset(
  id: string,
  data: Partial<Pick<AgentColorPresetRecord, 'name' | 'bgColor' | 'logoColor'>>,
): AgentColorPresetRecord | null {
  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name.trim();
  if (data.bgColor !== undefined) patch.bgColor = data.bgColor;
  if (data.logoColor !== undefined) patch.logoColor = data.logoColor;
  const updated = store.update('agentColorPresets', id, patch);
  return updated ? asAgentColorPreset(updated) : null;
}

export function deleteAgentColorPreset(id: string): boolean {
  return Boolean(store.delete('agentColorPresets', id));
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
  skillIds: string[];
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

function normalizePresetModelKey(model: string): string {
  return model.trim().toLowerCase();
}

function normalizeModelValue(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return '';
  return MODEL_ID_BY_ALIAS.get(normalized) ?? normalized;
}

function getPresetApplicableFiles(preset: PresetDef, model: string): PresetFileDef[] {
  const normalizedModel = normalizePresetModelKey(model);
  return preset.files.filter(
    (file) =>
      !file.models ||
      file.models.some((candidate) => normalizePresetModelKey(candidate) === normalizedModel),
  );
}

function getPresetModelScopedFiles(preset: PresetDef, model: string): PresetFileDef[] {
  const normalizedModel = normalizePresetModelKey(model);
  return preset.files.filter((file) =>
    file.models?.some((candidate) => normalizePresetModelKey(candidate) === normalizedModel),
  );
}

function areEquivalentPresetFiles(left: PresetFileDef, right: PresetFileDef): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'file' && right.type === 'file') {
    return left.template === right.template;
  }
  if (left.type === 'symlink' && right.type === 'symlink') {
    return left.target === right.target;
  }
  return false;
}

function syncPresetModelScopedFiles(
  agentId: string,
  presetId: string,
  previousModel: string,
  nextModel: string,
): void {
  if (previousModel === nextModel) return;

  const preset = AGENT_PRESETS[presetId];
  if (!preset) return;

  const previousFiles = getPresetModelScopedFiles(preset, previousModel);
  const nextFiles = getPresetModelScopedFiles(preset, nextModel);
  if (previousFiles.length === 0 || nextFiles.length === 0) return;

  const dir = agentDir(agentId);

  for (const nextFile of nextFiles) {
    const nextPath = path.join(dir, nextFile.name);
    if (fs.existsSync(nextPath)) continue;

    const previousFile = previousFiles.find(
      (candidate) =>
        candidate.name !== nextFile.name && areEquivalentPresetFiles(candidate, nextFile),
    );
    if (!previousFile) continue;

    const previousPath = path.join(dir, previousFile.name);
    if (!fs.existsSync(previousPath)) continue;

    fs.renameSync(previousPath, nextPath);
  }
}

function asAgent(rec: Record<string, unknown>): AgentRecord {
  return {
    ...rec,
    model: typeof rec.model === 'string' ? normalizeModelValue(rec.model) : '',
    modelId: typeof rec.modelId === 'string' ? rec.modelId : null,
    thinkingLevel: ['low', 'medium', 'high'].includes(rec.thinkingLevel as string)
      ? (rec.thinkingLevel as AgentRecord['thinkingLevel'])
      : null,
    skipPermissions: Boolean(rec.skipPermissions),
    cronJobs: Array.isArray(rec.cronJobs) ? rec.cronJobs : [],
    skillIds: Array.isArray(rec.skillIds) ? rec.skillIds : [],
    avatarIcon: typeof rec.avatarIcon === 'string' ? rec.avatarIcon : 'spark',
    avatarBgColor: typeof rec.avatarBgColor === 'string' ? rec.avatarBgColor : '#1a1a2e',
    avatarLogoColor: typeof rec.avatarLogoColor === 'string' ? rec.avatarLogoColor : '#e94560',
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
  presetParameters?: Record<string, string>;
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
  'settings:write',
  'conversations:write',
];

const WORKSPACE_API_PERMISSION_SET = new Set(WORKSPACE_API_PERMISSIONS);

function normalizePermissionList(permissions: unknown): string[] {
  if (!Array.isArray(permissions)) return [];

  return [
    ...new Set(
      permissions.filter((permission): permission is string => typeof permission === 'string'),
    ),
  ];
}

function arraysEqualAsSets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((permission) => rightSet.has(permission));
}

function resolvePresetParameters(
  preset: PresetDef,
  input: Record<string, string> | undefined,
): Record<string, string> {
  const parameterDefs = new Map(preset.parameters.map((parameter) => [parameter.key, parameter]));
  const provided = input ?? {};

  for (const key of Object.keys(provided)) {
    if (!parameterDefs.has(key)) {
      throw new Error(`Unknown preset parameter "${key}" for preset "${preset.name}"`);
    }
  }

  const resolved: Record<string, string> = {};
  for (const parameter of preset.parameters) {
    const value = provided[parameter.key]?.trim() ?? '';
    if (value) {
      resolved[parameter.key] = value;
      continue;
    }
    if (parameter.required) {
      throw new Error(`Preset parameter "${parameter.label}" is required`);
    }
  }

  return resolved;
}

function buildPresetTemplateVars(
  preset: PresetDef,
  input: {
    agentName: string;
    description: string;
    presetParameters: Record<string, string>;
  },
): Record<string, string> {
  const vars: Record<string, string> = {
    agentName: input.agentName,
    description: input.description || 'Agent workspace.',
  };

  for (const parameter of preset.parameters) {
    const value = input.presetParameters[parameter.key] ?? '';
    vars[parameter.key] = value;
    const parameterTemplate = value
      ? parameter.contentTemplate
      : parameter.emptyContentTemplate;
    vars[`${parameter.key}Instructions`] = parameterTemplate
      ? renderTemplate(parameterTemplate, { ...vars, value })
      : '';
  }

  return vars;
}

function scopeWorkspaceApiPermissions(requestedPermissions: unknown): string[] {
  const normalized = normalizePermissionList(requestedPermissions);
  return normalized.filter((permission) => WORKSPACE_API_PERMISSION_SET.has(permission));
}

function deriveWorkspaceApiPermissions(requestedPermissions: unknown, context: string): string[] {
  const scoped = scopeWorkspaceApiPermissions(requestedPermissions);

  if (scoped.length === 0) {
    throw new Error(`${context} does not grant any agent-usable workspace permissions`);
  }

  return scoped;
}

interface SyncAgentWorkspaceAccessOptions {
  strictSourceKey?: boolean;
}

const AGENT_USER_EMAIL_DOMAIN = 'agents.local';

function agentServiceEmail(agentId: string): string {
  return `agent-${agentId}@${AGENT_USER_EMAIL_DOMAIN}`;
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
  const presetParameters = resolvePresetParameters(preset, params.presetParameters);
  const workspaceApiPermissions = deriveWorkspaceApiPermissions(
    params.capabilities,
    `API key "${params.apiKeyName}"`,
  );

  const agentId = randomUUID();
  let serviceUserId: string | null = null;
  let wsKeyId: string | null = null;
  const normalizedModel = normalizeModelValue(params.model);

  try {
    // Step 1: Create service user
    const serviceUser = await createAgentServiceUser(agentId, params.name);
    serviceUserId = serviceUser.id as string;

    // Step 2: Create workspace API key
    const wsKey = await createApiKey({
      name: `Agent: ${params.name}`,
      permissions: workspaceApiPermissions,
      createdById: serviceUserId,
      description: `Auto-created workspace API key for agent "${params.name}"`,
    });
    wsKeyId = (wsKey as Record<string, unknown>).id as string;

    // Step 3: Insert agent record
    const record = store.insert('agents', {
      id: agentId,
      name: params.name,
      description: params.description,
      model: normalizedModel,
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

    const applicableFiles = getPresetApplicableFiles(preset, normalizedModel);
    const templateVars = buildPresetTemplateVars(preset, {
      agentName: params.name,
      description: params.description,
      presetParameters,
    });

    for (const fileDef of applicableFiles) {
      const filePath = path.join(dir, fileDef.name);
      if (fileDef.type === 'file') {
        const content = renderTemplate(fileDef.template, templateVars);
        fs.writeFileSync(filePath, content, 'utf-8');
        continue;
      }

      fs.symlinkSync(fileDef.target, filePath);
    }

    // Step 5: Auto-attach default skills from preset
    if (preset.defaultSkills.length > 0) {
      const allSkills = store.getAll('skills');
      for (const skillName of preset.defaultSkills) {
        const skill = allSkills.find(
          (s) => (s.name as string).toLowerCase() === skillName.toLowerCase(),
        );
        if (skill) {
          try {
            attachSkillToAgent(agentId, skill.id as string);
          } catch {
            // Non-fatal: skill attachment failure shouldn't block agent creation
          }
        }
      }
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

export async function updateAgent(
  id: string,
  data: Partial<
    Pick<
      AgentRecord,
      | 'name'
      | 'description'
      | 'model'
      | 'modelId'
      | 'thinkingLevel'
      | 'status'
      | 'skipPermissions'
      | 'cronJobs'
      | 'groupId'
      | 'avatarIcon'
      | 'avatarBgColor'
      | 'avatarLogoColor'
      | 'apiKeyId'
    >
  >,
): Promise<AgentRecord | null> {
  const current = store.getById('agents', id);
  if (!current) return null;
  const currentAgent = asAgent(current);

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.model !== undefined) patch.model = normalizeModelValue(data.model);
  if (data.modelId !== undefined) patch.modelId = data.modelId;
  if (data.thinkingLevel !== undefined) patch.thinkingLevel = data.thinkingLevel;
  if (data.status !== undefined) patch.status = data.status;
  if (data.skipPermissions !== undefined) patch.skipPermissions = data.skipPermissions;
  if (data.cronJobs !== undefined) patch.cronJobs = data.cronJobs;
  if (data.groupId !== undefined) patch.groupId = data.groupId;
  if (data.avatarIcon !== undefined) patch.avatarIcon = data.avatarIcon;
  if (data.avatarBgColor !== undefined) patch.avatarBgColor = data.avatarBgColor;
  if (data.avatarLogoColor !== undefined) patch.avatarLogoColor = data.avatarLogoColor;
  if (data.apiKeyId !== undefined) {
    const apiKey = store.getById('apiKeys', data.apiKeyId);
    if (!apiKey || apiKey.isActive === false) {
      throw new Error('API key not found');
    }

    patch.apiKeyId = data.apiKeyId;
    patch.apiKeyName = apiKey.name as string;
    patch.apiKeyPrefix = apiKey.keyPrefix as string;
    patch.capabilities = normalizePermissionList(apiKey.permissions);
  }

  const updated = store.update('agents', id, patch);
  if (!updated) return null;

  if (data.model !== undefined) {
    syncPresetModelScopedFiles(
      id,
      currentAgent.preset,
      currentAgent.model,
      patch.model as string,
    );
  }

  if (data.name !== undefined) {
    const serviceUserId = updated.serviceUserId as string | null | undefined;
    if (serviceUserId) {
      normalizeAgentServiceUser(serviceUserId, id, data.name);
    }
  }

  if (data.apiKeyId !== undefined) {
    return syncAgentWorkspaceAccess(id, { strictSourceKey: true });
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

  const serviceUserId = agent.serviceUserId as string | null | undefined;
  if (serviceUserId) {
    store.update('users', serviceUserId, { isActive: false, type: 'agent', agentId: id });
    store.deleteWhere('refreshTokens', (r: Record<string, unknown>) => r.userId === serviceUserId);
  }

  // Close related conversations and preserve agent name in metadata
  const agentConversations = store.find('conversations', (r: Record<string, unknown>) => {
    if (r.channelType !== 'agent') return false;
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
      meta =
        typeof conv.metadata === 'string'
          ? JSON.parse(conv.metadata)
          : ((conv.metadata as Record<string, unknown>) ?? {});
    } catch {
      /* ignore */
    }

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

async function syncAgentWorkspaceAccess(
  agentId: string,
  options: SyncAgentWorkspaceAccessOptions = {},
): Promise<AgentRecord | null> {
  const rawAgent = store.getById('agents', agentId);
  if (!rawAgent) return null;

  const agentName = String(rawAgent.name ?? 'Agent');
  const directServiceUserId = rawAgent.serviceUserId as string | null | undefined;
  const directServiceUser = directServiceUserId
    ? store.getById('users', directServiceUserId)
    : null;

  const serviceUser = directServiceUser
    ? normalizeAgentServiceUser(directServiceUser.id as string, agentId, agentName)
    : await createAgentServiceUser(agentId, agentName);
  const serviceUserId = serviceUser.id as string;

  const sourceKeyId = rawAgent.apiKeyId as string;
  const sourceKey = sourceKeyId ? store.getById('apiKeys', sourceKeyId) : null;
  const sourceKeyIsActive = Boolean(sourceKey && sourceKey.isActive !== false);
  const sourcePermissions = sourceKeyIsActive
    ? normalizePermissionList(sourceKey?.permissions)
    : [];
  const desiredWorkspacePermissions = scopeWorkspaceApiPermissions(sourcePermissions);

  if (options.strictSourceKey) {
    if (!sourceKeyIsActive) {
      throw new Error('API key not found');
    }

    if (desiredWorkspacePermissions.length === 0) {
      throw new Error(
        `API key "${String(sourceKey?.name ?? 'Unknown')}" does not grant any agent-usable workspace permissions`,
      );
    }
  }

  const currentKeyId = rawAgent.workspaceApiKeyId as string | null | undefined;
  const currentKey = currentKeyId ? store.getById('apiKeys', currentKeyId) : null;
  const keyOwnerMatches = currentKey?.createdById === serviceUserId;
  const keyPermissionsMatch = currentKey
    ? arraysEqualAsSets(
        normalizePermissionList(currentKey.permissions),
        desiredWorkspacePermissions,
      )
    : false;
  const currentKeyValue = (rawAgent.workspaceApiKey as string | null | undefined) ?? null;
  const currentKeyValueRecord = currentKeyValue ? await validateApiKey(currentKeyValue) : null;
  const keyValueMatchesRecord = currentKeyValue
    ? currentKeyValueRecord?.id === currentKeyId
    : false;

  let nextKeyId: string | null = null;
  let nextKeyValue: string | null = null;

  if (desiredWorkspacePermissions.length > 0) {
    nextKeyId = currentKeyId ?? null;
    nextKeyValue = currentKeyValue;

    if (
      !currentKey ||
      !keyOwnerMatches ||
      !currentKeyValue ||
      !keyPermissionsMatch ||
      !keyValueMatchesRecord
    ) {
      const wsKey = await createApiKey({
        name: `Agent: ${agentName}`,
        permissions: desiredWorkspacePermissions,
        createdById: serviceUserId,
        description: `Auto-created workspace API key for agent "${agentName}"`,
      });
      nextKeyId = (wsKey as Record<string, unknown>).id as string;
      nextKeyValue = wsKey.rawKey;
      if (currentKeyId) {
        await deleteApiKey(currentKeyId).catch(() => {});
      }
    }
  } else if (currentKeyId) {
    await deleteApiKey(currentKeyId).catch(() => {});
  }

  const updated = store.update('agents', agentId, {
    serviceUserId,
    apiKeyName: sourceKeyIsActive ? (sourceKey?.name as string) : '',
    apiKeyPrefix: sourceKeyIsActive ? (sourceKey?.keyPrefix as string) : '',
    capabilities: sourcePermissions,
    workspaceApiKeyId: nextKeyId,
    workspaceApiKey: nextKeyValue,
  });

  return updated ? asAgent(updated) : null;
}

export async function syncAgentsForApiKey(apiKeyId: string): Promise<void> {
  const agents = store.find(
    'agents',
    (record: Record<string, unknown>) => record.apiKeyId === apiKeyId,
  );
  for (const agent of agents) {
    await syncAgentWorkspaceAccess(agent.id as string);
  }
}

export async function prepareAgentWorkspaceAccess(agentId: string): Promise<AgentRecord | null> {
  return syncAgentWorkspaceAccess(agentId);
}

export async function ensureAgentServiceAccounts(): Promise<void> {
  const agents = store.getAll('agents') as Record<string, unknown>[];

  for (const rawAgent of agents) {
    await syncAgentWorkspaceAccess(rawAgent.id as string);
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

export function writeAgentFileContent(agentId: string, filePath: string, content: string): void {
  const normalized = validateAgentPath(agentId, filePath);
  const diskPath = resolveAgentDiskPath(agentId, normalized);
  const diskDir = path.dirname(diskPath);

  if (!fs.existsSync(diskDir)) {
    fs.mkdirSync(diskDir, { recursive: true });
  }

  if (fs.existsSync(diskPath) && fs.statSync(diskPath).isDirectory()) {
    throw new Error('Path is a directory');
  }

  fs.writeFileSync(diskPath, content, 'utf-8');
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

export function createAgentReference(
  agentId: string,
  dirPath: string,
  name: string,
  target: string,
): AgentFileEntry {
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
