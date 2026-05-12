import { createHmac } from 'node:crypto';
import { store } from '../db/index.js';
import {
  getWebhookDeliveryRecordById,
  listWebhookDeliveriesNative,
} from '../db/repositories/webhooks-repository.js';
import { eventBus, type AppEventName } from './event-bus.js';
import { getActiveWebhooksByEvent } from './webhooks.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 5_000; // 5 seconds
const REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const RETRY_POLL_INTERVAL_MS = 30_000; // check for retries every 30s

// ---------------------------------------------------------------------------
// HMAC payload signing
// ---------------------------------------------------------------------------

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Delivery logic
// ---------------------------------------------------------------------------

async function deliver(
  webhookId: string,
  url: string,
  secret: string,
  event: string,
  payload: Record<string, unknown>,
  deliveryId?: string,
  attempt = 1,
): Promise<void> {
  const body = JSON.stringify({
    event,
    payload,
    timestamp: new Date().toISOString(),
  });
  const signature = signPayload(body, secret);

  // Create or reuse delivery record
  let id = deliveryId;
  if (!id) {
    const record = store.insert('webhookDeliveries', {
      webhookId,
      event,
      payload,
      status: 'pending',
      attempt,
      maxAttempts: MAX_ATTEMPTS,
    });
    id = record.id as string;
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': event,
        'X-Webhook-Delivery': id,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const responseStatus = res.status;
    const responseBody = (await res.text()).slice(0, 2048);

    const durationMs = Date.now() - start;

    if (res.ok) {
      store.update('webhookDeliveries', id, {
        status: 'success',
        responseStatus,
        responseBody,
        durationMs,
        attempt,
        completedAt: new Date(),
        nextRetryAt: null,
      });

      console.log(`[webhook] Delivered ${event} to ${url} (${res.status}) in ${durationMs}ms`);
      return;
    }

    // Non-2xx — schedule retry or mark failed
    await handleFailure(id, attempt, responseStatus, responseBody, durationMs);
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await handleFailure(id, attempt, null, errorMsg.slice(0, 2048), durationMs);
  }
}

async function handleFailure(
  deliveryId: string,
  attempt: number,
  responseStatus: number | null,
  responseBody: string | null,
  durationMs: number,
): Promise<void> {
  if (attempt < MAX_ATTEMPTS) {
    // Exponential backoff: 5s, 20s, 80s, 320s ...
    const backoffMs = INITIAL_BACKOFF_MS * Math.pow(4, attempt - 1);
    const nextRetryAt = new Date(Date.now() + backoffMs);

    store.update('webhookDeliveries', deliveryId, {
      status: 'pending',
      responseStatus,
      responseBody,
      durationMs,
      attempt,
      nextRetryAt,
    });

    console.log(
      `[webhook] Delivery ${deliveryId} failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying at ${nextRetryAt.toISOString()}`,
    );
  } else {
    store.update('webhookDeliveries', deliveryId, {
      status: 'failed',
      responseStatus,
      responseBody,
      durationMs,
      attempt,
      completedAt: new Date(),
      nextRetryAt: null,
    });

    console.error(
      `[webhook] Delivery ${deliveryId} permanently failed after ${MAX_ATTEMPTS} attempts`,
    );
  }
}

// ---------------------------------------------------------------------------
// Retry processor — polls for pending deliveries that are due for retry
// ---------------------------------------------------------------------------

async function processRetries(): Promise<void> {
  try {
    const now = new Date();
    const due = store
      .getAll('webhookDeliveries')
      .filter(
        (r) =>
          r.status === 'pending' &&
          r.nextRetryAt != null &&
          new Date(r.nextRetryAt as string).getTime() <= now.getTime(),
      )
      .slice(0, 50);

    if (due.length === 0) return;

    console.log(`[webhook] Processing ${due.length} pending retries`);

    for (const delivery of due) {
      const webhook = store.getById('webhooks', delivery.webhookId as string);

      if (!webhook || !webhook.isActive) {
        // Webhook was deleted or deactivated — mark delivery as failed
        store.update('webhookDeliveries', delivery.id as string, {
          status: 'failed',
          responseBody: 'Webhook deactivated or deleted',
          completedAt: new Date(),
          nextRetryAt: null,
        });
        continue;
      }

      const nextAttempt = (delivery.attempt as number) + 1;
      await deliver(
        webhook.id as string,
        webhook.url as string,
        webhook.secret as string,
        delivery.event as string,
        delivery.payload as Record<string, unknown>,
        delivery.id as string,
        nextAttempt,
      );
    }
  } catch (err) {
    console.error('[webhook] Error processing retries:', err);
  }
}

// ---------------------------------------------------------------------------
// Event bus listener — fan-out events to registered webhooks
// ---------------------------------------------------------------------------

const EVENTS: AppEventName[] = [
  'contact_created',
  'card_created',
  'card_moved',
  'message_received',
  'tag_added',
  'task_completed',
  'conversation_created',
];

let initialized = false;
let retryInterval: ReturnType<typeof setInterval> | null = null;

export function initWebhookDeliveryEngine() {
  if (initialized) return;
  initialized = true;

  for (const event of EVENTS) {
    eventBus.on(event, (payload) => {
      // Fire-and-forget: webhook delivery must not block the emitter
      dispatchEvent(event, payload as unknown as Record<string, unknown>).catch((err) => {
        console.error(`[webhook] Error dispatching "${event}":`, err);
      });
    });
  }

  // Start retry polling
  retryInterval = setInterval(() => {
    processRetries().catch((err) => {
      console.error('[webhook] Retry poll error:', err);
    });
  }, RETRY_POLL_INTERVAL_MS);

  console.log('[webhook] Delivery engine initialized — listening for events');
}

export function stopWebhookDeliveryEngine() {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}

async function dispatchEvent(event: AppEventName, payload: Record<string, unknown>) {
  const activeWebhooks = await getActiveWebhooksByEvent(event);

  if (activeWebhooks.length === 0) return;

  console.log(`[webhook] Dispatching "${event}" to ${activeWebhooks.length} webhook(s)`);

  await Promise.allSettled(
    activeWebhooks.map((webhook) =>
      deliver(
        webhook.id as string,
        webhook.url as string,
        webhook.secret as string,
        event,
        payload,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Query helpers — for delivery log endpoints
// ---------------------------------------------------------------------------

export interface DeliveryListQuery {
  webhookId?: string;
  event?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listDeliveries(query: DeliveryListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  return listWebhookDeliveriesNative({
    webhookId: query.webhookId,
    event: query.event,
    status: query.status,
    limit,
    offset,
  });
}

export async function getDeliveryById(id: string) {
  return (await getWebhookDeliveryRecordById(id)) ?? null;
}

export async function retryDelivery(id: string) {
  const delivery = await getDeliveryById(id);
  if (!delivery) return null;

  store.update('webhookDeliveries', id, {
    status: 'pending',
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    nextRetryAt: new Date(),
    completedAt: null,
  });

  return await getDeliveryById(id);
}
