# ADR: Agent Chat Turns

Status: proposed

## Context

Agent chat currently reconstructs one user-visible turn from several independent
records:

- `messages.parent_id` forms reply trees and legacy linear conversations.
- `messages.previous_user_message_id` forms user-message lineage across branches.
- `conversations.metadata.activeBranches` stores selected user/reply branch ids.
- `agent_chat_queue` stores queued/running/terminal execution items with
  `queued_message_id`, `target_message_id`, `previous_user_message_id`,
  `continuation_parent_id`, `run_id`, and `response_message_id`.
- `agent_runs` stores execution status and logs, but chat runs only point back
  to the conversation and `response_parent_id`.
- The frontend builds missing turn state from optimistic messages, queue rows,
  running runs, branch metadata, and message ids.

That makes stop, follow-up, edit, retry, upload, and branch rendering fragile
because there is no authoritative identifier for "this user request and its
agent response lifecycle."

## Decision

Introduce server-owned chat turns. A turn is the durable identity for one
user-authored step in an agent conversation. Messages, queue items, execution
attempts, and runs attach to the turn instead of asking clients to infer the
turn from message ids.

Turns are user-step records, not assistant-message records. A turn may have no
agent response yet, one current response attempt, or multiple response attempts
created by retry/fallback/recovery. Editing a user message creates a new sibling
turn; retrying a failed or stopped run creates a new attempt on the same turn.

## Target Schema

Add these tables and then add nullable foreign keys from the existing tables for
dual-read and dual-write rollout.

```sql
create table agent_chat_turns (
  id text primary key,
  agent_id text not null references agents(id),
  conversation_id text not null references conversations(id),
  parent_turn_id text references agent_chat_turns(id),
  user_message_id text references messages(id),
  client_message_id text,
  supersedes_turn_id text references agent_chat_turns(id),
  superseded_by_turn_id text references agent_chat_turns(id),
  state text not null,
  input_type text not null,
  input_content text,
  input_attachments jsonb,
  selected_attempt_id text,
  created_at timestamptz not null,
  updated_at timestamptz,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  superseded_at timestamptz
);

create table agent_chat_turn_attempts (
  id text primary key,
  turn_id text not null references agent_chat_turns(id),
  attempt_no integer not null,
  state text not null,
  queue_item_id text references agent_chat_queue(id),
  run_id text references agent_runs(id),
  response_message_id text references messages(id),
  response_parent_message_id text references messages(id),
  error_message text,
  cancelled_by_user boolean not null default false,
  used_fallback boolean not null default false,
  fallback_model text,
  created_at timestamptz not null,
  updated_at timestamptz,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
);

create table agent_chat_branch_selections (
  id text primary key,
  conversation_id text not null references conversations(id),
  parent_turn_id text references agent_chat_turns(id),
  selected_turn_id text not null references agent_chat_turns(id),
  selected_attempt_id text references agent_chat_turn_attempts(id),
  updated_at timestamptz
);
```

Add compatibility columns:

- `messages.chat_turn_id`, `messages.chat_turn_attempt_id`
- `agent_chat_queue.chat_turn_id`, `agent_chat_queue.chat_turn_attempt_id`
- `agent_runs.chat_turn_id`, `agent_runs.chat_turn_attempt_id`

Indexes:

- `agent_chat_turns(conversation_id, parent_turn_id, created_at, id)`
- `agent_chat_turns(conversation_id, user_message_id)`
- `agent_chat_turn_attempts(turn_id, attempt_no)`
- `agent_chat_turn_attempts(run_id)` where `run_id is not null`
- `agent_chat_turn_attempts(queue_item_id)` where `queue_item_id is not null`
- `agent_chat_turns(conversation_id, state)`
- unique branch-selection index on
  `(conversation_id, coalesce(parent_turn_id, '__root__'))`

`agent_chat_turns.parent_turn_id` replaces user lineage currently inferred from
`previousUserMessageId`. Sibling user branches are all turns with the same
`parent_turn_id`. `agent_chat_turns.selected_attempt_id` and
`agent_chat_branch_selections.selected_attempt_id` replace reply branch
selection currently inferred from inbound message siblings.

`client_message_id` is only a reconciliation key for old clients that still
send `messageId`; it is not the turn identity.

## State Machine

Turn states:

- `idle`: user input exists, but no agent response has been requested yet
  (upload-only flow).
- `queued`: a response attempt is queued.
- `running`: the latest response attempt owns a running `agent_runs` row.
- `completed`: the selected attempt produced a final assistant message.
- `failed`: the latest attempt failed and can be retried.
- `cancelled`: the latest attempt was stopped by the user and can be retried.
- `superseded`: a newer edited sibling exists. Superseded turns remain readable
  and branch-selectable; this state is provenance, not deletion.

