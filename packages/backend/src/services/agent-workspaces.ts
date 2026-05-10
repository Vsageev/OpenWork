import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { store } from '../db/index.js';

const AGENTS_DIR = path.resolve(env.DATA_DIR, 'agents');
const AGENT_WORKSPACE_SEGMENTS = ['.openwork', 'agents'] as const;

export function getLegacyAgentsDir(): string {
  return AGENTS_DIR;
}

export function getLegacyAgentWorkspacePath(agentId: string): string {
  return path.join(AGENTS_DIR, agentId);
}

export function slugifyAgentWorkspaceName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'agent'
  );
}

export function normalizeRepositoryRoot(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

export function deriveAgentWorkspacePath(repositoryRoot: string, agentName: string): string {
  return path.join(
    normalizeRepositoryRoot(repositoryRoot) ?? path.resolve(repositoryRoot),
    ...AGENT_WORKSPACE_SEGMENTS,
    slugifyAgentWorkspaceName(agentName),
  );
}

export function resolveAgentWorkspacePathFromRecord(
  agent: Record<string, unknown> | null | undefined,
  fallbackAgentId?: string,
): string {
  const configuredWorkspacePath =
    typeof agent?.workspacePath === 'string' && agent.workspacePath.trim()
      ? path.resolve(agent.workspacePath.trim())
      : null;
  if (configuredWorkspacePath) return configuredWorkspacePath;

  const agentId =
    fallbackAgentId ??
    (typeof agent?.id === 'string' && agent.id.trim() ? agent.id.trim() : null);
  if (!agentId) {
    throw new Error('Agent workspace path cannot be resolved without an agent id');
  }

  return getLegacyAgentWorkspacePath(agentId);
}

export function resolveAgentExecutionRootFromRecord(
  agent: Record<string, unknown> | null | undefined,
  fallbackAgentId?: string,
): string {
  const repositoryRoot =
    typeof agent?.repositoryRoot === 'string' && agent.repositoryRoot.trim()
      ? normalizeRepositoryRoot(agent.repositoryRoot)
      : null;
  if (repositoryRoot) return repositoryRoot;
  return resolveAgentWorkspacePathFromRecord(agent, fallbackAgentId);
}

export function resolveAgentWorkspacePath(agentId: string): string {
  const agent = store.getById('agents', agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  return resolveAgentWorkspacePathFromRecord(agent, agentId);
}

export function resolveAgentExecutionRoot(agentId: string): string {
  const agent = store.getById('agents', agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  return resolveAgentExecutionRootFromRecord(agent, agentId);
}

const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONVERSATION_CONTEXT_DIRECTORIES: ReadonlyArray<string> = ['skills', 'docs', 'memory'];

type ConversationContextEntry = {
  linkName: string;
  sourceName: string;
  kind: 'symlink' | 'materialized-file';
};

function listConversationContextEntries(agentWorkspaceRoot: string): ConversationContextEntry[] {
  const root = path.resolve(agentWorkspaceRoot);
  const entries: ConversationContextEntry[] = [];

  for (const dirName of CONVERSATION_CONTEXT_DIRECTORIES) {
    if (fs.existsSync(path.join(root, dirName))) {
      entries.push({ linkName: dirName, sourceName: dirName, kind: 'symlink' });
    }
  }

  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return entries;
  }

  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    const sourcePath = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(sourcePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    entries.push({ linkName: name, sourceName: name, kind: 'materialized-file' });
  }

  return entries;
}

export function assertSafeConversationWorkspaceId(conversationId: string): void {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error('Invalid conversation id for workspace path');
  }
}

function symlinkTargetsMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return path.normalize(actual) === path.normalize(expected);
}

/** Whether `linkPath` exists as its own directory entry (symlink, file, or dir), without following symlinks. */
function pathExistsAsEntry(linkPath: string): boolean {
  try {
    fs.lstatSync(linkPath);
    return true;
  } catch {
    return false;
  }
}

