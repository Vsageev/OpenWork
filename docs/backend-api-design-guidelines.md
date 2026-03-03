# Backend API Guidelines for AI Agent Consumers

Patterns optimized for AI agent consumers — reducing token waste, preventing common LLM mistakes, and making APIs retry-safe.

## Contents

1. [Idempotency Keys](#1-idempotency-keys) — Safety — `src/middleware/idempotency.ts`
2. [Batch Operations](#2-batch-operations) — Efficiency — `src/routes/batch.ts`
3. [`countOnly` Parameter](#3-countonly-parameter) — Efficiency — services + routes
4. [Conditional Actions](#4-conditional-actions) — Correctness — `src/services/cards.ts`
5. [Consistent Error Format](#5-consistent-error-format) — Correctness — global
6. [Check Permissions](#6-check-permissions) — Safety — `src/routes/permissions.ts`

---

## Safety

### 1. Idempotency Keys

> Make every write retry-safe.

**Problem:** Agents retry on timeout or ambiguous errors, causing duplicate records.

**Solution:** Send an `Idempotency-Key` header on POST requests. Duplicate keys within 24h return the cached response.

**Files:** `src/middleware/idempotency.ts`, registered globally in `src/app.ts`

```http
# First call
POST /api/v1/contacts
Idempotency-Key: agent-op-12345
{ "firstName": "Alice" }
-> 201 Created

# Retry — cached response
POST /api/v1/contacts
Idempotency-Key: agent-op-12345
{ "firstName": "Alice" }
-> 201 Created  (X-Idempotent-Replay: true)
```

**Do:**
- Include `Idempotency-Key` on create/update POSTs
- Use a deterministic key (hash of intent + params)

**Don't:**
- Omit the key and hope the network is reliable
- Reuse keys across different operations

---

## Efficiency

### 2. Batch Operations

> One call instead of N.

**Problem:** Deleting 50 contacts = 50 API calls = 50 request/response cycles of wasted tokens.

**Solution:** Batch endpoints accept up to 100 items and return partial-failure results.

**Files:** `src/routes/batch.ts`

**Available endpoints** (same pattern for contacts, cards, tasks, tags):

- `POST /api/batch/{entity}/create` — body: `{ items: [...] }`
- `POST /api/batch/{entity}/update` — body: `{ items: [{ id, data }] }`
- `POST /api/batch/{entity}/delete` — body: `{ ids: [...] }`

**Request/response shapes:**

```jsonc
// Delete
{ "ids": ["id-1", "id-2", "id-3"] }

// Create
{ "items": [{ "firstName": "Alice" }, { "firstName": "Bob" }] }

// Update
{ "items": [{ "id": "id-1", "data": { "firstName": "Alice" } }] }

// Response (all operations)
{
  "succeeded": ["id-1", "id-2"],
  "failed": [{ "id": "id-3", "error": "Not found" }]
}
```

**Do:**
- Use batch endpoints when operating on multiple items
- Handle partial failures — some items may succeed while others fail

**Don't:**
- Loop over single-item endpoints
- Assume all-or-nothing semantics

---

### 3. `countOnly` Parameter

> Skip the payload when you only need a number.

**Problem:** Asking "how many open cards?" returns 500 full objects just to read `total`. Thousands of wasted tokens.

**Solution:** `countOnly=true` returns `{ total: N }` only — no entries, no sorting, no pagination.

**Files:**
- Services: `src/services/contacts.ts`, `src/services/cards.ts`, `src/services/tasks.ts`
- Routes: `src/routes/contacts.ts`, `src/routes/cards.ts`, `src/routes/tasks.ts`, `src/routes/public-api.ts`

```http
GET /api/contacts?countOnly=true
-> { "total": 342 }

GET /api/v1/cards?stage=done&countOnly=true
-> { "total": 57 }

GET /api/tasks?status=pending&countOnly=true
-> { "total": 12 }
```

**Do:**
- Use `countOnly=true` when you only need the count
- Combine with filters (`?stage=done&countOnly=true`)

**Don't:**
- Fetch full lists and count them client-side
- Use `limit=1` as a counting workaround

---

## Correctness

### 4. Conditional Actions

> Let the API handle business logic.

**Problem:** Agent builds multi-step workflows: "read card value, if > $10k, move to Done." Each step = extra call, extra room for mistakes.

**Solution:** Embed conditional logic in the API. `moveCard` accepts `autoComplete` + `completeIfValue` — the server evaluates and acts.

**Files:** `src/services/cards.ts:moveCard`, `src/routes/cards.ts`

```jsonc
POST /api/cards/:id/move
{
  "columnId": "column-uuid",
  "autoComplete": true,       // enable conditional completion
  "completeIfValue": 10000    // threshold in card currency
}
// If card.value >= 10000 -> auto-moves to done column, sets completedAt
// If card.value <  10000 -> moves to the specified column normally
```

**Do:**
- Express intent in a single call with conditional params
- Let the server enforce business rules

**Don't:**
- Build multi-step conditional logic in the agent
- Make separate read-then-write calls for conditional operations

---

### 5. Consistent Error Format

> Predictable responses for every failure mode.

**Problem:** Inconsistent error shapes force brittle parsing. All-or-nothing operations give no feedback on partial success.

**Solution:**
- Structured `ApiError` class (`src/utils/api-errors.ts`) with machine-readable `code`, `message`, and optional `hint`
- Batch ops return `{ succeeded, failed }` with per-item details
- Zod validation returns structured field-level errors

**Files:** `src/utils/api-errors.ts`, `src/plugins/error-handler.ts`

The `ApiError` class provides factory methods: `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`, `conflict()`, `tooMany()`. Each error includes:
- `code` — machine-readable identifier (e.g., `"contact_not_found"`, `"duplicate_contact"`)
- `message` — human-readable description
- `hint` — corrective suggestion for the caller (optional)

```jsonc
// 400 — validation error
{ "statusCode": 400, "code": "missing_file", "message": "No file uploaded",
  "hint": "Send a CSV file as multipart/form-data with field name \"file\"" }

// 404 — not found (with hint)
{ "statusCode": 404, "code": "contact_not_found", "message": "Contact abc-123 not found",
  "hint": "Verify the contact ID exists via GET /api/contacts" }

// 409 — conflict (duplicate)
{ "statusCode": 409, "code": "duplicate_contact", "message": "Potential duplicate contacts found",
  "details": [...], "hint": "To skip duplicate checking, set query parameter skipDuplicateCheck=true" }

// Batch partial failure
{
  "succeeded": ["id-1", "id-2"],
  "failed": [
    { "id": "id-3", "error": "Not found" },
    { "id": "id-4", "error": "Not found" }
  ]
}
```

**Do:**
- Check `statusCode` first, then use `code` for programmatic branching
- Read `hint` for corrective actions — it tells you how to fix the request
- For batch ops, iterate `failed` array to handle individual errors

**Don't:**
- Assume all items in a batch succeeded
- Parse `message` with regex — use `code` for machine logic

---

### 6. Check Permissions

> Know what you can do before you try.

**Problem:** Agent calls an endpoint, gets 403, retries, gets 403 again — wasted tokens and no progress.

**Solution:** `POST /api/permissions/check` accepts a list of permission strings and returns a boolean for each one.

**Files:** `src/routes/permissions.ts`

```http
POST /api/permissions/check
Authorization: Bearer <token>
{
  "permissions": ["contacts:read", "contacts:delete", "users:delete"]
}

-> 200 OK
{
  "permissions": {
    "contacts:read": true,
    "contacts:delete": false,
    "users:delete": false
  }
}
```

**Do:**
- Check permissions before attempting restricted operations
- Batch multiple permission checks into a single call (up to 100)
- Cache recent permission-check results for the current token when appropriate

**Don't:**
- Call individual endpoints just to test if you have access
- Hardcode permission assumptions — always verify via this endpoint

---

## Quick Reference

```
SAFETY
  Idempotency-Key header .... POST requests, 24h cache, X-Idempotent-Replay

EFFICIENCY
  Batch endpoints ........... /api/batch/{entity}/{create,update,delete}  max 100
  countOnly=true ............ any list endpoint, returns { total } only

CORRECTNESS
  Conditional move .......... POST /api/cards/:id/move  { autoComplete, completeIfValue }
  ApiError class ............ { statusCode, code, message, hint }
  Partial failures .......... { succeeded: [...], failed: [...] }

SAFETY
  Check permissions ......... POST /api/permissions/check  { permissions: [...] }
```

---

## Security

See [Security Guidelines](security-guidelines.md) for detailed patterns on:
- API key hashing
- Agent endpoint security
- Transaction rollback
- Input validation
- Rate limiting
