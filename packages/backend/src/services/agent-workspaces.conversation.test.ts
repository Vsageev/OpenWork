import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ensureConversationSubfolderWorkspace,
  resolveSubfolderProcessCwd,
} from './agent-workspaces.js';

const SAMPLE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('resolveSubfolderProcessCwd', () => {
  it('returns agent root for shared mode', () => {
    const root = path.join(os.tmpdir(), 'agent-root');
    expect(resolveSubfolderProcessCwd(root, SAMPLE_ID, 'shared')).toBe(path.resolve(root));
  });

  it('resolves subfolder relative path from metadata', () => {
    const root = path.join(os.tmpdir(), 'agent-root');
    const cwd = resolveSubfolderProcessCwd(root, SAMPLE_ID, 'subfolder', `conversations/${SAMPLE_ID}`);
    expect(cwd).toBe(path.resolve(root, 'conversations', SAMPLE_ID));
  });

  it('defaults relative path to conversations/<id> for subfolder', () => {
    const root = '/tmp/foo';
    const cwd = resolveSubfolderProcessCwd(root, SAMPLE_ID, 'subfolder');
    expect(cwd).toBe(path.resolve(root, 'conversations', SAMPLE_ID));
  });

  it('keeps malformed subfolder metadata inside the target folder', () => {
    const root = '/tmp/foo';
    expect(resolveSubfolderProcessCwd(root, SAMPLE_ID, 'subfolder', '/tmp/foo')).toBe(
      path.resolve(root, 'conversations', SAMPLE_ID),
    );
    expect(resolveSubfolderProcessCwd(root, SAMPLE_ID, 'subfolder', '../outside')).toBe(
      path.resolve(root, 'conversations', SAMPLE_ID),
    );
  });
});

describe('ensureConversationSubfolderWorkspace', () => {
  let tmp: string;
  let repoRoot: string;
  let agentRoot: string;
  let convDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-conv-ws-'));
    repoRoot = path.join(tmp, 'repo');
    agentRoot = path.join(repoRoot, '.openwork', 'agents', 'test-agent');
    fs.mkdirSync(agentRoot, { recursive: true });
    convDir = path.join(repoRoot, 'conversations', SAMPLE_ID);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates conversation directory, materializes instruction markdown, and symlinks shared directories', () => {
    fs.writeFileSync(
      path.join(agentRoot, 'AGENTS.md'),
      '- The project repository root is `/tmp/original/`.\n- Use other paths only if the task requires it; ask first when avoidable.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(agentRoot, 'CLAUDE.MD'),
      'Default workspace behavior: - Work in `/tmp/original/` by default for commands and file operations.\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(agentRoot, 'skills'));
    fs.mkdirSync(path.join(agentRoot, 'docs'));
    fs.mkdirSync(path.join(agentRoot, 'memory'));

    ensureConversationSubfolderWorkspace(agentRoot, repoRoot, SAMPLE_ID);

    expect(fs.existsSync(convDir)).toBe(true);
    const agentsContent = fs.readFileSync(path.join(convDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain(
      `- The working directory for this conversation is \`${path.resolve(convDir)}/\`. Work in this folder by default for commands and file operations.`,
    );
    expect(agentsContent).not.toContain('The project repository root is');
    expect(
      agentsContent.match(
        /- Use other paths only if the task requires it; ask first when avoidable\./g,
      ),
    ).toHaveLength(1);
    expect(fs.readFileSync(path.join(convDir, 'CLAUDE.MD'), 'utf-8')).toContain(
      `Default workspace behavior: - Work in \`${path.resolve(convDir)}/\` by default for commands and file operations.`,
    );
    expect(fs.readlinkSync(path.join(convDir, 'skills'))).toBe(
      '../../.openwork/agents/test-agent/skills',
    );
    expect(fs.readlinkSync(path.join(convDir, 'docs'))).toBe(
      '../../.openwork/agents/test-agent/docs',
    );
    expect(fs.readlinkSync(path.join(convDir, 'memory'))).toBe(
      '../../.openwork/agents/test-agent/memory',
    );

    expect(fs.lstatSync(path.join(convDir, 'AGENTS.md')).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(convDir, 'CLAUDE.MD')).isFile()).toBe(true);
  });

  it('skips symlinks when optional sources are missing', () => {
    fs.writeFileSync(path.join(agentRoot, 'CLAUDE.MD'), 'x', 'utf-8');
    fs.mkdirSync(path.join(agentRoot, 'skills'));

    ensureConversationSubfolderWorkspace(agentRoot, repoRoot, SAMPLE_ID);

    expect(fs.existsSync(path.join(convDir, 'CLAUDE.MD'))).toBe(true);
    expect(fs.existsSync(path.join(convDir, 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(convDir, 'docs'))).toBe(false);
    expect(fs.existsSync(path.join(convDir, 'memory'))).toBe(false);
  });

  it('is idempotent when called repeatedly', () => {
    fs.writeFileSync(
      path.join(agentRoot, 'CLAUDE.MD'),
      'Default workspace behavior: - Work in `/tmp/original/` by default for commands and file operations.\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(agentRoot, 'skills'));

    ensureConversationSubfolderWorkspace(agentRoot, repoRoot, SAMPLE_ID);
    ensureConversationSubfolderWorkspace(agentRoot, repoRoot, SAMPLE_ID);

    expect(fs.readFileSync(path.join(convDir, 'CLAUDE.MD'), 'utf-8')).toContain(
      `Default workspace behavior: - Work in \`${path.resolve(convDir)}/\` by default for commands and file operations.`,
    );
  });

  it('replaces an old markdown symlink with a conversation-local materialized file', () => {
    fs.writeFileSync(
      path.join(agentRoot, 'CLAUDE.MD'),
      'Default workspace behavior: - Work in `/tmp/original/` by default for commands and file operations.\n',
      'utf-8',
    );
    fs.mkdirSync(convDir, { recursive: true });
    fs.symlinkSync('wrong', path.join(convDir, 'CLAUDE.MD'));

    ensureConversationSubfolderWorkspace(agentRoot, repoRoot, SAMPLE_ID);

    expect(fs.lstatSync(path.join(convDir, 'CLAUDE.MD')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(convDir, 'CLAUDE.MD'), 'utf-8')).toContain(
      `Default workspace behavior: - Work in \`${path.resolve(convDir)}/\` by default for commands and file operations.`,
    );
  });
});
