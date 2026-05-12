# Backend JSON Store Migration Inventory

Created for card `820da791-d0df-4411-88d6-5405b3afba76`.

This is a historical read-only inventory for the completed migration from `packages/backend/data/*.json` away from the former JSON runtime store. It does not describe current runtime persistence behavior.

## Source Of Truth Checked

- Historical runtime store: `packages/backend/src/db/json-store.ts` (removed after SQL became required)
- Runtime store singleton: `packages/backend/src/db/connection.ts`
- Type interfaces: `packages/backend/src/db/types.ts` plus service-local interfaces
- Backup validation schemas: `packages/backend/src/schemas/collections.ts`
- Data files: `packages/backend/data/*.json`
- Runtime usage search: `rg -n "\bstore\.\w+\s*\(" packages/backend/src -g '*.ts' -g '*.tsx'`

## Store Semantics To Preserve

The former JSON store loaded every top-level JSON file under `env.DATA_DIR`, using the filename without `.json` as the collection name. Mutating calls created a collection in memory if it did not already exist, then persisted it to `<collection>.json` on the next flush.

Important migration behaviors:

- `insert` always adds `id`, `createdAt`, and `updatedAt` defaults.
- `update` merges partial data, prevents `id` override, and overwrites `updatedAt`.
- `deleteWhere`, `find`, `findOne`, and `count` accept arbitrary JavaScript predicates. These are the highest-risk calls to port.
- Unknown collections can exist at runtime. `contacts` and `webhooks` are referenced by code but no top-level JSON file currently exists.
- Backup validation currently maps many legacy snake_case names, while runtime files are mostly camelCase. Example: schema key `board_cards` does not validate runtime file `boardCards.json`.

## Collection Inventory

Actual files under `packages/backend/data/*.json`:

