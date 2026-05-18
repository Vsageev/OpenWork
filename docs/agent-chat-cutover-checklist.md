# Agent Chat Canonical Cutover Checklist

Use this checklist before and after deploying the canonical turn read model.

## Before Staging

- Confirm application code is deployed with dual-write turn creation for send,
  upload, edit, retry, stop, queue reorder, and queue deletion paths.
- Run `pnpm --filter backend chat-turns:migrate` against staging.
- Run `pnpm --filter backend chat-turns:migrate -- --validate-only` and require
  `invalid: 0`.
- Capture a Postgres backup and keep the pre-migration artifact until production
  validation is complete.

## Staging Validation

- Verify a migrated legacy conversation through
  `/api/agents/:id/chat/conversations/:conversationId/view`.
- Verify a fresh conversation through the same canonical view endpoint.
- Verify a queued multi-message conversation through the same canonical view
  endpoint, including queue position and active run metadata.
- Run focused lifecycle tests, frontend canonical rendering tests, typecheck,
  and lint.

## Production Cutover

- Stop extra backend replicas or pause rollout concurrency so queue processing
  is not mid-transition.
- Let in-flight agent work finish or stop affected runs intentionally.
- Capture a production Postgres backup.
- Run `pnpm --filter backend chat-turns:migrate`.
- Run `pnpm --filter backend chat-turns:migrate -- --validate-only` and require
  `invalid: 0`.
- Deploy the canonical-only frontend/backend read path.

## Rollback

- If validation fails before deploy, keep the old read path and repair the
  invalid rows listed by the migration report.
- If validation fails after deploy, roll back the application artifact first,
  then restore the pre-cutover database backup only if data repair cannot
  preserve newer writes.
- Do not delete historical compatibility columns until backups and validation
  logs prove no deployed runtime reads them for transcript rendering.

## Post-Cutover

- Re-check the three canonical view scenarios: migrated legacy, fresh, queued
  multi-message.
- Confirm no logs mention missing durable chat turns for active queue items.
- Confirm no frontend path renders chat from queue rows or raw message lists
  while `canonicalView` is absent.
- Keep the migration report and backup identifier with the release notes.
