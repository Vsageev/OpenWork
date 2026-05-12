import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { databaseConfig } from '../config/database.js';
import * as schema from './schema.js';

export type PostgresClient = Sql;
export type PostgresDatabase = PostgresJsDatabase<typeof schema>;

export function createPostgresClient(databaseUrl = databaseConfig.databaseUrl): PostgresClient {
  return postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });
}

export function createPostgresDb(
  client: PostgresClient = createPostgresClient(),
): PostgresDatabase {
  return drizzle(client, { schema });
}