| Collection | Records | Current schema/interface mapping | Main dependencies |
|---|---:|---|---|
| `agentAvatarPresets` | 1 | `AgentAvatarPresetRecord` in `services/agents.ts`; partial `AgentAvatarPreset` in `db/types.ts`; no Zod schema | Agent UI presets |
| `agentBatchRunItems` | 79 | `AgentBatch*` interfaces in `services/agent-batch-queue.ts`; no persisted item Zod schema | `agentBatchRuns`, `agent_runs`, `agents`, `cards`, `collections` |
| `agentBatchRuns` | 3 | `AgentBatch*` interfaces in `services/agent-batch-queue.ts`; no persisted run Zod schema | `agents`, `boards` or `collections` via source fields |
| `agentChatQueue` | 30 | queue interfaces in `services/agent-chat.ts`; no Zod schema | `agents`, `conversations`, `messages`, `agent_runs` |
| `agentColorPresets` | 0 | `AgentColorPresetRecord` in `services/agents.ts`; no Zod schema | Agent UI presets |
| `agentEnvVars` | 2 | `AgentEnvVarRecord` in `services/agent-env-vars.ts`; no Zod schema | `agents`, `users`; encrypted secret value |
| `agentExternalApiKeys` | 0 | no current runtime `store.*` references found | Ambiguous / legacy |
| `agentGroups` | 4 | `AgentGroupRecord` in `services/agents.ts`; no Zod schema | `agents.groupId` |
| `agent_runs` | 1278 | `AgentRun` in `db/types.ts`; `agentRunSchema` in `schemas/collections.ts` | `agents`, `conversations`, `cards`, messages/comments through run output |
| `agents` | 30 | `AgentRecord` in `services/agents.ts`; no Zod schema | `users`, `apiKeys`, `skills`, `agentGroups`, `agentEnvVars`, workspaces on disk |
| `apiKeys` | 31 | `ApiKey` in `db/types.ts`; `apiKeySchema` exists but backup schema key is `api_keys`, not `apiKeys` | `users`, `agents`, settings |
| `auditLogs` | 612 | `AuditLog` in `db/types.ts`; `auditLogSchema` exists but key is `audit_logs`, not `auditLogs` | `users`; generic entity refs |
| `boardCards` | 150 | `BoardCard` in `db/types.ts`; `boardCardSchema` exists but key is `board_cards`, not `boardCards` | `boards`, `boardColumns`, `cards` |
| `boardColumns` | 32 | `BoardColumn` in `db/types.ts`; `boardColumnSchema` exists but key is `board_columns`, not `boardColumns` | `boards`, optional auto-assigned `agents` |
| `boardCronTemplates` | 0 | `BoardCronTemplate` in `services/board-cron.ts`; no Zod schema | `boards`, `boardColumns`, `cards`, `tags`, `agents` |
| `boards` | 9 | `Board` in `db/types.ts`; `boardSchema` | `collections`, `cards` through `boardCards`, `users` |
| `cardComments` | 145 | `CardComment` in `db/types.ts`; `cardCommentSchema` exists but key is `card_comments`, not `cardComments` | `cards`, `users` or `agents`, `agent_runs` |
| `cardLinks` | 16 | `CardLink` in `db/types.ts`; `cardLinkSchema` exists but key is `card_links`, not `cardLinks` | `cards` source/target |
| `cardTags` | 0 | `CardTag` in `db/types.ts`; `cardTagSchema` exists but key is `card_tags`, not `cardTags`; schema lacks `id` even though store can add one | `cards`, `tags` |
| `cards` | 165 | `Card` in `db/types.ts`; `cardSchema`; `cardCustomFieldsSchema` | `collections`, `users` or `agents`, `boards`, tags/comments/links |
| `collections` | 1 | `Collection` in `db/types.ts`; `collectionSchema` | `cards`, `boards`, `workspaces`, agent batch config |
| `connectors` | 0 | `Connector` in `db/types.ts`; `connectorSchema` | Telegram integration records |
| `conversations` | 670 | `Conversation` in `db/types.ts`; `conversationSchema` | `messages`, `messageDrafts`, `users`, `agents`, Telegram/contact flow |
| `messageDrafts` | 0 | `MessageDraft` in `db/types.ts`; `messageDraftSchema` exists but key is `message_drafts`, not `messageDrafts` | `conversations` |
| `messages` | 3790 | `Message` in `db/types.ts`; `messageSchema` | `conversations`, `users`, agent chat tree fields |
| `migrations` | 1 | no current TypeScript interface or Zod schema found | Ambiguous migration bookkeeping |
| `refreshTokens` | 208 | `RefreshToken` in `db/types.ts`; `refreshTokenSchema` exists but key is `refresh_tokens`, not `refreshTokens` | `users` |
| `settings` | 2 | `ProjectSettings` in `services/project-settings.ts`; route-local `RateLimitSettings`; no Zod schema | `apiKeys`; global project/rate-limit settings |
| `skills` | 11 | `SkillRecord` in `services/skills.ts`; no Zod schema | `agents.skillIds`; skill files on disk |
| `tags` | 0 | `Tag` in `db/types.ts`; `tagSchema` | `cardTags`, board cron templates |
| `telegramBots` | 0 | `TelegramBot` in `db/types.ts`; `telegramBotSchema` exists but key is `telegram_bots`, not `telegramBots` | Telegram webhook/outbound/media/connectors |
| `users` | 106 | `User` in `db/types.ts`; `userSchema` | auth, agents service users, audit, API keys |
| `webhookDeliveries` | 0 | `WebhookDelivery` in `db/types.ts`; `webhookDeliverySchema` exists but key is `webhook_deliveries`, not `webhookDeliveries` | `webhooks` |
| `workspaces` | 1 | `Workspace` in `db/types.ts`; no Zod schema | `users`, `boards`, `collections`, `agentGroups` |

Referenced collections without current top-level data files:

