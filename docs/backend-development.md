# Backend Development

How to change backend code for the OpenWork API.

## Project Structure

```
packages/backend/src/
├── routes/          # HTTP route handlers
├── services/        # Business logic (reused across routes)
├── middleware/       # Request middleware (auth, idempotency, etc.)
├── plugins/         # Fastify plugins (error handler, swagger, etc.)
├── utils/           # Shared backend utilities
├── config/          # Environment and app configuration
└── app.ts           # Route and plugin registration
```

## Adding a New Route

1. Create route file in `packages/backend/src/routes/`
2. Define Zod schemas for request validation
3. Register the route in `app.ts`
4. Apply relevant patterns (see below)

## Adding a New Service

1. Create service file in `packages/backend/src/services/`
2. Export functions that can be reused across routes

## Implementation Patterns

### Idempotency

Registered globally in `app.ts` via `src/middleware/idempotency.ts`. POST endpoints are automatically idempotency-aware — no per-route work needed.

### Batch Processing

Agent batch operations (e.g., `/api/boards/:id/batch-run`, `/api/collections/:id/agent-batch`) use queue-based processing via `src/services/agent-batch-queue.ts`.

### `countOnly` Support

Add `countOnly` query param support in list routes. When true, the route returns `{ total }` without fetching entries. See existing implementations in:
- `src/routes/cards.ts`, `src/routes/conversations.ts`

### Error Handling

Use `ApiError` factory methods from `src/utils/api-errors.ts`:
- `ApiError.badRequest(code, message, hint?)`
- `ApiError.unauthorized(code, message, hint?)`
- `ApiError.forbidden(code, message, hint?)`
- `ApiError.notFound(code, message, hint?)`
- `ApiError.conflict(code, message, hint?)`
- `ApiError.tooMany(code, message, hint?)`

Every error includes a machine-readable `code`, a `message`, and an optional `hint`. The global error handler in `src/plugins/error-handler.ts` serializes these consistently.

### Conditional Actions

For endpoints with conditional server-side logic, keep the logic in the service layer, not in the route handler.
