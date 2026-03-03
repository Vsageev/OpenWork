# TOFIX

## Critical

- **Plaintext workspace API keys** (`services/agents.ts:219`) — `wsKey.rawKey` stored in database without hashing, unlike regular API keys which use `keyHash`. A compromised DB dump exposes all agent workspace credentials.
  - **Status:** Documented in [Security Guidelines](docs/security-guidelines.md#1-api-key-handling)
- **Workspace API key exposed via agent endpoints** (`services/agents.ts:156-160`, `routes/agents.ts:72-76`, `routes/agents.ts:154-158`) — `asAgent()` returns all fields including `workspaceApiKey`, and list/get routes return this directly. This leaks a write-capable internal key to any user with `settings:read` permission.
  - **Status:** Documented in [Security Guidelines](docs/security-guidelines.md#2-agent-endpoint-security)
- ~~**HTML sanitization via regex**~~ — FIXED: replaced regex-based HTML filtering with DOMPurify in `renderFormattedContent()`.

## High

- **No rollback on agent creation** (`services/agents.ts:193-246`) — if preset rendering or workspace file creation fails mid-way, partial agent record and API key persist. Validate everything and prepare all data before inserting into store.
  - **Status:** Documented in [Security Guidelines](docs/security-guidelines.md#3-transaction-rollback)
- ~~**Backend build can ship stale presets after first build**~~ — FIXED: build script now runs `rm -rf dist/presets` before copying.
- ~~**FilePreviewModal race condition**~~ — FIXED: `FilePreviewModal.tsx` uses `AbortController`; fetch is cancelled on unmount and when `downloadUrl`/`fileName` change. `loading` is only cleared when signal was not aborted.
- ~~**Memory leak in agent-chat-runtime**~~ — FIXED: added `MAX_STREAMS = 100` cap in `agent-chat-runtime.ts`; `evictOldestStreams()` evicts oldest finished streams first when the limit is exceeded.
- **Agent deletion misses legacy conversations** (`services/agents.ts:276-283`) — cleanup only targets `channelType === 'agent'`; legacy rows with `channelType: 'other'` + `metadata.agentId` remain orphaned. Update query to also match legacy pattern.
- **Agent conversation draft cleanup uses wrong collection key** (`services/agent-chat.ts:174`) — deletes from `message_drafts`, but draft services use `messageDrafts` (camelCase). Related drafts may not be deleted on conversation deletion.

## Medium

- ~~**Overly permissive channelType schema**~~ — FIXED: `channelType` in `schemas/collections.ts` now uses `z.enum(['telegram', 'internal', 'other', 'agent', 'email', 'web_chat'])` instead of `z.string()`.
- **Unimplemented channel types in routes** (`routes/conversations.ts:19`) — `'email'` and `'web_chat'` added to enum but no corresponding handlers/services exist. Remove until implemented or add stub handling.
- **SSE error handling incomplete** (`services/agent-chat.ts:368-372`) — `child.on('error')` callback writes to SSE stream after `reply.raw.end()` may have been called. Error events during startup may not reach client.
- ~~**No rate limiting on prompt execution**~~ — FIXED: `createAgentRateLimiter()` from `lib/api-helpers.ts` applied to `POST /api/agents/:id/chat/message` and `POST /api/agents/:id/chat/respond`; rate-limited per user-agent pair (10 req/min).
- **Missing system contact validation** (`services/agent-chat.ts:141`) — `contactId: 'system'` assumed to exist without validation. Add check or create system contact on first use.
- ~~**Duplicated utilities**~~ — FIXED: `BackupsTab.tsx` and `InboxPage.tsx` now import `formatBytes`/`formatDate` from `shared`; `file-utils.ts` re-exports shared versions.
- **Inconsistent API response shapes** — list endpoints return varying shapes: `{entries, total, limit, offset}` vs `{entries}` vs `{clis}`. Standardize on `{entries, total, limit?, offset?}` pattern.
- **Missing tests for agent services** — no unit or integration tests for `services/agents.ts`, `services/agent-chat.ts`, or agent routes. Add test coverage for CRUD, chat streaming, and file operations.

## Low

- ~~**Inconsistent error UX**~~ — FIXED: `CardDetailPage.tsx` now uses `toast.error()` / `toast.success()` throughout; no more `alert()` calls.
- ~~**Extract shared Modal component**~~ — FIXED: `ui/Modal.tsx` + `Modal.module.css` introduced as a reusable, accessible modal with focus trap, backdrop click, and Escape-to-close.
- ~~**Missing memoization in CardDetailPage**~~ — FIXED: `cfEntries` and `tagIds` now wrapped in `useMemo()` in `CardDetailPage.tsx`.
- ~~**StoragePage drag counter**~~ — FIXED: added `useEffect` that listens for global `dragend`/`drop` events on `window` to reset the counter and drag state.
- ~~**No scroll-to-bottom in agent chat**~~ — FIXED: `AgentsPage.tsx` has `scrollToBottom` callback triggered by a `useEffect` on `[messages, streamText]`; chat view now tracks the latest message automatically.
- **AgentsPage.tsx is ~1800+ lines** — split into sub-components: `AgentListSidebar`, `ChatPanel`, `FileExplorer`, `CreateAgentModal`.
- ~~**Broken path in api-agent.md**~~ — FIXED: `.claude/agents/api-agent.md` now correctly references `docs/backend-api-design-guidelines.md`.
- ~~**Agent avatar picker color presets overflow**~~ — FIXED: `.palettesGrid` in `AgentAvatar.module.css` now has `max-height: 120px; overflow-y: auto` so presets stay within modal bounds on small screens.

## Fixed

- ~~**Path traversal in agent file operations**~~ — FIXED: `validateAgentPath()` (line 338-347) now properly resolves and verifies paths stay within workspace root.
- ~~**SSE busy-check ordering**~~ — FIXED: busy check (line 215-221) now occurs before SSE headers are written (line 228-231).
