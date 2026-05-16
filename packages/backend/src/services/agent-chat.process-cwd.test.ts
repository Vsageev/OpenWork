import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetById = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../db/index.js', () => ({
  store: {
    getById: (col: string, id: string) => mockGetById(col, id),
    update: (col: string, id: string, patch: Record<string, unknown>) =>
      mockUpdate(col, id, patch),
  },
}));

import { buildRunnerJobIntent, resolveAgentChatProcessWorkingDirectory } from './agent-chat.js';

const AGENT_ID = '11111111-2222-3333-4444-555555555555';
const CONV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('resolveAgentChatProcessWorkingDirectory', () => {
  let tmp: string;
  let repositoryRoot: string;
  let agentRoot: string;
  let conversationMetadata: Record<string, unknown> | undefined;
  let separateFolderPerChat: boolean;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-chat-cwd-'));
    repositoryRoot = path.join(tmp, 'repo');
    agentRoot = path.join(repositoryRoot, '.openwork', 'agents', 'test-agent');
    fs.mkdirSync(agentRoot, { recursive: true });
    conversationMetadata = undefined;
    separateFolderPerChat = false;

    mockGetById.mockImplementation((col: string, id: string) => {
      if (col === 'agents' && id === AGENT_ID) {
        return {
          id: AGENT_ID,
          name: 'Test',
          repositoryRoot,
          workspacePath: agentRoot,
          separateFolderPerChat,
        };
      }
      if (col === 'conversations' && id === CONV_ID) {
        return {
          id: CONV_ID,
          metadata:
            conversationMetadata === undefined ? undefined : JSON.stringify(conversationMetadata),
        };
      }
      return null;
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    mockGetById.mockReset();
    mockUpdate.mockReset();
  });

  it('uses repository root when conversationId is omitted for repo-backed agents', () => {
    const cwd = resolveAgentChatProcessWorkingDirectory(AGENT_ID, undefined);
    expect(cwd).toBe(path.resolve(repositoryRoot));
  });

  it('uses repository root for shared-mode conversation metadata when the toggle is disabled', () => {
    conversationMetadata = { workspaceMode: 'shared' };
    const cwd = resolveAgentChatProcessWorkingDirectory(AGENT_ID, CONV_ID);
    expect(cwd).toBe(path.resolve(repositoryRoot));
  });

  it('materializes an explicitly shared conversation into subfolder mode when the agent toggle is enabled', () => {
    separateFolderPerChat = true;
    conversationMetadata = { agentId: AGENT_ID, workspaceMode: 'shared' };

    const cwd = resolveAgentChatProcessWorkingDirectory(AGENT_ID, CONV_ID);

    expect(cwd).toBe(path.resolve(repositoryRoot, 'conversations', CONV_ID));
    const updatePatch = mockUpdate.mock.calls[0]?.[2] as { metadata?: string };
    expect(JSON.parse(updatePatch.metadata ?? '{}')).toMatchObject({
      agentId: AGENT_ID,
      workspaceMode: 'subfolder',
      workspaceRelativePath: `conversations/${CONV_ID}`,
      workspaceSeedMode: 'symlink',
    });
  });

  it('uses conversation subfolder cwd and materializes instruction markdown with conversation cwd', () => {
    fs.writeFileSync(
      path.join(agentRoot, 'CLAUDE.MD'),
      'Default workspace behavior: - Work in `/tmp/original/` by default for commands and file operations.\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(agentRoot, 'skills'));
    fs.writeFileSync(path.join(agentRoot, 'skills', 'x.md'), 'skill', 'utf-8');

    conversationMetadata = {
      workspaceMode: 'subfolder',
      workspaceRelativePath: `conversations/${CONV_ID}`,
    };

    const cwd = resolveAgentChatProcessWorkingDirectory(AGENT_ID, CONV_ID);
    const expected = path.resolve(repositoryRoot, 'conversations', CONV_ID);
    expect(cwd).toBe(expected);
    expect(cwd.startsWith(path.resolve(repositoryRoot))).toBe(true);
    expect(cwd.startsWith(path.resolve(agentRoot))).toBe(false);
    expect(cwd).not.toBe(path.resolve(agentRoot));

    expect(fs.readFileSync(path.join(cwd, 'CLAUDE.MD'), 'utf-8')).toContain(
      `Default workspace behavior: - Work in \`${path.resolve(cwd)}/\` by default for commands and file operations.`,
    );
    expect(fs.realpathSync(path.join(cwd, 'skills', 'x.md'))).toBe(
      fs.realpathSync(path.join(agentRoot, 'skills', 'x.md')),
    );
  });

  it('defaults subfolder relative path to conversations/<id> when metadata omits workspaceRelativePath', () => {
    conversationMetadata = { workspaceMode: 'subfolder' };

    const cwd = resolveAgentChatProcessWorkingDirectory(AGENT_ID, CONV_ID);
    expect(cwd).toBe(path.resolve(repositoryRoot, 'conversations', CONV_ID));
  });

  it('materializes a legacy conversation into subfolder mode when the agent toggle is enabled', () => {
    separateFolderPerChat = true;
    conversationMetadata = { agentId: AGENT_ID, activeBranches: { root: 'message-id' } };

    const cwd = resolveAgentChatProcessWorkingDirectory(AGENT_ID, CONV_ID);

    expect(cwd).toBe(path.resolve(repositoryRoot, 'conversations', CONV_ID));
    expect(mockUpdate).toHaveBeenCalledWith(
      'conversations',
      CONV_ID,
      expect.objectContaining({
        metadata: expect.stringContaining('"workspaceMode":"subfolder"'),
      }),
    );
    const updatePatch = mockUpdate.mock.calls[0]?.[2] as { metadata?: string };
    expect(JSON.parse(updatePatch.metadata ?? '{}')).toMatchObject({
      agentId: AGENT_ID,
      activeBranches: { root: 'message-id' },
      workspaceMode: 'subfolder',
      workspaceRelativePath: `conversations/${CONV_ID}`,
      workspaceSeedMode: 'symlink',
    });
  });

  it('falls back to the agent folder when there is no repository root', () => {
    mockGetById.mockImplementation((col: string, id: string) => {
      if (col === 'agents' && id === AGENT_ID) {
        return {
          id: AGENT_ID,
          name: 'Test',
          repositoryRoot: null,
          workspacePath: agentRoot,
          separateFolderPerChat,
        };
      }
      if (col === 'conversations' && id === CONV_ID) {
        return {
          id: CONV_ID,
          metadata:
            conversationMetadata === undefined ? undefined : JSON.stringify(conversationMetadata),
        };
      }
      return null;
    });

    const cwd = resolveAgentChatProcessWorkingDirectory(AGENT_ID, undefined);
    expect(cwd).toBe(path.resolve(agentRoot));
  });
});

describe('buildRunnerJobIntent', () => {
  it('wraps backend run data in the protocol intent expected by remote dispatch', () => {
    const intent = buildRunnerJobIntent({
      runId: 'run-1',
      agentId: AGENT_ID,
      workspaceId: 'workspace-1',
      agent: {
        name: 'Test',
        model: 'codex',
        modelId: 'gpt-5.5',
        thinkingLevel: 'low',
        apiKeyId: 'key-1',
        workspaceApiKey: 'workspace-key',
      },
      prompt: 'hello',
      workDir: '/tmp/openwork-test',
      childEnv: {
        PROJECT_PORT: '4321',
        EMPTY: undefined,
      },
      imagePaths: ['/tmp/image.png'],
      filePaths: ['/tmp/context.txt'],
    });

    expect(intent).toMatchObject({
      runId: 'run-1',
      agentId: AGENT_ID,
      agentKind: 'dev_agent',
      provider: 'codex',
      modelPreference: {
        displayName: 'codex',
        modelId: 'gpt-5.5',
        thinkingLevel: 'low',
      },
      prompt: 'hello',
      workspace: {
        type: 'local_path',
        path: '/tmp/openwork-test',
        workspaceId: 'workspace-1',
      },
      allowedOperations: {
        tools: ['codex'],
        approvalMode: 'dangerous',
      },
    });
    expect(intent.attachments).toEqual([
      {
        type: 'image',
        path: '/tmp/image.png',
        filename: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 0,
        textExtraction: { status: 'not_applicable' },
      },
      {
        type: 'file',
        path: '/tmp/context.txt',
        filename: 'context.txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        textExtraction: { status: 'available', textPath: '/tmp/context.txt' },
      },
    ]);
    expect(intent.environment?.variables).toEqual([
      {
        name: 'PROJECT_PORT',
        value: '4321',
        source: 'runtime',
        secret: true,
      },
    ]);
  });
});
