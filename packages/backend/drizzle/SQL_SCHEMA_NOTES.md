# Initial SQL Schema Notes

The initial PostgreSQL schema is ordered for migration from stable principals
(`users`, `api_keys`, `agent_groups`) through workspace content, communication,
automation, and operational records.

Every domain table includes `legacy_data jsonb not null` so imported records can
retain their full original payload while typed columns support the application.
Runtime writes are accepted only for collections with explicit SQL table
mappings.

Some legacy references are intentionally indexed text columns instead of foreign
keys because current JSON data contains valid historical records whose targets
were deleted or whose IDs refer to another entity type:

- `cards.assignee_id`
- `cards.created_by_id`
- `board_columns.assign_agent_id`
- `card_comments.author_id`
- `card_comments.agent_run_id`
- `messages.conversation_id`
- `messages.parent_id`
- `agent_runs.conversation_id`

Before converting those columns to hard foreign keys, add a remediation that
either restores missing target rows, maps agent author IDs to service users, or
sets orphaned historical references to `null` without changing the original
payload stored in `legacy_data`.
