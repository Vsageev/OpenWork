import { describe, expect, it } from 'vitest';
import { createStore } from './connection.js';
import { SqlStoreAdapter } from './sql-store-adapter.js';
import type { DatabaseConfig } from '../config/database.js';

describe('createStore', () => {
  it('selects the SQL store adapter for Postgres config without initializing the client', () => {
    const config: DatabaseConfig = {
      driver: 'postgres',
      databaseUrl: 'postgres://openwork:openwork@localhost:5432/openwork',
      migrationsDir: '/tmp/openwork-drizzle',
      migrationsTable: '__drizzle_migrations',
      migrationsSchema: 'drizzle',
    };

    expect(createStore(config)).toBeInstanceOf(SqlStoreAdapter);
  });
});
