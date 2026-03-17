import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from '../db/index.js';
import { env } from '../config/env.js';

const SKILLS_DIR = path.resolve(env.DATA_DIR, 'skills');
const AGENTS_DIR = path.resolve(env.DATA_DIR, 'agents');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, '../presets/skills');

// ---------------------------------------------------------------------------
// Skill record
// ---------------------------------------------------------------------------

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  missing: boolean;
}

function asSkill(rec: Record<string, unknown>): SkillRecord {
  return rec as unknown as SkillRecord;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

function skillDir(skillId: string): string {
  return path.join(SKILLS_DIR, skillId);
}

function agentDir(agentId: string): string {
  return path.join(AGENTS_DIR, agentId);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill';
}

/** Recursively copy a directory tree. */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Get the destination path where a skill is copied inside an agent workspace. */
function agentSkillDestPath(agentId: string, skillName: string): string {
  return path.join(agentDir(agentId), 'skills', slugify(skillName));
}

function humanizeSlug(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listSkills(): SkillRecord[] {
  return store
    .getAll('skills')
    .map(asSkill)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(id: string): SkillRecord | null {
  const rec = store.getById('skills', id);
  return rec ? asSkill(rec) : null;
}

export function createSkill(params: { name: string; description: string }): SkillRecord {
  ensureSkillsDir();

  const record = store.insert('skills', {
    id: randomUUID(),
    name: params.name.trim(),
    description: params.description.trim(),
  });

  const dir = skillDir(record.id as string);
  fs.mkdirSync(dir, { recursive: true });

  // Create default index.md entry point
  fs.writeFileSync(
    path.join(dir, 'index.md'),
    `# ${params.name.trim()}\n\n${params.description.trim()}\n`,
    'utf-8',
  );

  return asSkill(record);
}

export function updateSkill(
  id: string,
  data: Partial<Pick<SkillRecord, 'name' | 'description'>>,
): SkillRecord | null {
  const existing = store.getById('skills', id);
  if (!existing) return null;

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name.trim();
  if (data.description !== undefined) patch.description = data.description.trim();

  const updated = store.update('skills', id, patch);
  return updated ? asSkill(updated) : null;
}

export function deleteSkill(id: string): boolean {
  const existing = store.getById('skills', id);
  if (!existing) return false;

  store.delete('skills', id);

  // Remove skill source folder
  const dir = skillDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Attach / detach skills to agents
// ---------------------------------------------------------------------------

interface AgentSkillReference {
  id: string;
  path: string;
  description: string;
}

function buildSkillsSection(skills: AgentSkillReference[]): string {
  if (skills.length === 0) return '';

  const lines = skills.map((skill) =>
    skill.description
      ? `- \`${skill.path}\` — ${skill.description}`
      : `- \`${skill.path}\``,
  );

  return [SKILLS_START, '## Skills', ...lines, SKILLS_END].join('\n');
}

function findInstructionFile(agentId: string): string | null {
  const dir = agentDir(agentId);
  for (const name of ['CLAUDE.MD', 'CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function normalizeAgentRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function encodeAgentSkillId(relativePath: string): string {
  return Buffer.from(relativePath, 'utf-8').toString('base64url');
}

function decodeAgentSkillId(encodedId: string): string | null {
  try {
    return normalizeAgentRelativePath(Buffer.from(encodedId, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function resolveAgentRelativePath(agentId: string, relativePath: string): string {
  const normalized = normalizeAgentRelativePath(relativePath);
  const root = agentDir(agentId);
  const resolved = path.resolve(root, normalized);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;

  if (resolved !== root && !resolved.startsWith(rootPrefix)) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

function parseAgentSkillReferences(content: string): AgentSkillReference[] | null {
  const startIdx = content.indexOf(SKILLS_START);
  const endIdx = content.indexOf(SKILLS_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }

  const section = content.slice(startIdx + SKILLS_START.length, endIdx);
  const seen = new Set<string>();
  const refs: AgentSkillReference[] = [];

  for (const rawLine of section.split('\n')) {
    const pathMatch = rawLine.match(/`([^`]+)`/);
    if (!pathMatch) continue;

    const skillPath = path.posix.normalize(normalizeAgentRelativePath(pathMatch[1]));
    if (!skillPath.startsWith('skills/') || !skillPath.endsWith('/index.md')) continue;

    const id = normalizeAgentRelativePath(path.posix.dirname(skillPath));
    if (seen.has(id)) continue;
    seen.add(id);

    const trailing = rawLine.slice(pathMatch.index! + pathMatch[0].length).trim();
    const description = trailing.replace(/^[-–—:]+\s*/, '').trim();

    refs.push({ id, path: skillPath, description });
  }

  return refs;
}

function readAgentSkillDisplay(filePath: string): { name: string; description: string } {
  const fallbackName = humanizeSlug(path.basename(path.dirname(filePath)));
  if (!fs.existsSync(filePath)) {
    return { name: fallbackName, description: '' };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  let name = fallbackName;
  let description = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('# ')) {
      name = trimmed.slice(2).trim() || fallbackName;
      continue;
    }
    if (!trimmed.startsWith('#')) {
      description = trimmed;
      break;
    }
  }

  return { name, description };
}

function readAgentSkillReferences(agentId: string): AgentSkillReference[] {
  const filePath = findInstructionFile(agentId);
  if (!filePath) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  return parseAgentSkillReferences(content) ?? [];
}

function writeAgentSkillsSection(agentId: string, skills: AgentSkillReference[]): void {
  const filePath = findInstructionFile(agentId);
  if (!filePath) {
    throw new Error('Agent instruction file not found');
  }

  const newSection = buildSkillsSection(skills);
  let content = fs.readFileSync(filePath, 'utf-8');

  const startIdx = content.indexOf(SKILLS_START);
  const endIdx = content.indexOf(SKILLS_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = content.slice(0, startIdx).replace(/\n+$/, '');
    const after = content.slice(endIdx + SKILLS_END.length).replace(/^\n+/, '');

    if (newSection) {
      content = before + '\n\n' + newSection + (after ? '\n\n' + after : '\n');
    } else {
      content = before + (after ? '\n\n' + after : '\n');
    }
  } else if (newSection) {
    content = content.replace(/\n*$/, '') + '\n\n' + newSection + '\n';
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

function removeEmptyAgentSkillsFolder(agentId: string): void {
  const skillsFolder = path.join(agentDir(agentId), 'skills');
  if (!fs.existsSync(skillsFolder)) return;

  const remaining = fs.readdirSync(skillsFolder);
  if (remaining.length === 0) {
    fs.rmdirSync(skillsFolder);
  }
}

export function getAgentSkills(agentId: string): AgentSkillRecord[] {
  const agent = store.getById('agents', agentId);
  if (!agent) return [];

  return readAgentSkillReferences(agentId).map((ref) => {
    const diskPath = resolveAgentRelativePath(agentId, ref.path);
    const missing = !fs.existsSync(diskPath);
    const display = readAgentSkillDisplay(diskPath);

    return {
      id: encodeAgentSkillId(ref.id),
      name: display.name,
      description: ref.description || display.description,
      path: ref.path,
      missing,
    };
  });
}

export function attachSkillToAgent(agentId: string, skillId: string): void {
  const agent = store.getById('agents', agentId);
  if (!agent) throw new Error('Agent not found');

  const skill = getSkill(skillId);
  if (!skill) throw new Error('Skill not found');
  if (!findInstructionFile(agentId)) throw new Error('Agent instruction file not found');

  const currentSkills = readAgentSkillReferences(agentId);
  const src = skillDir(skillId);
  const dest = agentSkillDestPath(agentId, skill.name);
  const destId = normalizeAgentRelativePath(path.relative(agentDir(agentId), dest));
  const skillPath = normalizeAgentRelativePath(path.relative(agentDir(agentId), path.join(dest, 'index.md')));
  const existing = currentSkills.find((entry) => entry.id === destId);

  if (existing) return;
  if (fs.existsSync(dest)) {
    throw new Error(`Local skill path already exists: ${destId}`);
  }

  copyDirSync(src, dest);

  writeAgentSkillsSection(agentId, [
    ...currentSkills,
    {
      id: destId,
      path: skillPath,
      description: skill.description,
    },
  ]);
}

export function detachSkillFromAgent(agentId: string, skillId: string): void {
  const agent = store.getById('agents', agentId);
  if (!agent) throw new Error('Agent not found');

  const currentSkills = readAgentSkillReferences(agentId);
  const targetId = decodeAgentSkillId(skillId) ?? normalizeAgentRelativePath(skillId);
  const match = currentSkills.find((entry) => entry.id === targetId);
  if (!match) return;

  const dest = resolveAgentRelativePath(agentId, match.id);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  writeAgentSkillsSection(
    agentId,
    currentSkills.filter((entry) => entry.id !== match.id),
  );
  removeEmptyAgentSkillsFolder(agentId);
}

// ---------------------------------------------------------------------------
// Agent instruction skills section parsing
// ---------------------------------------------------------------------------

const SKILLS_START = '<!-- skills:start -->';
const SKILLS_END = '<!-- skills:end -->';

// ---------------------------------------------------------------------------
// Skill file operations (scoped to data/skills/{skillId}/)
// ---------------------------------------------------------------------------

export interface SkillFileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  createdAt: string;
}

function normalizePath(p: string): string {
  let normalized = p.trim().replace(/\\/g, '/');
  if (!normalized) normalized = '/';
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  if (normalized !== '/' && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function resolveSkillDiskPath(skillId: string, filePath: string): string {
  const dir = skillDir(skillId);
  return path.resolve(dir, '.' + filePath);
}

function validateSkillPath(skillId: string, p: string): string {
  const normalized = normalizePath(p);
  const resolved = resolveSkillDiskPath(skillId, normalized);
  const root = skillDir(skillId);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootPrefix)) {
    throw new Error('Path traversal detected');
  }
  return normalized;
}

export function listSkillFiles(skillId: string, dirPath: string): SkillFileEntry[] {
  const normalized = validateSkillPath(skillId, dirPath);
  const diskDir = resolveSkillDiskPath(skillId, normalized);

  if (!fs.existsSync(diskDir)) return [];
  const stats = fs.statSync(diskDir);
  if (!stats.isDirectory()) throw new Error('Path is not a directory');

  return fs
    .readdirSync(diskDir, { withFileTypes: true })
    .map((entry) => {
      const fullPath = path.join(diskDir, entry.name);
      if (!entry.isFile() && !entry.isDirectory()) return null;

      const st = fs.statSync(fullPath);
      const resolvedType = st.isFile() ? 'file' : st.isDirectory() ? 'folder' : null;
      if (!resolvedType) return null;

      const relative = path.relative(skillDir(skillId), fullPath).split(path.sep).join('/');
      const createdAtSource =
        Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtime : st.mtime;

      return {
        name: entry.name,
        path: normalizePath('/' + relative),
        type: resolvedType,
        size: resolvedType === 'file' ? st.size : 0,
        createdAt: createdAtSource.toISOString(),
      } as SkillFileEntry;
    })
    .filter((e): e is SkillFileEntry => e !== null);
}

export function readSkillFileContent(skillId: string, filePath: string): string | null {
  const normalized = validateSkillPath(skillId, filePath);
  const diskPath = resolveSkillDiskPath(skillId, normalized);
  if (!fs.existsSync(diskPath)) return null;
  const stats = fs.statSync(diskPath);
  if (!stats.isFile()) return null;
  return fs.readFileSync(diskPath, 'utf-8');
}

export function writeSkillFile(skillId: string, filePath: string, content: string): void {
  const normalized = validateSkillPath(skillId, filePath);
  const diskPath = resolveSkillDiskPath(skillId, normalized);
  const diskDir = path.dirname(diskPath);
  if (!fs.existsSync(diskDir)) {
    fs.mkdirSync(diskDir, { recursive: true });
  }
  fs.writeFileSync(diskPath, content, 'utf-8');
}

export async function uploadSkillFile(
  skillId: string,
  dirPath: string,
  fileName: string,
  buffer: Buffer,
): Promise<SkillFileEntry> {
  const parentPath = validateSkillPath(skillId, dirPath);
  const safeName = fileName.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!safeName) throw new Error('Invalid file name');

  const fullPath = parentPath === '/' ? '/' + safeName : parentPath + '/' + safeName;
  validateSkillPath(skillId, fullPath);

  const diskPath = resolveSkillDiskPath(skillId, fullPath);
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

export function createSkillFolder(skillId: string, dirPath: string, name: string): SkillFileEntry {
  const parentPath = validateSkillPath(skillId, dirPath);
  const safeName = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!safeName) throw new Error('Invalid folder name');

  const fullPath = parentPath === '/' ? '/' + safeName : parentPath + '/' + safeName;
  validateSkillPath(skillId, fullPath);

  const diskPath = resolveSkillDiskPath(skillId, fullPath);
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

export function deleteSkillFile(skillId: string, filePath: string): boolean {
  const normalized = validateSkillPath(skillId, filePath);
  if (normalized === '/') return false;

  const diskPath = resolveSkillDiskPath(skillId, normalized);
  if (!fs.existsSync(diskPath)) return false;
  fs.rmSync(diskPath, { recursive: true, force: true });
  return true;
}

export function getSkillFilePath(skillId: string, filePath: string): string | null {
  const normalized = validateSkillPath(skillId, filePath);
  const diskPath = resolveSkillDiskPath(skillId, normalized);
  if (!fs.existsSync(diskPath)) return null;
  const stats = fs.statSync(diskPath);
  if (!stats.isFile()) return null;
  return diskPath;
}

export function getSkillEntryPath(skillId: string, entryPath: string): string | null {
  const normalized = validateSkillPath(skillId, entryPath);
  const diskPath = resolveSkillDiskPath(skillId, normalized);
  if (!fs.existsSync(diskPath)) return null;
  return diskPath;
}

// ---------------------------------------------------------------------------
// Built-in skill seeding
// ---------------------------------------------------------------------------

interface BuiltinSkillManifest {
  name: string;
  description: string;
}

interface BuiltinSkillDef {
  name: string;
  description: string;
  /** Absolute path to the built-in skill folder (contains index.md + any other files). */
  srcDir: string;
}

function loadBuiltinSkills(): BuiltinSkillDef[] {
  if (!fs.existsSync(BUILTIN_SKILLS_DIR)) return [];

  const entries = fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true });
  const defs: BuiltinSkillDef[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(BUILTIN_SKILLS_DIR, entry.name);
    const manifestPath = path.join(srcDir, 'skill.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest: BuiltinSkillManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    );

    defs.push({
      name: manifest.name,
      description: manifest.description,
      srcDir,
    });
  }

  return defs;
}

/**
 * Ensure built-in skills from `src/presets/skills/` exist in the data store.
 * Creates missing skills and syncs the full folder contents for existing ones.
 */
export function seedBuiltinSkills(): void {
  ensureSkillsDir();

  const builtins = loadBuiltinSkills();
  const existing = store.getAll('skills');

  for (const def of builtins) {
    const match = existing.find(
      (s) => (s.name as string).toLowerCase() === def.name.toLowerCase(),
    );

    if (match) {
      // Sync description from manifest
      if ((match.description as string) !== def.description) {
        store.update('skills', match.id as string, { description: def.description });
      }

      // Sync folder contents from source into the data skill dir
      syncBuiltinSkillFolder(def.srcDir, skillDir(match.id as string));
      continue;
    }

    // Create the skill record and copy the whole folder
    const record = store.insert('skills', {
      id: randomUUID(),
      name: def.name,
      description: def.description,
    });

    const dest = skillDir(record.id as string);
    copyDirSync(def.srcDir, dest);

    // Remove the manifest — it's a build-time artifact, not a runtime skill file
    const copiedManifest = path.join(dest, 'skill.json');
    if (fs.existsSync(copiedManifest)) fs.unlinkSync(copiedManifest);
  }
}

/**
 * Copy every file from the built-in source folder into the data skill folder,
 * overwriting only files whose content has changed. Skips skill.json.
 */
function syncBuiltinSkillFolder(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'skill.json') continue;

    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      syncBuiltinSkillFolder(srcPath, destPath);
    } else {
      const srcContent = fs.readFileSync(srcPath);
      if (fs.existsSync(destPath)) {
        const destContent = fs.readFileSync(destPath);
        if (srcContent.equals(destContent)) continue;
      }
      fs.writeFileSync(destPath, srcContent);
    }
  }
}