Allowed turn transitions:

- `idle -> queued`
- `queued -> running`
- `queued -> cancelled`
- `running -> completed`
- `running -> failed`
- `running -> cancelled`
- `failed -> queued`
- `cancelled -> queued`
- any non-superseded state `-> superseded` when an edit creates a replacement
  sibling

Attempt states:

- `queued -> running -> completed`
- `queued -> cancelled`
- `running -> failed`
- `running -> cancelled`

The latest attempt drives `agent_chat_turns.state` unless the turn is
`superseded`. A stopped turn stays in the active path and is a valid parent for
a follow-up turn.

## Parent And Branch Semantics

The active chat path is computed from turns, not messages:

1. Start with `parent_turn_id is null`.
2. Select `agent_chat_branch_selections.selected_turn_id` for that parent.
3. If no selection exists, select the newest non-superseded sibling turn.
4. Render that turn's user message/input snapshot.
5. Render the turn's selected/completed response attempt if present.
6. Repeat using the selected turn id as the next `parent_turn_id`.

Editing turn `T` creates replacement turn `T2` with:

- `T2.parent_turn_id = T.parent_turn_id`
- `T2.supersedes_turn_id = T.id`
- `T.superseded_by_turn_id = T2.id`
- branch selection for `T.parent_turn_id` set to `T2`

Retrying turn `T` does not create a sibling turn. It creates a new
`agent_chat_turn_attempts` row with `attempt_no = max + 1`, updates
`T.selected_attempt_id`, and transitions `T` back to `queued`.

Switching branches updates `agent_chat_branch_selections`. Switching response
variants updates `selected_attempt_id` for the turn and the selection row.

## Flow Mapping

### Send Text

Current: frontend creates a durable `messageId`, sends it to
`POST /api/agents/:id/chat/message`, and rendering infers the turn from the
queue row plus optimistic message.

Target:

1. Client sends prompt and optional `clientMutationId`.
2. Server creates `agent_chat_turns` with `state = queued`, server `id`, input
   snapshot, `parent_turn_id` from the active path or explicit parent turn.
3. Server creates the outbound user `messages` row with `chat_turn_id`.
4. Server creates `agent_chat_turn_attempts` and `agent_chat_queue` linked by
   `chat_turn_id` and `chat_turn_attempt_id`.
5. Response returns `turn`, `userMessage`, `attempt`, and `queueItem`.

### Upload

Upload-only creates an `idle` turn with the uploaded outbound message and no
attempt. `upload-and-respond` follows the send flow after creating the turn.
The existing `/chat/respond` path transitions an `idle` turn to `queued` by
creating a first attempt.

### Edit

Current: `editMessageAndBranch` creates a sibling user message and queues
`respond_to_message`.

Target: edit creates a sibling turn, links supersede provenance, selects that
sibling on the parent branch, creates its user message, then creates the first
response attempt. The original turn and its attempts remain exportable and
selectable.

### Stop / Cancel

Current: `DELETE /api/agent-runs/:id` kills the run, then
`cancelProcessingQueueItemForRun` mutates the processing queue row.

Target: stop resolves `run_id -> attempt -> turn`, cancels the runner, marks
the attempt `cancelled`, marks the turn `cancelled` unless a newer selected
attempt exists, and keeps the user message in the active path. Follow-up turns
can use the stopped turn as `parent_turn_id`.

### Retry

Current: `POST /chat/queue/:itemId/retry` reuses the terminal queue row.

Target: retry accepts a `turnId` or compatibility `queueItemId`, creates a new
attempt and queue item, sets `selected_attempt_id` to the new attempt, and
transitions the turn to `queued`. The old failed/cancelled attempt remains
linked for monitor history.

### Queue

Current: queue ordering and dependencies use `queuedMessageId`,
`targetMessageId`, `previousUserMessageId`, and `dependsOnQueueItemId`.

Target: queue rows carry `chat_turn_id` and `chat_turn_attempt_id`.
Dependencies use `depends_on_chat_turn_id` or the existing queue dependency
until the queue table is migrated. Rendering queue state reads the turn and
attempt state directly.

### Run Monitor

Current: chat run discovery filters `/api/agent-runs` by `conversationId` and
maps `responseParentId` back to a visible message.

Target: `agent_runs` includes `chat_turn_id` and `chat_turn_attempt_id`.
Monitor deep links and active-run polling use those ids. `responseParentId`
remains populated during compatibility for old clients and historic rows.

## Migration And Backfill

The migration is additive and idempotent.