| Collection | Store usage | Risk |
|---|---:|---|
| `contacts` | 6 | `telegram-webhook.ts` can create/update/read this collection; migration needs a table or explicit deletion of dead flow. No `contacts.json` exists now. |
| `webhooks` | 7 | `webhooks.ts` can create/read/update/delete, and delivery lookup reads it. No `webhooks.json` exists now, but writes would create it. |

## Runtime Store Usage Summary

At the time of this inventory, `rg` found 489 `store.*(...)` calls under `packages/backend/src`; 484 were JSON-store runtime lifecycle calls and 5 were unrelated in-memory `Map` calls in `packages/backend/src/lib/cache.ts`.

Method counts including the cache `Map` calls:

| Method | Count |
|---|---:|
| `getById` | 170 |
| `update` | 105 |
| `find` | 55 |
| `insert` | 48 |
| `delete` | 30 |
| `deleteWhere` | 23 |
| `findOne` | 23 |
| `getAll` | 23 |
| `count` | 2 |
| `flush` | 2 |
| `init` | 2 |
| `insertMany` | 1 |
| `reload` | 1 |
| cache-only `get`/`set`/`keys`/`clear` | 4 |

Collection call counts after resolving local collection constants:

| Collection | Store calls | Methods |
|---|---:|---|
| `conversations` | 47 | get/update/find/insert/delete/findOne |
| `users` | 37 | get/update/findOne/insert/delete/getAll |
| `messages` | 28 | get/update/find/insert/deleteWhere/getAll |
| `agentChatQueue` | 30 | get/update/find/findOne/count/deleteWhere/insert/delete |
| `agents` | 25 | get/update/find/insert/delete/getAll |
| `agent_runs` | 23 | get/update/find/count/insert/delete |
| `boardCards` | 17 | find/deleteWhere/findOne/insert/update |
| `cards` | 18 | get/getAll/find/insert/update/delete |
| `collections` | 16 | get/getAll/insert/update/delete/findOne |
| `boards` | 17 | get/getAll/find/insert/update/delete |
| `telegramBots` | 16 | get/getAll/find/findOne/insert/update/delete |
| `agentBatchRuns` | 18 | get/update/find/insert/delete |
| `agentBatchRunItems` | 17 | get/update/find/deleteWhere/insertMany |
| `apiKeys` | 13 | get/insert/find/findOne/update/delete |
| `boardColumns` | 10 | get/insert/find/deleteWhere/update/delete |
| `boardCronTemplates` | 10 | get/getAll/find/insert/update/delete |
| `settings` | 12 | get/insert/update |
| `skills` | 10 | get/getAll/insert/update/delete |
| `tags` | 9 | get/getAll/findOne/insert/update/delete |
| `agentEnvVars` | 10 | get/find/insert/update/delete/deleteWhere |
| `workspaces` | 9 | get/getAll/find/findOne/insert/update/delete |
| `connectors` | 10 | get/getAll/insert/update/delete |
| `cardTags` | 10 | getAll/find/findOne/insert/deleteWhere |
| `cardComments` | 8 | find/insert/update/delete/deleteWhere |
| `cardLinks` | 6 | find/findOne/insert/delete/deleteWhere |
| `refreshTokens` | 4 | insert/findOne/deleteWhere |
| `webhookDeliveries` | 8 | get/insert/update/find |
| `webhooks` | 7 | get/find/insert/update/delete |
| `contacts` | 6 | get/update/findOne/insert |
| `agentGroups` | 6 | get/getAll/find/insert/update/delete |
| `agentAvatarPresets` | 3 | insert/update/delete |
| `agentColorPresets` | 3 | insert/update/delete |
| `auditLogs` | 2 | insert/find |

Lifecycle calls:

- `store.init`: `packages/backend/src/app.ts:100`, `packages/backend/src/db/bootstrap.ts:183`
- `store.flush`: `packages/backend/src/services/backup.ts:112`, `packages/backend/src/db/bootstrap.ts:203`
- `store.reload`: `packages/backend/src/services/backup.ts:249`

