import { databaseConfig } from '../config/database.js';
import type { DatabaseConfig } from '../config/database.js';
import { SqlStoreAdapter } from './sql-store-adapter.js';

export function createStore(config: DatabaseConfig = databaseConfig): SqlStoreAdapter {
  console.info('[db] Store: PostgreSQL (sql-store-adapter)');
  return new SqlStoreAdapter(config);
}

export const store = createStore();
