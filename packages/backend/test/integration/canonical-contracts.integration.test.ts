import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { setupTestEnvironment, importFresh } from '../support/test-env.ts';

const env = setupTestEnvironment('backend-integration-canonical');

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);

  const [{ registerJwt }, { agentRunRoutes }, { settingsRoutes }, { cardRoutes }] = await Promise.all([
    importFresh<typeof import('../../src/plugins/jwt.ts')>('../../src/plugins/jwt.ts'),
    importFresh<typeof import('../../src/routes/agent-runs.ts')>('../../src/routes/agent-runs.ts'),
    importFresh<typeof import('../../src/routes/settings.ts')>('../../src/routes/settings.ts'),
    importFresh<typeof import('../../src/routes/cards.ts')>('../../src/routes/cards.ts'),
  ]);

  await registerJwt(app);
  await app.register(agentRunRoutes);
  await app.register(settingsRoutes);
  await app.register(cardRoutes);

  return app;
}

async function createAuthHeader(app: FastifyInstance): Promise<string> {
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  await store.init();
  const user = store.insert('users', {
    email: 'tester@example.com',
    passwordHash: 'hash',
    firstName: 'Test',
    lastName: 'User',
    type: 'human',
    isActive: true,
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
  });

  return `Bearer ${app.jwt.sign({ sub: user.id as string })}`;
}

test('agent run filter accepts canonical trigger type and rejects legacy query aliases', async () => {
  const app = await buildTestApp();
  const auth = await createAuthHeader(app);
  const { createAgentRun } = await importFresh<typeof import('../../src/services/agent-runs.ts')>(
    '../../src/services/agent-runs.ts',
  );

  createAgentRun({
    agentId: 'agent-1',
    agentName: 'Agent One',
    triggerType: 'cron_job',
  });

  const canonicalResponse = await app.inject({
    method: 'GET',
    url: '/api/agent-runs?triggerType=cron_job',
    headers: { authorization: auth },
  });
  assert.equal(canonicalResponse.statusCode, 200);
  const canonicalPayload = canonicalResponse.json();
  assert.equal(canonicalPayload.total, 1);
  assert.equal(canonicalPayload.entries[0].triggerType, 'cron_job');

  const legacyCronResponse = await app.inject({
    method: 'GET',
    url: '/api/agent-runs?triggerType=cron',
    headers: { authorization: auth },
  });
  assert.equal(legacyCronResponse.statusCode, 400);

  const legacyCardResponse = await app.inject({
    method: 'GET',
    url: '/api/agent-runs?triggerType=card',
    headers: { authorization: auth },
  });
  assert.equal(legacyCardResponse.statusCode, 400);

  await app.close();
});

test('agent run list returns summaries and excludes heavy log fields until detail fetch', async () => {
  const app = await buildTestApp();
  const auth = await createAuthHeader(app);
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  const { createAgentRun } = await importFresh<typeof import('../../src/services/agent-runs.ts')>(
    '../../src/services/agent-runs.ts',
  );

  const created = createAgentRun({
    agentId: 'agent-logs',
    agentName: 'Log Agent',
    triggerType: 'chat',
    conversationId: 'conv-1',
    triggerPrompt: 'Large prompt body',
  });

  store.update('agent_runs', created.id as string, {
    status: 'completed',
    stdout: 'very large stdout payload',
    stderr: 'very large stderr payload',
    responseText: 'short response',
    finishedAt: new Date().toISOString(),
    durationMs: 42,
  });

  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/agent-runs',
    headers: { authorization: auth },
  });
  assert.equal(listResponse.statusCode, 200);

  const listPayload = listResponse.json();
  const listedRun = listPayload.entries.find((entry: { id: string }) => entry.id === created.id);
  assert.ok(listedRun);
  assert.equal(listedRun.responseText, 'short response');
  assert.equal('stdout' in listedRun, false);
  assert.equal('stderr' in listedRun, false);
  assert.equal('triggerPrompt' in listedRun, false);

  const activeResponse = await app.inject({
    method: 'GET',
    url: '/api/agent-runs/active',
    headers: { authorization: auth },
  });
  assert.equal(activeResponse.statusCode, 200);
  const activePayload = activeResponse.json();
  if (activePayload.entries.length > 0) {
    assert.equal('stdout' in activePayload.entries[0], false);
    assert.equal('stderr' in activePayload.entries[0], false);
    assert.equal('triggerPrompt' in activePayload.entries[0], false);
  }

  const detailResponse = await app.inject({
    method: 'GET',
    url: `/api/agent-runs/${created.id as string}`,
    headers: { authorization: auth },
  });
  assert.equal(detailResponse.statusCode, 200);
  const detailPayload = detailResponse.json();
  assert.equal(detailPayload.stdout, 'very large stdout payload');
  assert.equal(detailPayload.stderr, 'very large stderr payload');
  assert.equal(detailPayload.triggerPrompt, 'Large prompt body');

  await app.close();
});

test('agent default settings reject legacy payload keys instead of silently stripping them', async () => {
  const app = await buildTestApp();
  const auth = await createAuthHeader(app);

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/settings/agent-defaults',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
    },
    payload: {
      masterAgentKeyId: '11111111-1111-1111-1111-111111111111',
    },
  });

  assert.equal(response.statusCode, 400);

  const getResponse = await app.inject({
    method: 'GET',
    url: '/api/settings/agent-defaults',
    headers: { authorization: auth },
  });
  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(Object.keys(getResponse.json()).sort(), ['defaultAgentKeyId']);

  await app.close();
});

test('card routes reject legacy checklist payloads instead of silently stripping them', async () => {
  const app = await buildTestApp();
  const auth = await createAuthHeader(app);

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/cards',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
    },
    payload: {
      collectionId: '11111111-1111-4111-8111-111111111111',
      name: 'Card with legacy checklist',
      customFields: {
        checklist: [{ id: 'item-1', text: 'Legacy item', done: false }],
      },
    },
  });

  assert.equal(createResponse.statusCode, 400);

  const validCreateResponse = await app.inject({
    method: 'POST',
    url: '/api/cards',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
    },
    payload: {
      collectionId: '11111111-1111-4111-8111-111111111111',
      name: 'Card without legacy checklist',
      customFields: {
        priority: 'high',
      },
    },
  });

  assert.equal(validCreateResponse.statusCode, 201);
  const created = validCreateResponse.json();

  const patchResponse = await app.inject({
    method: 'PATCH',
    url: `/api/cards/${created.id as string}`,
    headers: {
      authorization: auth,
      'content-type': 'application/json',
    },
    payload: {
      customFields: {
        checklist: [{ id: 'item-2', text: 'Still legacy', done: true }],
      },
    },
  });

  assert.equal(patchResponse.statusCode, 400);

  await app.close();
});

after(async () => {
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  await store.flush();
  env.cleanup();
});
