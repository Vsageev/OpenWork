# Development Guide

This document provides guidelines and utilities to make development faster and more consistent.

## Quick Start

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Run type checking
pnpm typecheck

# Run linter
pnpm lint
```

## Shared Utilities

Import utilities from the `shared` package instead of reimplementing:

```typescript
import { formatBytes, formatDate, createListResponse } from 'shared';

// Format file sizes consistently
const size = formatBytes(1536000); // "1.5 MB"

// Format dates consistently
const date = formatDate(new Date().toISOString());

// Create consistent API responses
const response = createListResponse(items, total, limit, offset);
```

## API Response Standards

### List Responses

All list endpoints should return consistent shapes:

```typescript
import { apiListResponse } from '#lib/api-helpers';

// In your route handler
app.get('/api/items', async (req, reply) => {
  const { limit = 20, offset = 0 } = req.query;
  const items = await getItems(limit, offset);
  const total = await countItems();
  
  return reply.send(apiListResponse(items, total, limit, offset));
});
```

Expected response shape:
```json
{
  "entries": [...],
  "total": 100,
  "limit": 20,
  "offset": 0
}
```

### Error Responses

Use Fastify's built-in error handling via `@fastify/sensible`:

```typescript
// In route handlers
if (!item) {
  return reply.notFound('Item not found');
}

// For validation errors
throw reply.badRequest('Invalid input');
```

## Rate Limiting

For development-speed rate limiting without complex setup:

```typescript
import { createAgentRateLimiter } from '#lib/api-helpers';

const rateLimiter = createAgentRateLimiter();

// In your route
if (!rateLimiter.isAllowed(agentId)) {
  return reply.tooManyRequests('Rate limit exceeded');
}
```

## Security Guidelines

### API Keys

- Use scoped API keys for development tasks
- Set expiration dates (90 days recommended)
- Choose the most restrictive key that allows your task

Available dev keys (see AGENTS.md for details):
- `ws_tbrz6` - Dev Tasks (cards, boards, messages write)
- `ws_qijlI` - UI Dev (cards, messages write)

### Input Validation

Always validate inputs using Zod schemas:

```typescript
import { z } from 'zod';

const createItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

// Use in route schema
app.post('/api/items', {
  schema: {
    body: createItemSchema,
  },
}, async (req, reply) => {
  // req.body is already validated
});
```

## Testing

```bash
# Run all tests
pnpm test

# Run backend tests only
pnpm --filter backend test

# Run frontend tests only
pnpm --filter frontend test
```

## Code Style

- Use TypeScript for all new code
- Follow existing naming conventions (camelCase for variables, PascalCase for types)
- Keep functions small and focused
- Add comments only for complex logic (focus on why, not what)

## Common Tasks

### Adding a New Route

1. Create route file in `packages/backend/src/routes/`
2. Define Zod schema for validation
3. Use `apiListResponse` for list endpoints
4. Add route registration in `app.ts`

### Adding a New Service

1. Create service file in `packages/backend/src/services/`
2. Export functions that can be reused across routes
3. Use dependency injection for testability

### Frontend Component

1. Create component in `packages/frontend/src/components/`
2. Use shared utilities for formatting
3. Follow existing component patterns

## Troubleshooting

### Build Issues

```bash
# Clean and rebuild
pnpm clean
pnpm install
pnpm build
```

### Type Errors

```bash
# Check types without emitting
pnpm typecheck
```

### Lint Errors

```bash
# Auto-fix where possible
pnpm lint:fix
```
