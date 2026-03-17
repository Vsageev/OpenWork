# Workspace Content

Use this section for customer data structures and operations on work items.

## Workspaces

- `GET /api/workspaces`
- `POST /api/workspaces`
- `PATCH /api/workspaces/:id`
- `DELETE /api/workspaces/:id`

## Boards

- `GET /api/boards`, `POST /api/boards`, `PATCH /api/boards/:id`, `DELETE /api/boards/:id`
- Columns:
  - `POST /api/boards/:id/columns`
  - `PATCH /api/boards/:id/columns/:columnId`
  - `DELETE /api/boards/:id/columns/:columnId`
- Card placement:
  - `POST /api/boards/:id/cards`
  - `PATCH /api/boards/:id/cards/:cardId` (move/remap semantics)
  - `DELETE /api/boards/:id/cards/:cardId`

## Collections

- `GET /api/collections`
- `POST /api/collections`
- `PATCH /api/collections/:id`
- `DELETE /api/collections/:id`
- `GET /api/collections/:id/cards` to list members
- Batch automation:
  - `POST /api/collections/:id/agent-batch`
  - `GET /api/collections/:id/agent-batch/runs`
  - `GET /api/collections/:id/agent-batch/runs/:runId`
  - `GET /api/collections/:id/agent-batch/runs/:runId/items`
  - `POST /api/collections/:id/agent-batch/runs/:runId/cancel`

## Cards and tags

- `GET /api/cards`, `GET /api/cards/:id`, `POST /api/cards`, `PATCH /api/cards/:id`,
  `DELETE /api/cards/:id`
- Card relationships:
  - `POST /api/cards/:id/tags`
  - `DELETE /api/cards/:id/tags/:tagId`
  - `POST /api/cards/:id/links`
  - `DELETE /api/cards/:id/links/:linkId`
  - `GET /api/cards/:id/comments`
  - `POST /api/cards/:id/comments`
  - `PATCH /api/cards/:id/comments/:commentId`
  - `DELETE /api/cards/:id/comments/:commentId`
- Helpers:
  - `POST /api/cards/:id/comments/upload`
  - `POST /api/cards/description/images/upload`
  - `POST /api/cards/:id/description/images/upload`

Tag endpoints:

- `GET /api/tags`
- `POST /api/tags`
- `PATCH /api/tags/:id`
- `DELETE /api/tags/:id`

## Quick flow: card-to-agent batch

1. Create board/collection/card scope.
2. Run agent task on board or collection batch endpoint.
3. Poll run status using board/collection run endpoints.

## Where to verify exact schemas

- Route implementations:
  - `packages/backend/src/routes/workspaces.ts`
  - `packages/backend/src/routes/boards.ts`
  - `packages/backend/src/routes/collections.ts`
  - `packages/backend/src/routes/cards.ts`
  - `packages/backend/src/routes/tags.ts`
- Related services for shared behavior:
  - `packages/backend/src/services/boards.ts`
  - `packages/backend/src/services/collections.ts`
  - `packages/backend/src/services/cards.ts`
