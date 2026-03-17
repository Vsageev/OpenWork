# Common Flows

Practical examples for consumers that need quick implementation guidance.

## 1) Human login flow with optional 2FA

1. `POST /api/auth/login` with `email`, `password`.
2. If response is `{ twoFactorRequired: true, twoFactorToken }`, call
   `POST /api/auth/2fa/verify` with token + code.
3. Store `accessToken` / `refreshToken`.
4. Call `GET /api/auth/me` and keep `Authorization: Bearer <accessToken>`.
5. Refresh with `POST /api/auth/refresh` before expiry.

## 2) Conversation-to-response flow

1. `POST /api/conversations` (create/get a conversation).
2. Load current message history with `GET /api/messages?conversationId=...`.
3. Optional compose using `PUT /api/message-drafts`.
4. Send final text through `POST /api/messages` with `direction: "outbound"`.
5. Mark as acknowledged via `POST /api/conversations/:id/read`.

## 3) AI-assisted batch flow

1. Prepare target scope:
   - board: `GET /api/boards/:id/cards`
   - collection: `GET /api/collections/:id/cards`
2. Start batch via board/collection agent endpoints.
3. Monitor `GET /api/agent-batch-runs` and item details:
   - `GET /api/boards/:id/batch-runs/:runId`
   - `GET /api/boards/:id/batch-runs/:runId/items`
4. Cancel if needed with corresponding `:runId/cancel`.

## 4) webhook integration flow

1. Discover events: `GET /api/webhooks/events`.
2. Register integration: `POST /api/webhooks`.
3. Verify deliveries: `GET /api/webhooks/:id/deliveries`.
4. Retry failed one: `POST /api/webhook-deliveries/:id/retry`.