## Arbitrary Predicate Usage

There are 103 predicate-based runtime calls to port:

- `find`: 55
- `findOne`: 23
- `deleteWhere`: 23
- `count`: 2

High-risk predicate groups:

| Flow | Collections | Call sites |
|---|---|---|
| Agent chat run/queue/message tree | `agent_runs`, `agentChatQueue`, `conversations`, `messages`, `cardComments` | `agent-chat.ts:207`, `460`, `520`, `572`, `711`, `715`, `745`, `1148`, `2127`, `2141`, `2310`, `3180`, `3661`, `3679`, `3699`, `3729` |
| Agent batch queue | `agentBatchRuns`, `agentBatchRunItems` | `agent-batch-queue.ts:836`, `842`, `855`, `864`, `877`, `918`, `1045` |
| Boards/cards/cards-on-boards | `boards`, `boardCards`, `boardColumns`, `cards`, `cardTags`, `cardLinks`, `cardComments` | `boards.ts:200`, `210`, `235`, `372`, `373`, `419`, `447`, `453`, `470`, `477`, `495`, `500`; `cards.ts:62`, `95`, `102`, `128`, `152`, `153`, `173`, `198`, `302`, `304`, `306`, `308`, `327`, `333`, `339`, `358`; `board-batch.ts:38`, `85`, `102` |
| Conversations/messages/drafts | `conversations`, `messages`, `messageDrafts` | `conversations.ts:63`, `86`, `242`, `260`, `261`; `messages.ts:31`; `message-drafts.ts:38`, `62`, `96` |
| Auth/users/tokens/API keys | `users`, `refreshTokens`, `apiKeys` | `auth.ts:56`, `62`, `73`; `routes/auth.ts:71`, `111`; `api-keys.ts:93`, `169` |
| Agents and agent settings | `agents`, `refreshTokens`, `conversations`, `agentEnvVars` | `agents.ts:401`, `1096`, `1100`, `1238`; `agent-env-vars.ts:105`, `256`, `262` |
| Telegram/media/contact flow | `telegramBots`, `contacts`, `conversations` | `telegram.ts:99`, `233`, `356`; `telegram-outbound.ts:80`; `telegram-webhook.ts:372`, `403`, `569`; `routes/media.ts:110` |
| Collections merge/delete flow | `cards`, `boards`, `workspaces` | `collections.ts:142`, `152`, `178` |
| Audit/webhooks | `auditLogs`, `webhooks`, `webhookDeliveries` | `audit-log.ts:57`; `webhooks.ts:39`, `57`; `webhook-delivery.ts:280` |
| Bootstrap | dynamic collection lookup, `collections`, `workspaces` | `bootstrap.ts:12`, `114`, `169` |
| Tags | `tags`, `cardTags` | `routes/tags.ts:70`, `95`, `131` |

The highest migration risk is not `getById`; it is translating these predicates into indexed SQL queries and preserving sort/filter semantics after filtering.

## Required Flow Separation

Agent chat flow:

- Primary files: `services/agent-chat.ts`, `services/agent-runs.ts`, `services/agent-workspaces.ts`, `services/messages.ts`, `services/conversations.ts`
- Collections: `agents`, `agent_runs`, `agentChatQueue`, `conversations`, `messages`, `cardComments`, `apiKeys`, `settings`
- Special risk: message tree fields (`parentId`, `previousUserMessageId`), background trigger metadata, queue item dependency fields, live PID checks, response/comment deduplication.

Queue flow:

- Chat queue: `agentChatQueue` in `services/agent-chat.ts`
- Batch queue: `agentBatchRuns`, `agentBatchRunItems` in `services/agent-batch-queue.ts`
- Special risk: status predicates, stale cleanup, retry scheduling, dependency arrays, timers held in memory.

Board flow:

- Primary files: `services/boards.ts`, `services/board-batch.ts`, `services/board-cron.ts`
- Collections: `boards`, `boardColumns`, `boardCards`, `cards`, `tags`, `cardTags`, `boardCronTemplates`, `agents`
- Special risk: ordering by `position`, cascade deletes, auto-assignment from columns.

Card flow:

- Primary files: `services/cards.ts`, `routes/cards.ts`, `services/collections.ts`
- Collections: `cards`, `cardTags`, `cardLinks`, `cardComments`, `boardCards`, `collections`
- Special risk: cross-collection delete cleanup, bidirectional card links, `customFields` validation.

Message flow:

- Primary files: `services/messages.ts`, `services/message-drafts.ts`, `services/conversations.ts`, `services/telegram-outbound.ts`, `services/telegram-webhook.ts`
- Collections: `conversations`, `messages`, `messageDrafts`, `telegramBots`, `contacts`
- Special risk: `contacts` is referenced but has no current top-level JSON file; agent-chat messages add fields beyond `Message`.

Backup flow:

- Primary file: `services/backup.ts`
- Collections: all JSON files present in `DATA_DIR`
- Special risk: current Zod validation skips most camelCase runtime files because `collectionSchemas` uses snake_case keys for many collections.

Bootstrap flow:

- Primary file: `db/bootstrap.ts`
- Collections: `users`, `settings`, `collections`, `boards`, `boardColumns`, `workspaces`
- Special risk: dynamic `findByField(store, collection, field, value)` at `bootstrap.ts:12`; migration should constrain this to known bootstrap lookups.

## Ambiguous Or Under-Specified Fields

Do not guess these during migration; resolve before schema finalization:

- `agentBatchRunItems`: `dependsOnItemIds`, `blockingMode`, `stageId`, retry fields, `agentRunId`; no persisted item schema.
- `agentBatchRuns`: `skipped`, `stageCount`, `dependencyItemCount`, status counters; no persisted run schema.
- `agentChatQueue`: `mode`, `targetMessageId`, `lastRunId`, `continuationParentId`, `dependsOnQueueItemId`, `previousUserMessageId`, `queuedMessageId`, `responseMessageId`, `usedFallback`, `fallbackModel`; no persisted schema.
- `agent_runs`: observed fields include `avatarIcon`, `avatarBgColor`, `avatarLogoColor`, `stdout`, `stderr`, `killedByUser`, `triggerPrompt`, `responseParentId`; `agentRunSchema` does not cover all of them.
- `agents`: observed fields include `workspaceApiKey`, `workspaceApiKeyId`, `serviceUserId`, `presetParameters`, `repositoryRoot`, `workspacePath`, `separateFolderPerChat`, `cronJobs`; no Zod schema.
- `boardColumns`: observed `assignAgentId`, `assignAgentPrompt`, `wipLimit`; schema omits some of these.
- `boards`: both `collectionId` and `defaultCollectionId` are used; current schema only requires `collectionId`.
- `cardComments`: observed `agentRunId`; schema does not include it.
- `conversations`: observed `provider` and `modelId`; `contactId` exists but `contacts` file is absent.
- `messages`: observed `parentId`, `previousUserMessageId`, `attachments` can be `null` or array.
- `settings`: same collection stores `project` and `rate-limits` records with different shapes.
- `migrations`: no current TypeScript interface/schema found.
- `agentExternalApiKeys`: no current runtime store references found.
- `contacts` and `webhooks`: runtime-referenced collections that are not present as current JSON files.

## Migration Order