function formatInstructionDirectory(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

function renderConversationInstructionMarkdown(
  sourceContent: string,
  conversationDir: string,
): string {
  const cwd = formatInstructionDirectory(conversationDir);
  let rendered = sourceContent;

  rendered = rendered.replace(
    /^- The project repository root is `[^`]+`\.\n- Use other paths only if the task requires it; ask first when avoidable\.\s*$/m,
    [
      `- The working directory for this conversation is \`${cwd}\`. Work in this folder by default for commands and file operations.`,
      '- Use other paths only if the task requires it; ask first when avoidable.',
    ].join('\n'),
  );

  rendered = rendered.replace(
    /^- The project repository root is `[^`]+`\.\s*$/m,
    `- The working directory for this conversation is \`${cwd}\`. Work in this folder by default for commands and file operations.`,
  );

  rendered = rendered.replace(
    /^Default workspace behavior:\s*- Work in `[^`]+` by default for commands and file operations\.\s*$/m,
    `Default workspace behavior: - Work in \`${cwd}\` by default for commands and file operations.`,
  );

  return rendered;
}

function ensureConversationMaterializedFile(
  sourcePath: string,
  destinationPath: string,
  conversationDir: string,
): void {
  const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
  const renderedContent = renderConversationInstructionMarkdown(sourceContent, conversationDir);

  if (pathExistsAsEntry(destinationPath)) {
    const stat = fs.lstatSync(destinationPath);
    if (stat.isDirectory()) return;
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(destinationPath);
    } else if (stat.isFile()) {
      const existingContent = fs.readFileSync(destinationPath, 'utf-8');
      if (existingContent === renderedContent) return;
    } else {
      return;
    }
  }

  fs.writeFileSync(destinationPath, renderedContent, 'utf-8');
}

/**
 * Ensures `conversations/<conversationId>/` exists under the execution root and adds relative
 * symlinks back to the agent workspace context when the corresponding source exists. Idempotent;
 * skips missing sources; does not replace non-symlink entries at link paths.
 */
export function ensureConversationSubfolderWorkspace(
  agentWorkspaceRoot: string,
  executionRoot: string,
  conversationId: string,
): void {
  assertSafeConversationWorkspaceId(conversationId);
  const contextRoot = path.resolve(agentWorkspaceRoot);
  const root = path.resolve(executionRoot);
  const convDir = path.join(root, 'conversations', conversationId);
  fs.mkdirSync(convDir, { recursive: true });

  for (const { linkName, sourceName, kind } of listConversationContextEntries(contextRoot)) {
    const sourcePath = path.join(contextRoot, sourceName);
    const linkPath = path.join(convDir, linkName);
    if (kind === 'materialized-file') {
      ensureConversationMaterializedFile(sourcePath, linkPath, convDir);
      continue;
    }
    const relativeTarget = path.relative(convDir, sourcePath) || '.';
    if (pathExistsAsEntry(linkPath)) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(linkPath);
      } catch {
        continue;
      }
      if (!st.isSymbolicLink()) continue;

      try {
        const current = fs.readlinkSync(linkPath);
        if (symlinkTargetsMatch(current, relativeTarget)) continue;
      } catch {
        /* broken symlink; replace below */
      }
      fs.unlinkSync(linkPath);
    }

    fs.symlinkSync(relativeTarget, linkPath);
  }
}

export type AgentConversationWorkspaceMode = 'shared' | 'subfolder';

/**
 * Resolves the CLI working directory for an agent chat run. Shared mode uses the chosen
 * execution root; subfolder mode uses `workspaceRelativePath` or `conversations/<id>/`.
 */
export function resolveSubfolderProcessCwd(
  executionRoot: string,
  conversationId: string,
  workspaceMode: AgentConversationWorkspaceMode,
  workspaceRelativePath?: string,
): string {
  const root = path.resolve(executionRoot);
  if (workspaceMode !== 'subfolder') return root;
  assertSafeConversationWorkspaceId(conversationId);
  const rel =
    typeof workspaceRelativePath === 'string' && workspaceRelativePath.trim()
      ? workspaceRelativePath.trim()
      : `conversations/${conversationId}`;
  const resolved = path.resolve(root, rel);
  const expected = path.resolve(root, 'conversations', conversationId);
  if (resolved !== expected) return expected;
  return resolved;
}
