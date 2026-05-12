# Platform Operations

Administrative and operational endpoints for monitoring and maintenance.

## Health and diagnostics

- `GET /health`
- `GET /api/audit-logs`

## Backup lifecycle

Runtime persistence is PostgreSQL (`DATABASE_URL`). See `docs/DEVELOPMENT.md` — Admin HTTP backups:

- `POST /api/backups` — `pg_dump` custom file when client tools are available, plus JSON collection mirrors and manifest.
- `GET /api/backups`
- `POST /api/backups/import` — writes a JSON-only backup tree for archival inspection; take a new `POST /api/backups` snapshot for restore-capable `postgres.dump`.
- `GET /api/backups/:name/download` — JSON bundle of collections only.
- `POST /api/backups/:name/restore` — `pg_restore` from `postgres.dump` in that backup (requires that file).
- `DELETE /api/backups/prune`
- `DELETE /api/backups/:name`

## Settings

- `GET /api/settings/rate-limits`
- `PATCH /api/settings/rate-limits`
- `GET /api/settings/agent-defaults`
- `PATCH /api/settings/agent-defaults`
- `GET /api/settings/fallback-model`
- `PATCH /api/settings/fallback-model`

## Skills, connectors, and operational controls

- `GET /api/skills`, `POST /api/skills`, `GET /api/skills/:id`,
  `PATCH /api/skills/:id`, `DELETE /api/skills/:id`
- `GET /api/skills/:id/files`
- `GET /api/skills/:id/files/content`
- `PUT /api/skills/:id/files/content`
- `DELETE /api/skills/:id/files`
- `GET /api/skills/:id/files/download`
- `POST /api/skills/:id/files/upload`
- `POST /api/skills/:id/files/folders`
- `POST /api/skills/:id/files/reveal`

## Where to verify exact schemas

- `packages/backend/src/routes/backup.ts`
- `packages/backend/src/routes/settings.ts`
- `packages/backend/src/routes/health.ts`
- `packages/backend/src/routes/audit-logs.ts`
- `packages/backend/src/routes/skills.ts`
