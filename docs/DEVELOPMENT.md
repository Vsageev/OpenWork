# Development Guide

General dev setup, commands, and troubleshooting. For module-specific guidance, see:

- [Runbook](./RUNBOOK.md) — stale process cleanup, common issues, quick fixes
- [Backend Development](./backend-development.md) — routes, services, error handling, implementation patterns
- [Design System](./design-system.md) — colors, typography, components, animation rules

## Quick Start

```bash
pnpm install   # install dependencies
pnpm dev       # run in development mode
pnpm typecheck # run type checking
pnpm lint      # run linter
```

## Shared Utilities

Import utilities from the `shared` package instead of reimplementing:

```typescript
import { formatBytes, formatDate, createListResponse } from 'shared';

formatBytes(1536000); // "1.5 MB"
formatDate(new Date().toISOString()); // formatted date
createListResponse(items, total, limit, offset); // consistent API response
```

## Code Style

- TypeScript for all new code
- camelCase for variables, PascalCase for types
- Keep functions small and focused
- Comments only for complex logic (why, not what)
- Prefer extending shared utilities before adding local helpers

## Troubleshooting

```bash
pnpm clean && pnpm install && pnpm build  # clean rebuild
pnpm typecheck                             # check types without emitting
pnpm lint:fix                              # auto-fix lint errors
```

## Local Postgres (required)

Relational data lives in PostgreSQL only. Set `DATABASE_URL` in `packages/backend/.env` (see `packages/backend/.env.example`).

Example local database:

```bash
docker run --name openwork-postgres \
  -e POSTGRES_USER=openwork \
  -e POSTGRES_PASSWORD=openwork \
  -e POSTGRES_DB=openwork \
  -p 5432:5432 \
  -d postgres:16
```

Typical `packages/backend/.env` entries:

```bash
DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork
DB_MIGRATIONS_DIR=./drizzle
DB_MIGRATIONS_TABLE=__drizzle_migrations
DB_MIGRATIONS_SCHEMA=drizzle
```

Drizzle commands run from the repo root through the backend workspace:

```bash
pnpm --filter backend db:generate
pnpm --filter backend db:migrate
pnpm --filter backend db:studio
```

### Fresh SQL database (bootstrap)

With `DATABASE_URL` set, `db:bootstrap` applies Drizzle migrations to the target database, then seeds default users, settings, collection, board, and workspace. You can still run `db:migrate` separately in CI or when you only need the schema.

```bash
DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork \
  pnpm --filter backend db:bootstrap
```

`DATA_DIR` remains used for uploads, agent files, and other non-relational paths; collection data is in Postgres.

### Agent execution and concurrency

For schema migrations or restores while the API is running, stop extra backend replicas first and let in-flight agent work finish (or cancel batch runs through the API) so queue rows are not mid-transition. Chat queue and batch drains take per-conversation or per-batch-run row locks in Postgres so two processes cannot claim the same queued item; overlapping work on the same scope still serializes on the database.

### Admin HTTP backups (`/api/backups`)

| Action              | Behavior                                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/backups` | Requires a successful `postgres.dump` (pg_dump custom format). The request fails with an explicit error if `pg_dump` is missing, not on `PATH`, or cannot reach `DATABASE_URL`. Also writes per-collection JSON mirrors and a small manifest. |
| `POST .../restore`  | Requires `postgres.dump` in that backup: snapshots the live DB (same pg_dump requirement), runs `pg_restore --clean --if-exists`, then reloads the store. JSON-only directories from `POST /api/backups/import` are retained as archived data and are not applied by restore. |

`GET .../download` returns only collection JSON (manifest and `postgres.dump` are omitted from the bundle).

## Store Contract Tests

Run the store contract against SQL with a throwaway Postgres database:

```bash
STORE_CONTRACT_DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork pnpm test:store-contract
```

The SQL command connects to the configured server, creates a temporary database,
applies the current Drizzle SQL migration, runs the contract, and drops the
database. SQL preserves the same records after `reload()`, but mapped table row
order is not treated as stable after updates unless callers add an explicit
domain sort.
