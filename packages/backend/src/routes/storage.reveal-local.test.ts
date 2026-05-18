import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../plugins/error-handler.js';
import { storageRoutes } from './storage.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

async function buildRouteApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'test-user' };
  });
  registerErrorHandler(app);
  await app.register(storageRoutes);
  return app;
}

describe('storage local path reveal endpoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwork-reveal-local-'));
    mocks.spawn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reveals an existing absolute host path through the OS file manager', async () => {
    const app = await buildRouteApp();
    const filePath = path.join(tmpDir, 'file.ts');
    fs.writeFileSync(filePath, 'export const value = 1;\n');

    const response = await app.inject({
      method: 'POST',
      url: '/api/storage/reveal-local',
      payload: { path: filePath },
    });

    expect(response.statusCode).toBe(204);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects relative paths', async () => {
    const app = await buildRouteApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/storage/reveal-local',
      payload: { path: 'relative/file.ts' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'Path must be absolute' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
