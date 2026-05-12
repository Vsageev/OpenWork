import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlStoreAdapter } from './sql-store-adapter.js';
import type { Store, StoreRecord } from './store.js';

const sqlDatabaseUrl = process.env.STORE_CONTRACT_DATABASE_URL ?? process.env.DATABASE_URL;
const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('store contract', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!sqlDatabaseUrl)('preserves SQL store semantics', async () => {
    await withTemporaryPostgresDatabase(sqlDatabaseUrl!, async (databaseUrl) => {
      const store = new SqlStoreAdapter({
        driver: 'postgres',
        databaseUrl,
        migrationsDir: './drizzle',
        migrationsTable: '__drizzle_migrations',
        migrationsSchema: 'drizzle',
      });

      await store.init();
      await exerciseStoreContract(store);

      const restartRecord = await store.insert('users', userRecord('restart-user'));
      const restartedStore = new SqlStoreAdapter({
        driver: 'postgres',
        databaseUrl,
        migrationsDir: './drizzle',
        migrationsTable: '__drizzle_migrations',
        migrationsSchema: 'drizzle',
      });
      await restartedStore.init();
      expect(restartedStore.getById('users', String(restartRecord.id))).toMatchObject({
        email: 'restart-user@example.test',
      });
      await store.delete('users', String(restartRecord.id));
      await store.flush();
    });
  });

  it('surfaces SQL write failures before a mutation is confirmed', async () => {
    const store = new SqlStoreAdapter(baseConfig(), failingUsersClient('forced insert failure'));
    await store.init();

    await expect(
      store.insert('users', {
        id: 'failed-user',
        email: 'failed@example.test',
        passwordHash: 'hash',
        firstName: 'Failed',
        lastName: 'User',
        type: 'human',
        isActive: true,
        totpSecret: null,
        totpEnabled: false,
        recoveryCodes: null,
      }),
    ).rejects.toThrow('forced insert failure');

    expect(store.getById('users', 'failed-user')).toBeNull();
  });

  it('rolls back cached transaction state when a SQL write fails', async () => {
    const store = new SqlStoreAdapter(baseConfig(), failingUsersClient('forced tx failure'));
    await store.init();

    await expect(
      store.transaction(async () => {
        await store.insert('users', {
          id: 'tx-failed-user',
          email: 'tx-failed@example.test',
          passwordHash: 'hash',
          firstName: 'Failed',
          lastName: 'Tx',
          type: 'human',
          isActive: true,
          totpSecret: null,
          totpEnabled: false,
          recoveryCodes: null,
        });
      }),
    ).rejects.toThrow('forced tx failure');

    expect(store.getById('users', 'tx-failed-user')).toBeNull();
  });
});

