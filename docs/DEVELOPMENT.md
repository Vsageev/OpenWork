# Development Guide

General dev setup, commands, and troubleshooting. For module-specific guidance, see:

- [Backend Development](./backend-development.md) — routes, services, error handling, implementation patterns
- [Design System](./design-system.md) — colors, typography, components, animation rules

## Quick Start

```bash
pnpm install   # install dependencies
pnpm dev       # run in development mode
pnpm typecheck # run type checking
pnpm lint      # run linter
```

## Shared Utilities

Import utilities from the `shared` package instead of reimplementing:

```typescript
import { formatBytes, formatDate, createListResponse } from 'shared';

formatBytes(1536000);                        // "1.5 MB"
formatDate(new Date().toISOString());        // formatted date
createListResponse(items, total, limit, offset); // consistent API response
```

## Code Style

- TypeScript for all new code
- camelCase for variables, PascalCase for types
- Keep functions small and focused
- Comments only for complex logic (why, not what)
- Prefer extending shared utilities before adding local helpers

## Troubleshooting

```bash
pnpm clean && pnpm install && pnpm build  # clean rebuild
pnpm typecheck                             # check types without emitting
pnpm lint:fix                              # auto-fix lint errors
```
