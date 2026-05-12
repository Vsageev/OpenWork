import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DatabaseConfig } from '../config/database.js';

export async function runPostgresMigrations(config: DatabaseConfig): Promise<void> {
  const migrationClient = postgres(config.databaseUrl, { max: 1, prepare: false });
  try {
    const db = drizzle(migrationClient);
    await migrate(db, {
      migrationsFolder: config.migrationsDir,
      migrationsTable: config.migrationsTable,
      migrationsSchema: config.migrationsSchema,
    });
  } finally {
    await migrationClient.end({ timeout: 10 });
  }
}
