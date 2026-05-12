# SQL cutover operator checklist

Repeatable runbook for switching a host from historical `JsonStore` (pre-SQL-default) to Postgres without losing a rollback path. **Current releases require `DATABASE_URL` and no longer run the JSON store at runtime**; keep this document for migration archaeology and operator drills. Keep JSON tarballs and `pg_dump` archives until SQL mode is verified in production.

**Related:** migration inventory `docs/backend-json-store-migration-inventory.md`, commands in `docs/DEVELOPMENT.md` (JSON→SQL import, backup semantics).

---

## 0. Environment changes at cutover (record per host)

| Variable | Before (JSON) | After (SQL) |
|----------|---------------|-------------|
| `DATABASE_URL` | optional / ignored | required Postgres URL |
| `DB_MIGRATIONS_DIR` | optional | `./drizzle` (or absolute path to Drizzle SQL) |
| `DB_MIGRATIONS_TABLE` | optional | `__drizzle_migrations` (match `packages/backend/.env.example`) |
| `DB_MIGRATIONS_SCHEMA` | optional | `drizzle` |
| `DATA_DIR` | unchanged | unchanged (uploads, agent workspaces on disk) |

Rollback now means restoring or repointing Postgres. The app no longer has a JSON runtime driver. Restore from a verified `pg_dump` / migration SQL archive, or re-import a pre-cutover JSON snapshot into an empty database with `db:import-json`, then point `DATABASE_URL` at that database.

---

## 1. Pre-cutover checks

- [ ] **Code health:** `pnpm typecheck` clean at repo root; `pnpm test` (and `pnpm test:store-contract:sql` when touching the store).
- [ ] **JSON snapshot:** `pnpm migration:snapshot-json` (from repo root) or `DATA_DIR=/path/to/runtime/data pnpm migration:snapshot-json`. Confirm `packages/backend/migration-artifacts/json-data-*.tar.gz` exists.
- [ ] **Empty Postgres schema:** `DATABASE_URL=... pnpm --filter backend db:migrate` on the **target** empty database.
- [ ] **Import dry-run + report:**  
  `DATABASE_URL=... pnpm db:import-json -- --dry-run --report-dir ./migration-artifacts`  
  Review `import-dry-run-*.json`: totals, per-collection skips, validation/constraint issues.
- [ ] **Commit import (staging first):** only if dry-run is acceptable and DB is empty (or deliberate `--allow-non-empty`):  
  `DATABASE_URL=... pnpm db:import-json -- --import --report-dir ./migration-artifacts`  
  **Importer exit code:** the script sets exit code `1` when `totals.skipped > 0` (for example constraint-skipped orphan `messages` rows). The JSON report still describes what landed; confirm row counts in Postgres before treating the import as failed.
- [ ] **Backend heap (dev only):** if the process OOMs during startup, raise Node’s heap (e.g. `NODE_OPTIONS=--max-old-space-size=8192`) while large non-store files under `DATA_DIR` are loaded alongside SQL.
- [ ] **Logical SQL backup after import:**  
  `DATABASE_URL=... pnpm migration:sql-dump` → `migration-artifacts/postgres-custom-*.dump`
- [ ] **Rehearse restore (rollback drill):** second empty DB + `TARGET_DATABASE_URL=... pnpm migration:sql-restore -- migration-artifacts/postgres-custom-<stamp>.dump`, then boot backend with `DATABASE_URL` pointed at the restored DB (see §4).
- [ ] **Queue / agent execution decision (document choice):**
  - **Quiet window (recommended):** pause new card assignments, cron, and batch triggers; let `agentChatQueue` drain or cancel from UI; avoid starting long runs during import.
  - **If you cannot pause:** accept that rows in `processing` / `running` are reconciled on next startup (`initializeAgentChatQueue`, `initializeAgentBatchQueue`, `reconcileRunsOnStartup`—see inventory §“Agent execution state”).
  - Record the chosen option and approximate queue depth (counts from JSON or DB) in the change ticket.

