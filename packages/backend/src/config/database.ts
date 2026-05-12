import path from 'node:path';
import { env } from './env.js';

export interface DatabaseConfig {
  driver: 'postgres';
  databaseUrl: string;
  migrationsDir: string;
  migrationsTable: string;
  migrationsSchema: string;
}

export function getDatabaseConfig(): DatabaseConfig {
  return {
    driver: 'postgres',
    databaseUrl: env.DATABASE_URL,
    migrationsDir: path.resolve(env.DB_MIGRATIONS_DIR),
    migrationsTable: env.DB_MIGRATIONS_TABLE,
    migrationsSchema: env.DB_MIGRATIONS_SCHEMA,
  };
}

export const databaseConfig = getDatabaseConfig();
