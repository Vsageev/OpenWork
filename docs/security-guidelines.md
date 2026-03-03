# Security Guidelines

Security patterns that balance protection with development velocity.

## Contents

1. [API Key Handling](#1-api-key-handling) — Critical
2. [Agent Endpoint Security](#2-agent-endpoint-security) — Critical
3. [Transaction Rollback](#3-transaction-rollback) — High
4. [Input Validation](#4-input-validation) — Medium
5. [Rate Limiting](#5-rate-limiting) — Medium

---

## Critical

### 1. API Key Handling

> Never store plaintext API keys. Always hash before persistence.

**Problem:** Workspace API keys stored in database without hashing. A compromised DB dump exposes all agent workspace credentials.

**Solution:** Hash keys using SHA-256 before storing, similar to regular API key handling.

**Pattern:**

```typescript
// services/keys.ts (or similar)
import { createHash } from 'crypto';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function verifyKey(plainKey: string, hashedKey: string): boolean {
  return hashKey(plainKey) === hashedKey;
}

// When creating a key:
const rawKey = generateSecureKey(); // ws_xxxxx format
const keyHash = hashKey(rawKey);
await db.insert({ keyHash, ...metadata });
// Return rawKey to user ONCE, never store it

// When authenticating:
const providedHash = hashKey(providedKey);
const record = await db.findOne({ keyHash: providedHash });
```

**Do:**
- Hash all API keys before database storage
- Use the same hashing approach for workspace API keys and regular API keys
- Return the raw key only once at creation time
- Store key metadata (name, permissions, expiration) separately from the hash

**Don't:**
- Store raw keys in the database
- Use reversible encryption for keys (hashing is one-way)
- Log raw keys in error messages or debug output

**Files to update:** `services/agents.ts:219`

---

### 2. Agent Endpoint Security

> Never expose sensitive fields in API responses.

**Problem:** `asAgent()` returns all fields including `workspaceApiKey`, and list/get routes return this directly. This leaks write-capable internal keys to any user with `settings:read` permission.

**Solution:** Use field exclusion patterns and separate internal/external DTOs.

**Pattern:**

```typescript
// services/agents.ts

// Internal representation (full access)
interface AgentInternal {
  id: string;
  name: string;
  workspaceApiKey: string; // Never expose this
  createdAt: Date;
  // ... other internal fields
}

// External representation (safe for API responses)
interface AgentExternal {
  id: string;
  name: string;
  createdAt: Date;
  // ... safe fields only, NO workspaceApiKey
}

function toAgentExternal(agent: AgentInternal): AgentExternal {
  const { workspaceApiKey, ...safeFields } = agent;
  return safeFields;
}

// Routes should always use the external version
// routes/agents.ts
app.get('/api/agents/:id', async (req, res) => {
  const agent = await getAgent(req.params.id);
  res.json(toAgentExternal(agent)); // Never return raw agent
});
```

**Alternative with explicit field selection:**

```typescript
// Always pick only the fields you need
function asAgentExternal(agent: AgentInternal) {
  return {
    id: agent.id,
    name: agent.name,
    createdAt: agent.createdAt,
    // Explicitly list safe fields
  };
}
```

**Do:**
- Create separate internal/external types
- Use field exclusion (destructuring) to remove sensitive data
- Apply the transformation at the service layer, not just routes
- Audit all endpoints that return agent data

**Don't:**
- Return raw database objects from routes
- Use `asAgent()` that returns all fields in API responses
- Assume internal endpoints are safe from exposure

**Files to update:** 
- `services/agents.ts:156-160` (asAgent function)
- `routes/agents.ts:72-76` (list route)
- `routes/agents.ts:154-158` (get route)

---

## High

### 3. Transaction Rollback

> Validate everything first, then mutate.

**Problem:** If preset rendering or workspace file creation fails mid-way during agent creation, partial agent record and API key persist, leaving orphaned data.

**Solution:** Use database transactions with proper rollback, or validate all prerequisites before any mutation.

**Pattern:**

```typescript
// services/agents.ts

async function createAgent(data: CreateAgentData) {
  // Phase 1: Validate and prepare ALL data
  const validatedName = validateAgentName(data.name);
  const renderedPreset = await renderPreset(data.preset);
  const workspacePath = calculateWorkspacePath(validatedName);
  
  // Verify workspace directory can be created
  await fs.access(workspacePath).catch(() => fs.mkdir(workspacePath, { recursive: true }));
  
  // Phase 2: Begin transaction - all or nothing
  return db.transaction(async (tx) => {
    const agent = await tx.agents.insert({
      name: validatedName,
      // ... other fields
    });
    
    const apiKey = await tx.apiKeys.insert({
      agentId: agent.id,
      // ... key data
    });
    
    // Phase 3: Non-transactional operations (files, external)
    try {
      await createWorkspaceFiles(agent.id, renderedPreset);
    } catch (error) {
      // Transaction auto-rolls back on throw
      throw error;
    }
    
    return { agent, apiKey };
  });
}
```

**Do:**
- Validate all inputs before starting mutations
- Use database transactions for related inserts/updates
- Prepare file operations data before executing them
- Clean up on failure (or rely on transaction rollback)

**Don't:**
- Create database records before validating external dependencies
- Leave partial state on failure
- Mix validation logic with mutation logic

**Files to update:** `services/agents.ts:193-246`

---

## Medium

### 4. Input Validation

> Constrain input types at the schema level.

**Problem:** Overly permissive schemas accept invalid data, causing downstream errors.

**Solution:** Use Zod enums and strict validation for all input types.

**Pattern:**

```typescript
// schemas/collections.ts

// Bad: accepts any string
channelType: z.string()

// Good: constrained enum with explicit values
channelType: z.enum(['telegram', 'internal', 'other', 'agent', 'email', 'web_chat'])

// Better: with default and description
channelType: z
  .enum(['telegram', 'internal', 'other', 'agent', 'email', 'web_chat'])
  .default('internal')
  .describe('Communication channel type for the conversation')
```

**For unimplemented values:**

```typescript
// If some enum values aren't fully implemented yet:
channelType: z.enum(['telegram', 'internal', 'other', 'agent'])
// Remove 'email' and 'web_chat' until handlers exist
```

**Do:**
- Use enums for fixed sets of values
- Validate at the schema boundary (API input)
- Remove unimplemented enum values until ready

**Don't:**
- Use `z.string()` for fields with known valid values
- Add enum values before implementing their handlers
- Validate in multiple places (do it once at the boundary)

**Files to update:** `schemas/collections.ts:149`

---

### 5. Rate Limiting

> Protect resources from abuse without blocking legitimate use.

**Problem:** No rate limiting on prompt execution allows unlimited concurrent processes per agent or user.

**Solution:** Add per-agent and per-user rate limiting middleware.

**Pattern:**

```typescript
// middleware/rate-limit.ts
import { rateLimit } from 'express-rate-limit';

export const agentChatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per agent
  keyGenerator: (req) => {
    // Rate limit by agent ID
    return `agent:${req.params.agentId}`;
  },
  message: {
    statusCode: 429,
    code: 'too_many_requests',
    message: 'Too many requests to this agent',
    hint: 'Wait a moment before sending more messages'
  }
});

export const userPromptLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 large prompts per minute per user
  keyGenerator: (req) => {
    // Rate limit by user/token
    return `user:${req.user?.id || req.ip}`;
  },
  // Also check prompt size
  skip: (req) => {
    const promptSize = JSON.stringify(req.body).length;
    return promptSize < 50 * 1024; // Only limit large prompts
  }
});
```

**Apply to routes:**

```typescript
// routes/agent-chat.ts
import { agentChatLimiter, userPromptLimiter } from '../middleware/rate-limit';

app.post('/api/agents/:agentId/chat', 
  agentChatLimiter, 
  userPromptLimiter,
  handleChat
);
```

**Do:**
- Rate limit by resource (agent) and user
- Use appropriate windows (1 minute for chat, 1 hour for heavy operations)
- Return structured error responses with retry hints

**Don't:**
- Apply global rate limits that affect all users equally
- Block legitimate development/testing workflows
- Forget to document rate limits for API consumers

**Files to update:** `routes/agent-chat.ts:215-221`

---

## Quick Reference

```
CRITICAL
  Hash API keys ........... SHA-256 before DB storage
  Exclude sensitive ....... Never return workspaceApiKey in responses

HIGH
  Transaction rollback .... Validate first, then mutate in transaction

MEDIUM
  Constrain schemas ....... Use enums, not z.string()
  Rate limit .............. Per-agent and per-user limits
```

## Security Checklist for New Features

Before merging:

- [ ] API keys/secrets are hashed before storage
- [ ] Sensitive fields excluded from API responses
- [ ] Database operations use transactions for related changes
- [ ] Input schemas use strict validation (enums, constraints)
- [ ] Rate limiting applied to user-facing endpoints
- [ ] Error messages don't leak internal details
- [ ] Permissions checked before restricted operations
