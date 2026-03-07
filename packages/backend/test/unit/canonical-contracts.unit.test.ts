import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnvironment, importFresh } from '../support/test-env.ts';

const env = setupTestEnvironment('backend-unit-canonical');

test('agent run schema accepts canonical trigger types and rejects legacy values', async () => {
  const { agentRunSchema } = await importFresh<typeof import('../../src/schemas/collections.ts')>(
    '../../src/schemas/collections.ts',
  );

  const baseRun = {
    id: 'run-1',
    agentId: 'agent-1',
    agentName: 'Agent',
    status: 'completed',
    conversationId: null,
    cardId: null,
    cronJobId: null,
    errorMessage: null,
    responseText: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(
    agentRunSchema.safeParse({ ...baseRun, triggerType: 'cron_job' }).success,
    true,
  );
  assert.equal(
    agentRunSchema.safeParse({ ...baseRun, triggerType: 'card_assignment' }).success,
    true,
  );
  assert.equal(agentRunSchema.safeParse({ ...baseRun, triggerType: 'cron' }).success, false);
  assert.equal(agentRunSchema.safeParse({ ...baseRun, triggerType: 'card' }).success, false);
});

test('project settings ignore removed legacy key fields and expose canonical defaults only', async () => {
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  const {
    getProjectSettings,
    updateProjectSettings,
  } = await importFresh<typeof import('../../src/services/project-settings.ts')>(
    '../../src/services/project-settings.ts',
  );

  await store.init();
  store.insert('settings', {
    id: 'project',
    masterAgentKeyId: 'legacy-key-id',
  });

  const settings = getProjectSettings();
  assert.deepEqual(Object.keys(settings).sort(), [
    'createdAt',
    'defaultAgentKeyId',
    'id',
    'updatedAt',
  ]);
  assert.equal(settings.defaultAgentKeyId, null);
  assert.equal('masterAgentKeyId' in settings, false);

  const updated = updateProjectSettings({ defaultAgentKeyId: 'canonical-key-id' });
  assert.equal(updated.defaultAgentKeyId, 'canonical-key-id');

  const stored = store.getById('settings', 'project') as Record<string, unknown>;
  assert.equal(stored.defaultAgentKeyId, 'canonical-key-id');
});

test('card schema rejects legacy checklist custom field payloads', async () => {
  const { cardSchema } = await importFresh<typeof import('../../src/schemas/collections.ts')>(
    '../../src/schemas/collections.ts',
  );

  const baseCard = {
    id: 'card-1',
    collectionId: 'collection-1',
    name: 'Card',
    description: null,
    customFields: {},
    createdById: 'user-1',
    assigneeId: null,
    position: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(cardSchema.safeParse(baseCard).success, true);
  assert.equal(
    cardSchema.safeParse({
      ...baseCard,
      customFields: {
        checklist: [{ id: 'item-1', text: 'Legacy item', done: false }],
      },
    }).success,
    false,
  );
});

after(async () => {
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  await store.flush();
  env.cleanup();
});
