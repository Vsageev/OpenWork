# Runner-Split QA Smoke Harness

Run this before merging changes that touch agent chat queueing, runner routing,
runner protocol, or the agent chat sidebar state contract.

```bash
pnpm smoke:runner-split
```

The command runs focused Vitest suites and prints a concise pass/fail report,
including the IDs of any test resources created by the backend smoke test.
It does not require a live backend, frontend, runner, or PostgreSQL database.
The backend smoke test uses in-memory service-layer records with `qa-smoke`
resource IDs and does not mutate local application state.

## Coverage

- Backend service/API contract: creates a test agent, workspace, agent
  conversation, card, and queued chat prompt through service helpers.
- Sidebar/chat state contract: verifies queued prompts are recovered by the
  frontend chat view model.
- Runner protocol: validates current job offer and runner lifecycle payloads.
- Non-Codex startup planning: verifies executable discovery and command plans
  for Claude, Qwen, Cursor, and OpenCode without spawning their real CLIs.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Dependencies installed with `pnpm install`

## Unsupported Environments

- Environments where shell scripts cannot execute temporary files from the OS
  temp directory.
- Production hosts where development/test dependencies are intentionally absent.

## Temporary Data

The harness uses test-only IDs prefixed with `qa-smoke`. Runner executable
fixtures are created under the OS temp directory and removed after each test.
