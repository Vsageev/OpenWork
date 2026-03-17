# Storage and Media

This section covers internal file browsing, uploads, downloads, and media serving.

## Storage API

- `GET /api/storage` (`path` query)
- `GET /api/storage/stats`
- `GET /api/storage/browse-fs`
- `POST /api/storage/folders`
- `POST /api/storage/references`
- `POST /api/storage/upload`
- `GET /api/storage/download`
- `PATCH /api/storage/rename`
- `POST /api/storage/reveal`
- `DELETE /api/storage`

## Media and attachment helpers

- `GET /api/media/:messageId/:attachmentIndex`
- `POST /api/media/upload`
- `POST /api/cards/:id/description/images/upload`
- `POST /api/cards/description/images/upload`
- `POST /api/cards/:id/comments/upload`

## Widget scripts (non-API)

- `GET /widget.js` (form widget bundle)
- `GET /chat-widget.js` (chat widget bundle)

## Recommended patterns

- For human-facing UI flows, prefer short-lived pre-signed or server-generated
  endpoints where possible.
- Keep uploaded file names under size limits and MIME checks for stricter safety.

## Where to verify exact schemas

- `packages/backend/src/routes/storage.ts`
- `packages/backend/src/routes/media.ts`
- `packages/backend/src/services/storage.js`
- `packages/backend/src/services/messages.ts` (attachment payload behavior)
