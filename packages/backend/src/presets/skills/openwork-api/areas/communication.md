# Communication

This area covers conversational workflows, channel messages, and message drafts.

## Conversations

- `GET /api/conversations`
- `GET /api/conversations/:id`
- `POST /api/conversations`
- `PATCH /api/conversations/:id`
- `DELETE /api/conversations/:id`
- `POST /api/conversations/read-all`
- `POST /api/conversations/:id/read`

## Messages

- `GET /api/messages`
- `GET /api/messages/:id`
- `POST /api/messages`
- `PATCH /api/messages/:id/status`

## Drafts

- `GET /api/message-drafts`
- `GET /api/message-drafts/:id`
- `PUT /api/message-drafts`
- `DELETE /api/message-drafts/:id`
- `POST /api/message-drafts/:id/send`

## Media messages

- `GET /api/media/:messageId/:attachmentIndex`
- `POST /api/media/upload`

## Recommended flow

1. Create conversation with contact context via `POST /api/conversations`.
2. Load history with `GET /api/messages?conversationId=...`.
3. Draft and optionally send via `POST /api/message-drafts` and
   `/api/message-drafts/:id/send`.
4. Send final content using `POST /api/messages`.

## Where to verify exact schemas

- `packages/backend/src/routes/conversations.ts`
- `packages/backend/src/routes/messages.ts`
- `packages/backend/src/routes/message-drafts.ts`
- `packages/backend/src/routes/media.ts`
- `packages/backend/src/services/messages.ts`

