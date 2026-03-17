# Platform Operations

Administrative and operational endpoints for monitoring and maintenance.

## Health and diagnostics

- `GET /health`
- `GET /api/audit-logs`

## Backup lifecycle

- `POST /api/backups`
- `GET /api/backups`
- `POST /api/backups/import`
- `GET /api/backups/:name/download`
- `POST /api/backups/:name/restore`
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
