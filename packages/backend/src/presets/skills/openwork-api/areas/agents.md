# Agents and AI Operations

Use this section for agent lifecycle, AI chat, and run monitoring.

## Agents

- `GET /api/agents/cli-status`
- `GET /api/agents/presets`
- `GET /api/agents`
- `POST /api/agents`
- `GET /api/agents/:id`
- `PATCH /api/agents/:id`
- `DELETE /api/agents/:id`
- `GET /api/agents/:id/files`
- `GET /api/agents/:id/files/content`
- `GET /api/agents/:id/files/download`
- `POST /api/agents/:id/files/reveal`
- `POST /api/agents/:id/files/upload`
- `POST /api/agents/:id/files/folders`
- `POST /api/agents/:id/files/references`
- `DELETE /api/agents/:id/files`

Agent presentation and grouping helpers:

- `GET /api/agent-avatar-presets` / `POST /api/agent-avatar-presets` / `PATCH .../:id` / `DELETE .../:id`
- `GET /api/agent-color-presets` / `POST /api/agent-color-presets` / `PATCH .../:id` / `DELETE .../:id`
- `GET /api/agent-groups` / `POST /api/agent-groups` / `PATCH /api/agent-groups/:id` / `DELETE /api/agent-groups/:id`

## Skills assignment

- `GET /api/agents/:id/skills`
- `POST /api/agents/:id/skills`
- `DELETE /api/agents/:id/skills/:skillId`
- `GET /api/skills` / `POST /api/skills`
- `GET /api/skills/:id` / `PATCH /api/skills/:id` / `DELETE /api/skills/:id`

## Agent chat

- `GET /api/agent-chat/recent`
- `GET /api/agents/:id/chat/conversations`
- `POST /api/agents/:id/chat/conversations`
- `PATCH /api/agents/:id/chat/conversations/:conversationId`
- `PATCH /api/agents/:id/chat/conversations/:conversationId/read`
- `DELETE /api/agents/:id/chat/conversations/:conversationId`
- `GET /api/agents/:id/chat/messages`
- `POST /api/agents/:id/chat/messages`
- `POST /api/agents/:id/chat/message`
- `GET /api/agents/:id/chat/conversations/:cid/queue`
- `DELETE /api/agents/:id/chat/conversations/:cid/queue`
- `PATCH /api/agents/:id/chat/queue/:itemId`
- `POST /api/agents/:id/chat/conversations/:cid/queue/reorder`
- `DELETE /api/agents/:id/chat/queue/:itemId`
- `POST /api/agents/:id/chat/respond`
- `POST /api/agents/:id/chat/upload`

## Agent execution runs

- `GET /api/agent-runs`
- `GET /api/agent-runs/active`
- `GET /api/agent-runs/:id`
- `DELETE /api/agent-runs`
- `POST /api/agent-runs/migrate-trigger-types`
- `DELETE /api/agent-runs/:id`
- Global batch runs:
  - `GET /api/agent-batch-runs`
  - `DELETE /api/agent-batch-runs`
  - `POST /api/agent-batch-runs/:runId/cancel`

## Previous run logs and history

When the task asks what happened in an earlier agent run, do not assume prior
logs are inaccessible just because they are not in the current prompt context.
Use this lookup path first:

1. Find the relevant run with `GET /api/agent-runs`, usually filtered by
   `agentId`, `conversationId`, `status`, or `triggerType`.
2. Fetch the full run record with `GET /api/agent-runs/:id`. This endpoint
   includes `stdout` and `stderr` logs, plus run metadata such as
   `conversationId`, `triggerPrompt`, and timestamps.
3. If you need to confirm how logs are persisted, inspect
   `packages/backend/src/routes/agent-runs.ts`,
   `packages/backend/src/services/agent-runs.ts`, and
   `packages/backend/src/services/agent-chat.ts`.

Implementation notes that matter:

- Route summary in `agent-runs.ts` explicitly says
  `GET /api/agent-runs/:id` "includes logs".
- `getAgentRun(...)` in `services/agent-runs.ts` prefers reading current
  `stdoutPath` and `stderrPath` files, then falls back to stored snapshots.
- Run log files are created under the backend data dir in
  `services/agent-chat.ts` with a per-run `stdout.log` and `stderr.log`.
- Conversation messages are separate from run logs. If you need chat history,
  use the agent chat routes in addition to run inspection.

## Recommended flow

1. Provision an agent (`POST /api/agents`) and attach skills (`POST /api/agents/:id/skills`).
2. Open a chat conversation and append messages (`POST /api/agents/:id/chat/conversations`, `POST /api/agents/:id/chat/message`).
3. For mass actions use board/collection batch job endpoints where relevant.
4. Monitor status via `/api/agent-runs` or `/api/agent-batch-runs`.

## Where to verify exact schemas

- `packages/backend/src/routes/agents.ts`
- `packages/backend/src/routes/agent-chat.ts`
- `packages/backend/src/routes/agent-runs.ts`
- `packages/backend/src/routes/skills.ts`
- `packages/backend/src/services/agents.ts`
- `packages/backend/src/services/agent-chat.ts`
