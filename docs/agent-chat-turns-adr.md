# ADR: Agent Chat Turns

Status: accepted

## Decision

Agent chat transcript rendering is turn-owned. A visible chat row is defined by
`agent_chat_turns`, and the canonical API is:

```text
GET /api/agents/:agentId/chat/conversations/:conversationId/view
```

The view walks selected `agent_chat_turns.parent_turn_id` links from the root
and renders only the selected turn chain. User and assistant `messages` attach
to turns through `user_message_id` and `assistant_message_id`. Queue rows and
runs attach execution metadata through `turn_id`; they do not define transcript
identity, parentage, branch selection, or message visibility.

## Runtime Model

- `agent_chat_turns.id` is the durable user-step identity.
- `agent_chat_turns.parent_turn_id` defines transcript order and follow-up
  lineage.
- `agent_chat_turns.supersedes_turn_id` records edit provenance; branch
  selection chooses which sibling is currently active.
- `agent_chat_queue.turn_id` and `agent_runs.turn_id` expose queued, running,
  failed, stopped, and retry metadata for an existing turn.
- Historical message lineage and queue identity columns may remain in storage
  for migration, exports, and operational forensics, but runtime chat rendering
  must not read them as fallback transcript sources.

## Migration Gate

Before treating a database as cut over, run:

```bash
pnpm --filter backend chat-turns:migrate
pnpm --filter backend chat-turns:migrate -- --validate-only
```

The validation report must have `invalid: 0`. Any invalid row ids in
`invalidRows` must be repaired or intentionally archived before the deployment
uses the canonical-only read path.

## Compatibility Retention

Some legacy columns are retained temporarily because old clients, exports, or
historic operational records can still contain them. They are compatibility
metadata only:

- `messages.parent_id` and `messages.previous_user_message_id`
- `agent_chat_queue.queued_message_id`, `target_message_id`,
  `previous_user_message_id`, `continuation_parent_id`, and `response_message_id`
- `agent_runs.response_parent_id`
- `conversations.metadata.activeBranches` keys that reference message ids

New transcript code must use turn ids. Migration/backfill code is the only place
that may infer turns from historical message or execution records.

## Guard Rails

- Backend canonical view tests include a static contract that fails if
  forbidden fallback helpers or legacy queue/run/message transcript keys return
  to `agent-chat-view.ts`.
- Frontend view-model tests fail if the chat renderer reconstructs visible chat
  state from legacy `messages`, queue rows, active runs, or optimistic rows when
  the canonical view is absent.
- Lifecycle tests cover migrated legacy conversations, fresh conversations, and
  queued multi-message conversations through the canonical view shape.