async function exerciseStoreContract(store: Store) {
  const imported = await store.insert('users', {
    id: 'imported-user',
    email: 'imported@example.test',
    passwordHash: 'hash',
    firstName: 'Imported',
    lastName: 'User',
    type: 'human',
    isActive: true,
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  });

  expect(imported.id).toBe('imported-user');
  expect(imported.createdAt).toBe('2024-01-01T00:00:00.000Z');
  expect(store.getById('users', 'imported-user')).toMatchObject({
    email: 'imported@example.test',
  });

  const generated = await store.insert('users', {
    email: 'generated@example.test',
    passwordHash: 'hash',
    firstName: 'Generated',
    lastName: 'User',
    type: 'human',
    isActive: true,
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
  });

  expect(typeof generated.id).toBe('string');
  expect(typeof generated.createdAt).toBe('string');
  expect(typeof generated.updatedAt).toBe('string');

  const many = await Promise.all(store.insertMany('users', [
    {
      id: 'many-one',
      email: 'many-one@example.test',
      passwordHash: 'hash',
      firstName: 'Many',
      lastName: 'One',
      type: 'human',
      isActive: true,
      totpSecret: null,
      totpEnabled: false,
      recoveryCodes: null,
      createdAt: '2024-01-02T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    },
    {
      id: 'many-two',
      email: 'many-two@example.test',
      passwordHash: 'hash',
      firstName: 'Many',
      lastName: 'Two',
      type: 'human',
      isActive: false,
      totpSecret: null,
      totpEnabled: false,
      recoveryCodes: null,
    },
  ]));

  expect(many.map((record) => record.id)).toEqual(['many-one', 'many-two']);
  expect(store.getAll('users').map((record) => record.id)).toEqual([
    'imported-user',
    generated.id,
    'many-one',
    'many-two',
  ]);
  expect(store.getAll('users').filter((record) => record.isActive === true)).toHaveLength(3);
  expect(store.getAll('users').find((record) => record.email === 'many-two@example.test')?.id).toBe(
    'many-two',
  );
  expect(store.count('users')).toBe(4);
  expect(store.getAll('users').filter((record) => record.firstName === 'Many')).toHaveLength(2);

  const updated = await store.update('users', 'many-one', { id: 'ignored', firstName: 'Updated' });
  expect(updated).toMatchObject({ id: 'many-one', firstName: 'Updated' });
  expect(updated?.updatedAt).not.toBe(many[0].updatedAt);
  expect(store.update('users', 'missing', { firstName: 'Nobody' })).toBeNull();

  const contact = await store.insert('contacts', {
    id: 'contact-one',
    firstName: 'Mapped',
    lastName: 'Contact',
    telegramId: 'tg-1',
  });
  expect(contact.id).toBe('contact-one');
  expect(store.getById('contacts', 'contact-one')).toMatchObject({ firstName: 'Mapped' });
  expect(() => store.insert('unknownCollection', { id: 'unknown-one' })).toThrow(
    'No SQL table mapping is configured',
  );
  expect(store.count('missingCollection')).toBe(0);

  await store.flush();
  await store.reload();

  expect(store.getById('users', 'many-one')).toMatchObject({ firstName: 'Updated' });
  expect(store.getById('contacts', 'contact-one')).toMatchObject({ telegramId: 'tg-1' });
  const usersAfterReload = store.getAll('users').map((record) => record.id);
  expect(new Set(usersAfterReload)).toEqual(
    new Set(['imported-user', generated.id, 'many-one', 'many-two']),
  );

  expect(await store.delete('users', 'many-two')).toMatchObject({ id: 'many-two' });
  expect(store.delete('users', 'missing')).toBeNull();
  expect(await deleteMatching(store, 'users', (record) => record.firstName === 'Many')).toHaveLength(0);
  expect(await deleteMatching(store, 'contacts', (record) => record.telegramId === 'tg-1')).toHaveLength(
    1,
  );
  expect(
    await deleteMatching(store, 'users', (record) => String(record.email).endsWith('@example.test')),
  ).toHaveLength(3);

  await store.flush();
  await store.reload();

  expect(store.getAll('users')).toEqual([]);
  expect(store.getAll('contacts')).toEqual([]);
}

async function deleteMatching(
  store: Store,
  collection: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  const deleted: Record<string, unknown>[] = [];
  for (const record of store.getAll(collection)) {
    if (!predicate(record)) continue;
    const removed = await store.delete(collection, String(record.id));
    if (removed) deleted.push(removed);
  }
  return deleted;
}

function baseConfig() {
  return {
    driver: 'postgres' as const,
    databaseUrl: 'postgres://example.test/openwork',
    migrationsDir: './drizzle',
    migrationsTable: '__drizzle_migrations',
    migrationsSchema: 'drizzle',
  };
}

function userRecord(id: string): StoreRecord {
  return {
    id,
    email: `${id}@example.test`,
    passwordHash: 'hash',
    firstName: 'Restart',
    lastName: 'User',
    type: 'human',
    isActive: true,
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
  };
}

function failingUsersClient(message: string) {
  return {
    async unsafe(query: string): Promise<StoreRecord[]> {
      if (query.includes('information_schema.tables')) {
        return [{ table_name: 'users' }];
      }
      if (query.startsWith('select * from "users"')) {
        return [];
      }
      if (query.startsWith('insert into "users"')) {
        throw new Error(message);
      }
      return [];
    },
    async begin<T>(operation: (client: { unsafe: (query: string) => Promise<StoreRecord[]> }) => Promise<T>) {
      return operation(this);
    },
  };
}

async function withTemporaryPostgresDatabase(
  baseDatabaseUrl: string,
  run: (databaseUrl: string) => Promise<void>,
): Promise<void> {
  const tmpDatabase = `openwork_store_contract_${process.pid}_${Date.now()}`;
  const adminUrl = databaseUrlForDatabase(baseDatabaseUrl, 'postgres');
  const tmpDatabaseUrl = databaseUrlForDatabase(baseDatabaseUrl, tmpDatabase);
  const admin = postgres(adminUrl, { max: 1, prepare: false });

  try {
    await admin.unsafe(`create database "${tmpDatabase}"`);
    await migratePostgresDatabase(tmpDatabaseUrl);
    await run(tmpDatabaseUrl);
  } finally {
    await admin.unsafe(`drop database if exists "${tmpDatabase}" with (force)`);
    await admin.end();
  }
}

async function migratePostgresDatabase(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const migrationPath = path.resolve(testDir, '../../drizzle/0000_graceful_wiccan.sql');
  const migration = fs.readFileSync(migrationPath, 'utf-8');

  try {
    for (const statement of migration
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.end();
  }
}

function databaseUrlForDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