1. Build schema/table definitions and migrations for every current JSON file plus runtime-created `contacts` and `webhooks`.
2. Fix or replace backup validation collection names so camelCase runtime collections are validated before any database import/restore path depends on them.
3. Migrate identity and auth foundations: `users`, `refreshTokens`, `apiKeys`, `settings`, `auditLogs`.
4. Migrate workspace/navigation foundations: `collections`, `workspaces`, `agentGroups`, `skills`.
5. Migrate agents and agent-owned records: `agents`, `agentEnvVars`, `agentAvatarPresets`, `agentColorPresets`, `agentExternalApiKeys`.
6. Migrate board/card graph: `boards`, `boardColumns`, `cards`, `boardCards`, `tags`, `cardTags`, `cardLinks`, `cardComments`, `boardCronTemplates`.
7. Migrate conversation/message graph: `contacts`, `conversations`, `messages`, `messageDrafts`, `telegramBots`, `connectors`.
8. Migrate runtime queues and run history last: `agent_runs`, `agentChatQueue`, `agentBatchRuns`, `agentBatchRunItems`, `webhooks`, `webhookDeliveries`, `migrations`.
9. Port predicate-heavy services one flow at a time and verify through API behavior: auth, cards/boards, conversations/messages, agent chat, batch queue, backup/restore.
10. Only after all reads/writes are dual-verified, switch runtime behavior to SQL only.

## Agent execution state (cutover and in-flight runs)

This step moves `agent_runs`, `agentChatQueue`, `agentBatchRuns`, and `agentBatchRunItems` after conversations and messages are already in SQL so chat history and card context resolve under foreign keys.

**Before cutover (strongly recommended)**

- Prefer a short maintenance window or at least pause new agent work: stop triggering new card assignments, cron runs, and batch jobs; let the chat queue drain or cancel items from the UI.
- Take a filesystem snapshot of `DATA_DIR` JSON (including `agent-runs/` log dirs referenced by `stdoutPath` / `stderrPath`) using `packages/backend/scripts/migration-snapshot-json.sh` or your own backup.

**Import order**

- The JSON→SQL importer already orders collections so `agents` and `agent_groups` precede `agent_runs`, `agentChatQueue`, and batch tables; queue rows keep the same string IDs as in JSON.

**Active runs during switch**

- Rows with `agent_runs.status === 'running'` are not orphans: on the next backend start, `reconcileRunsOnStartup` attaches to processes whose PIDs are still alive or finalizes dead PIDs from log files (`packages/backend/src/services/agent-runs.ts`).
- Queue rows in `processing` are normalized on startup by `initializeAgentChatQueue` / `initializeAgentBatchQueue` (retry, fail, or complete from linked `agent_runs`), with an optional `preserveActiveProcessing` path when the process is still live.
- Do not delete JSON snapshots until SQL import has been verified. Current runtime rollback uses Postgres restore/repointing; JSON snapshots can be re-imported into an empty database with `db:import-json`.

**Repository surface**

- Predicate-heavy access for runs and queues is centralized in `packages/backend/src/db/repositories/agent-execution-repository.ts` (pending/running lists, cancellation lookup by `runId`, retention pruning, batch item ordering) so call sites can later swap to indexed SQL without changing service behavior.

**Post-switch checks**

- Create a chat run against the configured `DATABASE_URL`, exercise queue enqueue → processing → completion, cancel a processing item if your API exposes it, and start a small batch run to confirm counters and item lifecycle.

## Verification Notes

Commands used:

```bash
find packages/backend/data -maxdepth 1 -type f -name '*.json' -print | sort
rg -n "\bstore\.\w+\s*\(" packages/backend/src -g '*.ts' -g '*.tsx'
rg -n "store\.(find|findOne|count|deleteWhere)\(" packages/backend/src -g '*.ts' -g '*.tsx'
```

Results:

- `packages/backend/data/*.json` contains 34 top-level JSON collections.
- `rg` found 489 `store.*(...)` calls under `packages/backend/src`.
- 484 calls were historical JSON-store/lifecycle calls.
- 5 calls are unrelated in-memory cache `Map` calls in `packages/backend/src/lib/cache.ts`.
- 103 predicate calls were classified above.
- Every current top-level JSON file is listed in the collection inventory table.