---

## 2. Canary checks in SQL mode

Run after the server points at the imported database. Use a real JWT or API key with the permissions in the table.

| Area | Check | Pass criteria |
|------|--------|----------------|
| Health | `GET /api/health` (or host’s liveness route) | 2xx, expected body |
| Auth | Login or `GET /api/users/me` with token | 200, user payload |
| Boards | `GET /api/boards/:id` | 200, columns + cards references |
| Cards | `GET /api/cards/:id`, `PATCH` a non-destructive field | read OK; PATCH persists |
| Comments | `GET` comments / `POST` comment on a test card | list + create OK |
| Conversations | `GET /api/conversations/:id` (known id) | 200 |
| Messages | list messages for a conversation | expected ordering/count |
| Agents | `GET /api/agents` or single agent | 200 |
| Queues | inspect chat queue / batch APIs if exposed; or enqueue one harmless operation | no 5xx; state consistent |
| Backups | `POST /api/backups` then inspect manifest / `postgres.dump` when tools available | behavior matches DEVELOPMENT matrix for postgres driver |
| Settings | `GET`/`PATCH` project or rate-limit settings (admin) | read/write OK |

---

## 3. Rollback trigger conditions

Initiate rollback (restore or repoint Postgres; JSON runtime rollback is no longer available) if any of the following occur **before** the migration is signed off:

- Critical 5xx on canary paths above, or incorrect data on read-after-write checks.
- Import report shows unexpected mass skips/constraint failures for business-critical collections.
- Postgres unavailable / persistent connection errors after verified good config.
- Backup (`pg_dump` or JSON snapshot) missing or corrupt when needed for recovery.

After rollback, do not delete snapshots until root cause is fixed and a full dry-run is repeated.

---

## 4. Self-rebuild safety (board read/write)

Before declaring migration complete on an environment:

1. Pick the **self-rebuild** board ID (the board that must keep working for operator workflows—e.g. the board hosting migration tasks).
2. `GET /api/boards/<boardId>` — 200, expected columns.
3. `PATCH /api/cards/<cardId>` on a card on that board (harmless field, e.g. append to description) **or** `POST` a short comment, then re-`GET` to confirm persistence.

**Acceptance verification board (local/staging):** `bffab293-f2ef-4302-864a-6d0b5c73d9d4` — must pass GET and a small PATCH or comment POST in SQL mode after import.

Example (replace `BASE` and `TOKEN`):

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/boards/bffab293-f2ef-4302-864a-6d0b5c73d9d4" | jq '.id, (.columns|length)'

curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"canary-sql-cutover-check"}' \
  "$BASE/api/cards/<card-id-on-that-board>"
```

---

## 5. Execution log template

| Step | Time (UTC) | Operator | Result / notes |
|------|------------|-----------|------------------|
| Snapshot | | | |
| Migrate | | | |
| Dry-run import | | | report file: |
| Commit import | | | report file: |
| pg_dump | | | dump file: |
| Restore rehearsal | | | DB URL: |
| Canary | | | |
| Board bffab293… | | | GET / PATCH |
| Sign-off | | | |

---

## 6. Quick command reference (repo root)

Use an absolute `--report-dir` when you are **not** `cd`’d into `packages/backend` (otherwise reports may nest under `packages/backend/packages/backend/...`).

```bash
pnpm typecheck && pnpm test
pnpm migration:snapshot-json
DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork pnpm --filter backend db:migrate
DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork pnpm db:import-json -- \
  --dry-run --report-dir "$(pwd)/packages/backend/migration-artifacts"
DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork pnpm db:import-json -- \
  --import --report-dir "$(pwd)/packages/backend/migration-artifacts"
DATABASE_URL=postgres://openwork:openwork@localhost:5432/openwork pnpm migration:sql-dump
```

Boot: set `packages/backend/.env` per §0, then `pnpm dev:backend` or production start command.
