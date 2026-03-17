# Auth and Access

This area covers every flow required to authenticate and authorize API calls.

## Core flow

1. `POST /api/auth/login` with email/password.
2. If response has `twoFactorRequired`, call `POST /api/auth/2fa/verify`
   with `twoFactorToken` and a code.
3. Use returned `accessToken` in `Authorization: Bearer <token>`.
4. Use `POST /api/auth/refresh` to rotate access tokens when needed.
5. `POST /api/auth/logout` revokes refresh tokens.

## Password and profile endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/refresh`
- `POST /api/auth/2fa/verify`
- `PATCH /api/auth/password`
- `PATCH /api/auth/profile`
- `POST /api/auth/logout`

## 2FA and recovery

- `POST /api/auth/2fa/setup`
- `POST /api/auth/2fa/confirm`
- `POST /api/auth/2fa/disable`
- `POST /api/auth/2fa/recovery-codes`

## API keys and permission checks

- `GET /api/api-keys`
- `GET /api/api-keys/:id`
- `POST /api/api-keys`
- `PATCH /api/api-keys/:id`
- `DELETE /api/api-keys/:id`
- `POST /api/permissions/check`

API key scope checks apply to route groups that enforce permission middleware.
JWT sessions are accepted as user sessions and do not require permission codes.

## Directory users

- `GET /api/users` (for selecting assignees, recipients, etc.).

## Where to verify exact schemas

- Route implementations: `packages/backend/src/routes/auth.ts`,
  `packages/backend/src/routes/api-keys.ts`, `packages/backend/src/routes/permissions.ts`,
  `packages/backend/src/routes/users.ts`
- Permission types: `packages/shared/src/index.ts`
- Auth middleware:
  - `packages/backend/src/middleware/authenticate.ts`
  - `packages/backend/src/plugins/jwt.ts`
  - `packages/backend/src/middleware/api-key-auth.ts`
