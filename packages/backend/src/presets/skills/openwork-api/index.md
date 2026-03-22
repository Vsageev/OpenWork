---
name: OpenWork Host Platform API
description: Use this skill only for tasks that interact with the OpenWork platform that hosts, invokes, or manages the agent.
---

# OpenWork Host Platform API

Use this skill only when the task involves the OpenWork platform that hosts,
invokes, or manages the agent.

- This skill describes the host platform API and operational model.
- It does not mean the current repository is an OpenWork codebase.
- The project under edit is still the current workspace unless the user points
  you somewhere else.

When the task does involve OpenWork integration, use this page as the first
entry point for backend API guidance. Everything below is intentionally
modular: read this page, then the linked area pages for endpoint-level
guidance.

## Entry Points

- **Swagger / OpenAPI**: `GET /docs` on the backend.
- **Public service check**: `GET /health`.
- **Embeddable widgets**: `GET /widget.js` and `GET /chat-widget.js`.

## Baseline Convention

All API routes use `application/json` request/response bodies unless explicitly
noted.

- Base API prefix: `/api`.
- Authentication header: `Authorization: Bearer <token>`.
- JWT tokens are short-lived and refreshed via `POST /api/auth/refresh`.
- API keys are accepted in the same header, prefixed with `ws_`.
- List endpoints typically support `limit` (`1..100`, default `50`) and `offset`
  (`0` by default).
- List responses usually return: `total`, `limit`, `offset`, `entries`.
- Some endpoints support `countOnly=true` and return only `{ total }`.
- Errors follow a consistent format:
  - `statusCode`, `code`, `error`, `message`, `details`, `hint`.

### Permission model

When authenticated via API key, requests are permission-scoped with
`resource:action`.

- Examples from `packages/shared/src/index.ts`: `cards:read`, `cards:write`,
  `messages:send`, `webhooks:delete`.
- `resource:write` is treated as read + write.

## Capability Map

- [areas/auth-and-access.md](./areas/auth-and-access.md) — authentication, API keys,
  permissions, 2FA, user profile.
- [areas/workspace-content.md](./areas/workspace-content.md) — workspaces, boards,
  collections, cards, tags.
- [areas/communication.md](./areas/communication.md) — conversations, messages,
  message drafts, media.
- [areas/agents.md](./areas/agents.md) — agents, agent chat, runs, and batch runs.
- [areas/automation.md](./areas/automation.md) — webhooks, connectors, Telegram.
- [areas/storage-media.md](./areas/storage-media.md) — storage filesystem and
  upload/download flows.
- [areas/platform.md](./areas/platform.md) — settings, backups, audit logs, health.
- [areas/index.md](./areas/index.md) — modular index for the same pages.

## Quick Generic Flows

- **Session onboarding**: `POST /api/auth/login` → token in `Authorization` →
  `GET /api/auth/me`.
- **Conversation handling**: `POST /api/conversations` →
  `POST /api/messages` (or send draft via `/api/message-drafts`).
- **AI run in bulk**: manage board/collection → run agent endpoint → monitor run.
- **Platform verification**: when you change OpenWork-managed resources such as
  skills, settings, agent attachments, or runs, verify through the live HTTP
  API the user relies on. Prefer `login` → target `GET`/mutation → target `GET`
  again, and treat repo files or direct service calls as supporting evidence,
  not proof of live behavior.
- **Previous run forensics**: when the question is about what an earlier agent run
  saw or did, start with `areas/agents.md` and inspect `/api/agent-runs`,
  `/api/agent-runs/:id`, and `packages/backend/src/services/agent-runs.ts`
  before concluding the logs are unavailable.
- **Event integrations**: create webhook → inspect event logs/deliveries.

For step-by-step examples: [flows/index.md](./flows/index.md).

## See Also

- Full request/response schemas: `GET /docs`.
- Edge-case behavior and implementation details: inspect route handlers in
  `packages/backend/src/routes`.