1. Add tables and nullable compatibility columns.
2. Backfill turns from existing messages, one outbound message per turn.
   - `user_message_id = messages.id`
   - `input_content = messages.content`
   - `input_attachments = messages.attachments`
   - `input_type = messages.type`
   - `parent_turn_id` from `messages.previous_user_message_id` when present.
   - If `previous_user_message_id` is absent, derive from the outbound ancestor
     reached through `messages.parent_id`.
   - For legacy linear conversations with no parent tree, assign each outbound
     message to the previous outbound turn chronologically.
3. Backfill inbound messages to attempts.
   - Prefer `messages.metadata.runId -> agent_runs.id`.
   - Else use `messages.parent_id` to find the outbound anchor turn.
   - Else use `agent_runs.response_parent_id`.
   - Else use the nearest previous outbound turn in chronological order.
   - Non-final `agentChatUpdate` system messages link to the attempt but do not
     become selected responses.
4. Backfill `agent_chat_queue`.
   - If `queued_message_id` maps to a message, use that message's turn.
   - Else if `target_message_id` maps to a message, use that message's turn.
   - Else create a placeholder queued turn with `user_message_id = null`,
     `client_message_id = queued_message_id`, input snapshot from
     `agent_chat_queue.prompt`, and parent derived from
     `previous_user_message_id` or `continuation_parent_id`.
   - Create or attach an attempt for every queue row and copy status,
     timestamps, error, fallback, `run_id`, and `response_message_id`.
5. Backfill `agent_runs`.
   - Prefer queue `run_id`.
   - Else prefer final message metadata `runId`.
   - Else map `response_parent_id` to the anchored turn.
   - Unresolved historic chat runs stay nullable but readable in monitor.
6. Backfill branch selections from `conversations.metadata.activeBranches`.
   - Keys shaped `user:<previousUserMessageId|__root__>` map to selected turn
     ids.
   - Keys shaped `reply:<userMessageId>` map to the selected attempt for that
     turn.
   - If metadata is absent, create no row and let default newest-sibling
     selection apply.
7. Mark supersede provenance where possible.
   - Sibling turns with the same `parent_turn_id` and close edit-created ids
     (`edit-*`) can set `supersedes_turn_id` to the previous selected sibling.
   - When provenance is ambiguous, leave supersede fields null; branch semantics
     still work.

Validation queries before enabling turn reads:

- Every non-deleted outbound chat message has `chat_turn_id`.
- Every non-terminal queue row has `chat_turn_id` and
  `chat_turn_attempt_id`.
- Every running chat `agent_runs` row has `chat_turn_id` and
  `chat_turn_attempt_id`.
- Active-path projection from turns matches the current `/chat/messages` active
  projection for sampled conversations.

## Rollout Plan

Phase 1: schema and backfill.

- Add tables and nullable columns.
- Ship an idempotent backfill command.
- Keep all existing endpoints and payload fields unchanged.

Phase 2: backend dual-write.

- `send`, `upload`, `upload-and-respond`, `respond`, `edit`, `retry`, and
  `stop` create/update turns and attempts in the same transaction as current
  message/queue/run writes.
- Existing endpoints return `turnId` and `attemptId` alongside current
  `message`, `queueItem`, and `run` fields.
- Existing fields `previousUserMessageId`, `parentId`, `queuedMessageId`,
  `targetMessageId`, and `responseParentId` remain populated for old clients.

Phase 3: backend read compatibility.

- Add a turn projection service for active/all conversation views.
- Current `/api/agents/:id/chat/messages`,
  `/api/agents/:id/chat/conversations/:cid/queue`, and `/api/agent-runs`
  continue returning old shapes by projecting from turns when possible and
  falling back to legacy inference for unresolved historic rows.

Phase 4: frontend migration.

- Replace durable optimistic message ids with `clientMutationId`.
- Render server turns and attempt states directly.
- Stop deriving queued/stopped/failed turns from queue rows plus active runs in
  `agent-chat-view-model.ts`.
- Switch edit/retry/stop handlers to `turnId` and `attemptId` APIs.

Phase 5: compatibility removal.

Remove these temporary paths after the frontend no longer needs them:

- Request-body `previousUserMessageId` and client-owned durable `messageId` on
  send/upload/edit.
- `conversations.metadata.activeBranches` read/write branch state.
- `messages.previous_user_message_id` as the authoritative user lineage.
- `agent_chat_queue.queued_message_id`, `target_message_id`,
  `continuation_parent_id`, and `previous_user_message_id` as render inputs.
- `agent_runs.response_parent_id` as chat run identity.
- Frontend recovery logic that merges `messages`, `agent_chat_queue`,
  `agent_runs`, branch metadata, and optimistic state to infer chat turns.

Historic columns can be retained longer for exports and operational forensics,
but new code must treat `agent_chat_turns.id` and
`agent_chat_turn_attempts.id` as the authority.
