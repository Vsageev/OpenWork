import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { importFresh, setupTestEnvironment } from '../support/test-env.ts';

test('updateAgent renames the preset instruction file when the provider changes', async () => {
  const env = setupTestEnvironment('agents-model-file-rename');

  try {
    const db = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
    await db.store.init();

    const agents = await importFresh<typeof import('../../src/services/agents.ts')>(
      '../../src/services/agents.ts',
    );

    const agent = await agents.createAgent({
      name: 'Rename Test',
      description: 'Checks provider-specific file renames',
      model: 'Claude',
      preset: 'basic',
      apiKeyId: 'seed-key',
      apiKeyName: 'Seed Key',
      apiKeyPrefix: 'ws_seed',
      capabilities: [],
    });

    const agentDir = agents.getAgentEntryPath(agent.id, '/');
    assert.ok(agentDir);
    const claudePath = path.join(agentDir, 'CLAUDE.MD');
    const agentsPath = path.join(agentDir, 'AGENTS.md');

    assert.equal(fs.existsSync(claudePath), true);
    assert.equal(fs.existsSync(agentsPath), false);

    const updated = agents.updateAgent(agent.id, { model: 'Codex' });

    assert.ok(updated);
    assert.equal(updated.model, 'Codex');
    assert.equal(fs.existsSync(claudePath), false);
    assert.equal(fs.existsSync(agentsPath), true);
  } finally {
    env.cleanup();
  }
});

test('updateAgent renames the preset instruction file when the UI sends a lowercase provider id', async () => {
  const env = setupTestEnvironment('agents-model-file-rename-lowercase');

  try {
    const db = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
    await db.store.init();

    const agents = await importFresh<typeof import('../../src/services/agents.ts')>(
      '../../src/services/agents.ts',
    );

    const agent = await agents.createAgent({
      name: 'Rename UI Test',
      description: 'Checks lowercase provider ids from the settings UI',
      model: 'Claude',
      preset: 'basic',
      apiKeyId: 'seed-key',
      apiKeyName: 'Seed Key',
      apiKeyPrefix: 'ws_seed',
      capabilities: [],
    });

    const agentDir = agents.getAgentEntryPath(agent.id, '/');
    assert.ok(agentDir);
    const claudePath = path.join(agentDir, 'CLAUDE.MD');
    const agentsPath = path.join(agentDir, 'AGENTS.md');

    assert.equal(fs.existsSync(claudePath), true);
    assert.equal(fs.existsSync(agentsPath), false);

    const updated = agents.updateAgent(agent.id, { model: 'codex' });

    assert.ok(updated);
    assert.equal(updated.model, 'codex');
    assert.equal(fs.existsSync(claudePath), false);
    assert.equal(fs.existsSync(agentsPath), true);
  } finally {
    env.cleanup();
  }
});

test('updateAgent does not overwrite an existing target instruction file on provider change', async () => {
  const env = setupTestEnvironment('agents-model-file-rename-collision');

  try {
    const db = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
    await db.store.init();

    const agents = await importFresh<typeof import('../../src/services/agents.ts')>(
      '../../src/services/agents.ts',
    );

    const agent = await agents.createAgent({
      name: 'Rename Collision Test',
      description: 'Keeps existing destination files intact',
      model: 'Claude',
      preset: 'basic',
      apiKeyId: 'seed-key',
      apiKeyName: 'Seed Key',
      apiKeyPrefix: 'ws_seed',
      capabilities: [],
    });

    const agentDir = agents.getAgentEntryPath(agent.id, '/');
    assert.ok(agentDir);
    const claudePath = path.join(agentDir, 'CLAUDE.MD');
    const agentsPath = path.join(agentDir, 'AGENTS.md');

    fs.writeFileSync(agentsPath, 'existing target content', 'utf8');
    const originalClaudeContent = fs.readFileSync(claudePath, 'utf8');

    const updated = agents.updateAgent(agent.id, { model: 'Codex' });

    assert.ok(updated);
    assert.equal(fs.readFileSync(claudePath, 'utf8'), originalClaudeContent);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), 'existing target content');
  } finally {
    env.cleanup();
  }
});
