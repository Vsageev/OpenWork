# Development Guide

General dev setup, commands, and troubleshooting. For module-specific guidance, see:

- [Runbook](./RUNBOOK.md) — stale process cleanup, common issues, quick fixes
- [Backend Development](./backend-development.md) — routes, services, error handling, implementation patterns
- [Design System](./design-system.md) — colors, typography, components, animation rules

## Quick Start

```bash
pnpm install   # install dependencies
pnpm dev       # run backend, frontend, landing, and widget
pnpm typecheck # run type checking
pnpm lint      # run linter
```

`pnpm dev` runs `pnpm --filter backend db:migrate` before starting the dev stack. Set `OPENWORK_DEV_SKIP_MIGRATE=true` to skip that step. Agent execution requires a separately paired runner; if no eligible runner is connected, agent run creation fails with a clear runner-unavailable error instead of spawning a backend-local CLI.

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

With `DATABASE_URL` set, `db:bootstrap` applies Drizzle migrations to the target database, then seeds default users, settings, collection, and workspace. You can still run `db:migrate` separately in CI or when you only need the schema.

```bash
DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork \
  pnpm --filter backend db:bootstrap
```

`DATA_DIR` remains used for uploads, agent files, and other non-relational paths; collection data is in Postgres.

### Agent execution and concurrency

For schema migrations or restores while the API is running, stop extra backend replicas first and let in-flight agent work finish (or cancel batch runs through the API) so queue rows are not mid-transition. Chat queue and batch drains take per-conversation or per-batch-run row locks in Postgres so two processes cannot claim the same queued item; overlapping work on the same scope still serializes on the database.

Agent execution requires an outbound user runner. Local development does not start a runner automatically; pair and run one separately when normal chat/card/cron agent runs should execute.

```bash
# User machine, after creating a pairing code in Settings -> Runners
OPENWORK_SERVER_URL=https://your-openwork-host.example \
OPENWORK_RUNNER_PAIRING_CODE=<one-time-code> \
OPENWORK_RUNNER_WORKSPACE_ROOT=/path/to/workspace \
pnpm --filter openwork-runner dev
```

Legacy `AGENT_EXECUTOR_MODE=local` and `AGENT_EXECUTOR_MODE=hybrid` are unsupported in normal runtime. The hosted backend does not spawn agent CLIs locally; if no eligible runner is connected, new run creation reports the runner-unavailable state. The runner pairs once with `/api/agent-runners/pair`, stores its scoped credential in `~/.openwork-runner/config.json`, connects to `/api/runners/ws`, executes concurrent jobs, and streams stdout/stderr back into normal `agent_runs` history. Existing run history remains readable, including older `executor=local` records. Set `MAX_CONCURRENT_AGENTS` to a positive number to add an app-level cap; the default `0` means no app-level limit.

Existing databases must apply migrations after pulling this branch:

```bash
pnpm --filter backend db:migrate
```

The migration adds `agent_runs.executor`, which preserves old local-run history and is required for remote-run cancellation and startup recovery.

### Admin HTTP backups (`/api/backups`)

| Action              | Behavior                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/backups` | Requires a successful `postgres.dump` (pg_dump custom format). The request fails with an explicit error if `pg_dump` is missing, not on `PATH`, or cannot reach `DATABASE_URL`. Also writes per-collection JSON mirrors and a small manifest.                                 |
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
