# Discalimer

This is an experimenal preview. If anything broke - ask your cli agent to fix or contact me. Any feedback is alos welcomed

# OpenWork

OpenWork is a workspace platform with boards, cards, folders, unified inbox, Telegram integration, AI agents, and webhook automation.

**Tech stack:** Fastify 5, JSON file store, React 19, Vite, TypeScript, Zod v4, pnpm workspaces.

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+

### 1. Clone and install

```bash
git clone <repo-url> && cd openwork
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
cp packages/backend/.env.example packages/backend/.env
```

### 3. Bootstrap backend data (optional)

```bash
pnpm db:bootstrap
```

Initializes the backend JSON store with the default workspace records needed for a fresh environment: admin and starter users, project settings, the general collection, the `auto-dev-cards` board, and the default workspace. See [Bootstrap Data](#bootstrap-data) for details.

### 4. Generate HTTPS certs (optional)

```bash
pnpm certs:generate
```

### 5. Start dev servers

```bash
pnpm dev
```

- **Frontend:** https://localhost:5173
- **Backend API:** http://localhost:3847
- **Swagger docs:** http://localhost:3847/docs

## Project Structure

```
packages/
  backend/     Fastify API server, JSON file store
  frontend/    React 19 SPA, Vite, React Router
  shared/      Shared TypeScript types
  widget/      Embeddable web form & chat widgets
scripts/       Dev utility scripts (cert generation)
docs/          Design system and developer guides
```

### `packages/backend`

REST API server handling all workspace logic. Built with Fastify 5 and fastify-type-provider-zod, uses a JSON file-based data store.

Key areas:

- **21 route files** — auth, cards, boards, folders, tags, conversations, messages, agents, agent chat, connectors, Telegram, webhooks, media, storage, API keys, permissions, audit logs, backups, message drafts, health, and widget
- **23 services** — agents & agent chat, Telegram bot/webhook/outbound, webhook delivery, event bus, backup, storage, connectors, audit logging, TOTP 2FA, and core CRUD for cards, boards, folders, conversations, messages, tags
- **20 data collections** — users, cards, boards, folders, tags, conversations, messages, connectors, Telegram bots, webhooks, API keys, audit logs, message drafts, and more
- **Security** — JWT auth with refresh tokens, API key scoped permissions, 2FA (TOTP), rate limiting, audit logging

### `packages/frontend`

React 19 single-page application. All pages are lazy-loaded via React Router for code splitting.

Key areas:

- **Pages** — Dashboard, Boards (list/detail), Cards (detail), Folders (list/detail), Inbox, Agents, Connectors, Storage, Settings (API keys, backups), Auth (login/register/2FA)
- **State** — React Context for auth, custom hooks for data fetching
- **API client** (`src/lib/api.ts`) — centralized fetch wrapper with JWT auto-refresh on 401

### `packages/shared`

TypeScript type definitions shared between backend and frontend: permission types and auth interfaces.

### `packages/widget`

Standalone JavaScript widgets embedded on external websites via a `<script>` tag. Built as IIFE bundles with no dependencies, rendered inside Shadow DOM for style isolation.

Two widgets:

- **`ws-form.js`** — embeddable web form. Fetches form config from the backend by ID, renders fields dynamically, submits data back. Auto-initializes from `data-ws-form` / `data-ws-api-url` HTML attributes, or via `WsForm.init()`.
- **`ws-chat.js`** — embedded chat widget for real-time conversations with visitors.

Usage example:

```html
<div data-ws-form="FORM_ID" data-ws-api-url="https://your-api.example.com"></div>
<script src="https://your-cdn.example.com/ws-form.js"></script>
```

### `scripts/`

- **`generate-certs.sh`** — generates local HTTPS certificates via [mkcert](https://github.com/FiloSottile/mkcert) into `certs/`. Run with `pnpm certs:generate`.

## Key Commands

| Command                  | Description                                |
| ------------------------ | ------------------------------------------ |
| `pnpm dev`               | Start all dev servers in parallel           |
| `pnpm dev:backend`       | Start backend only                          |
| `pnpm dev:frontend`      | Start frontend only                         |
| `pnpm build`             | Build all packages                          |
| `pnpm lint`              | Lint all packages                           |
| `pnpm typecheck`         | Type-check all packages                     |
| `pnpm docker:full`       | Start everything in Docker                  |
| `pnpm docker:full:stop`  | Stop Docker containers                      |
| `pnpm docker:down`       | Stop and remove Docker containers           |
| `pnpm db:bootstrap`      | Bootstrap backend JSON data for a fresh environment |
| `pnpm certs:generate`    | Generate local HTTPS certs via mkcert       |

## Features

- **Cards & Folders** — organize work items with tags and links
- **Boards** — Kanban-style boards with customizable columns
- **Unified Inbox** — all conversations in one place
- **Telegram** — bot integration, media support, webhook handling
- **AI Agents** — configurable agents with preset system, file workspaces, and chat interface
- **Connectors** — external service integrations
- **Embeddable Widgets** — web forms and chat widgets for external sites
- **Webhooks** — webhook subscriptions with delivery tracking
- **Storage** — file upload and media management
- **Security** — JWT auth, API key scoped permissions, 2FA (TOTP), rate limiting, audit logging, backups

## Bootstrap Data

Run `pnpm db:bootstrap` from the repo root, or `cd packages/backend && pnpm db:bootstrap`, to initialize a fresh backend data directory.

**Test accounts:**

| Email                     | Password     |
| ------------------------- | ------------ |
| `admin@openwork.local`    | `admin123`   |
| `manager@openwork.local`  | `manager123` |
| `agent1@openwork.local`   | `agent123`   |

## Docker (full stack)

```bash
cp .env.example .env
pnpm docker:full
```

## Environment Variables

See `packages/backend/.env.example` for all backend config.

## Guidelines

All project guidelines live in [`docs/`](./docs/):

- [`docs/backend-development.md`](./docs/backend-development.md) — backend code authoring (routes, services, error handling)
- [`docs/design-system.md`](./docs/design-system.md) — colors, typography, components, layout, animations

## License

Private.
