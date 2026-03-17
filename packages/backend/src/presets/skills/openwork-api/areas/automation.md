# Integrations and Automation

Use this section for external systems and event-driven workflows.

## Webhooks

- `GET /api/webhooks`
- `POST /api/webhooks`
- `GET /api/webhooks/events`
- `GET /api/webhooks/:id`
- `GET /api/webhooks/:id/deliveries`
- `GET /api/webhook-deliveries/:id`
- `PATCH /api/webhooks/:id`
- `DELETE /api/webhooks/:id`
- `POST /api/webhook-deliveries/:id/retry`

Webhook delivery events include retries and status tracking to support replay debugging.

## Connectors

- `GET /api/connectors`
- `POST /api/connectors`
- `GET /api/connectors/:id`
- `DELETE /api/connectors/:id`
- `POST /api/connectors/:id/refresh`
- `PATCH /api/connectors/:id/settings`

## Telegram

- `GET /api/telegram/bots`
- `GET /api/telegram/bots/:id`
- `POST /api/telegram/bots`
- `PATCH /api/telegram/bots/:id/auto-greeting`
- `POST /api/telegram/bots/:id/refresh-webhook`
- `DELETE /api/telegram/bots/:id`
- `POST /api/telegram/webhook/:botId` (inbound webhook endpoint from Telegram)

## Generic event flow

1. Inspect event options: `GET /api/webhooks/events`.
2. Create webhook with destination URL and selected events.
3. Deliveries are monitored through `/api/webhooks/:id/deliveries`.
4. Retry delivery manually with `/api/webhook-deliveries/:id/retry` if needed.

## Where to verify exact schemas

- `packages/backend/src/routes/webhooks.ts`
- `packages/backend/src/routes/connectors.ts`
- `packages/backend/src/routes/telegram.ts`
- `packages/backend/src/services/webhook-delivery.ts`
- `packages/backend/src/services/connectors.ts`

