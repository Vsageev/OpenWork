import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL || undefined;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for Drizzle commands.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: process.env.DB_MIGRATIONS_DIR ?? './drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
  migrations: {
    table: process.env.DB_MIGRATIONS_TABLE ?? '__drizzle_migrations',
    schema: process.env.DB_MIGRATIONS_SCHEMA ?? 'drizzle',
  },
  strict: true,
  verbose: true,
});
