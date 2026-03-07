import crypto from 'node:crypto';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { createAuditLog } from './audit-log.js';
import { startNgrokTunnel, stopNgrokTunnel, getNgrokTunnelUrl } from './ngrok.js';
import { validateWebhookUrl } from '../utils/url-validator.js';

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function telegramRequest<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const options: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(url, options);
  const data = (await res.json()) as TelegramApiResponse<T>;

  if (!data.ok) {
    throw new Error(data.description ?? `Telegram API error: ${method}`);
  }

  return data.result!;
}

function normalizeWebhookBaseUrl(rawUrl?: string | null): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const normalized = withProtocol.replace(/\/+$/, '');
  const validation = validateWebhookUrl(normalized);

  if (!validation.valid) {
    throw new Error(validation.error ?? 'Invalid webhook URL');
  }

  return normalized;
}

/**
 * Validate a bot token by calling Telegram's getMe endpoint.
 */
export async function validateBotToken(token: string): Promise<TelegramUser> {
  return telegramRequest<TelegramUser>(token, 'getMe');
}

/**
 * Register (set) the webhook URL for a Telegram bot.
 */
export async function setTelegramWebhook(
  token: string,
  webhookUrl: string,
  secret: string,
): Promise<void> {
  await telegramRequest(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
  });
}

/**
 * Remove the webhook for a Telegram bot.
 */
export async function removeTelegramWebhook(token: string): Promise<void> {
  await telegramRequest(token, 'deleteWebhook');
}

/**
 * Connect a new Telegram bot: validate token, store in DB, register webhook.
 */
export async function connectBot(
  token: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
  options?: { ngrokUrl?: string },
) {
  // 1. Validate token with Telegram
  const botInfo = await validateBotToken(token);

  // 2. Check if this bot is already connected
  const existing = store.findOne('telegramBots', r => r.botId === String(botInfo.id));

  if (existing) {
    throw new Error(`Bot @${botInfo.username ?? botInfo.id} is already connected`);
  }

  // 3. Generate webhook secret
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  // 4. Build webhook URL (per-bot ngrok URL takes priority over global env)
  //    ngrokUrl === 'auto' → start ngrok tunnel automatically
  let ngrokUrl: string | null = null;
  if (options?.ngrokUrl === 'auto') {
    const tunnelUrl = await startNgrokTunnel();
    ngrokUrl = tunnelUrl;
  } else {
    ngrokUrl = normalizeWebhookBaseUrl(options?.ngrokUrl);
  }
  const baseUrl = ngrokUrl || env.TELEGRAM_WEBHOOK_BASE_URL;
  let webhookUrl: string | null = null;
  if (baseUrl) {
    webhookUrl = `${baseUrl}/api/telegram/webhook/${botInfo.id}`;
  }

  // 5. Register webhook with Telegram (if base URL is configured)
  let status: 'active' | 'inactive' | 'error' = 'inactive';
  let statusMessage: string | null = null;

  if (webhookUrl) {
    try {
      await setTelegramWebhook(token, webhookUrl, webhookSecret);
      status = 'active';
    } catch (err) {
      status = 'error';
      statusMessage = err instanceof Error ? err.message : 'Failed to register webhook';
    }
  } else {
    statusMessage = 'TELEGRAM_WEBHOOK_BASE_URL not configured; webhook not registered';
  }

  // 6. Store bot in DB
  const ngrokAuto = options?.ngrokUrl === 'auto';
  const bot = store.insert('telegramBots', {
    token,
    botId: String(botInfo.id),
    botUsername: botInfo.username ?? String(botInfo.id),
    botFirstName: botInfo.first_name,
    webhookUrl,
    webhookSecret,
    ngrokUrl,
    ngrokAuto,
    status,
    statusMessage,
    createdById: audit?.userId,
  });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'telegram_bot',
      entityId: bot.id as string,
      changes: { botUsername: bot.botUsername, status },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return sanitizeBot(bot);
}

/**
 * Disconnect a Telegram bot: remove webhook, delete from DB.
 */
export async function disconnectBot(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const bot = store.getById('telegramBots', id);
  if (!bot) return null;

  // Remove webhook from Telegram
  try {
    await removeTelegramWebhook(bot.token as string);
  } catch {
    // Best effort — bot token may already be revoked
  }

  // Stop auto-managed ngrok tunnel if no other bots use it
  if (bot.ngrokAuto) {
    const otherAutoBots = store.getAll('telegramBots').filter(r => r.id !== id && r.ngrokAuto === true);
    if (otherAutoBots.length === 0) {
      await stopNgrokTunnel();
    }
  }

  const deleted = store.delete('telegramBots', id);

  if (deleted && audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'telegram_bot',
      entityId: id,
      changes: { botUsername: deleted.botUsername },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return deleted ? sanitizeBot(deleted) : null;
}

/**
 * List all connected Telegram bots.
 */
export async function listBots() {
  const bots = store.getAll('telegramBots');
  return bots.map(sanitizeBot);
}

/**
 * Get a single Telegram bot by ID.
 */
export async function getBotById(id: string) {
  const bot = store.getById('telegramBots', id);
  if (!bot) return null;
  return sanitizeBot(bot);
}

/**
 * Get a bot by its Telegram bot ID (for webhook routing).
 */
export async function getBotByTelegramId(botId: string) {
  const bot = store.findOne('telegramBots', r => r.botId === botId);
  return bot ?? null;
}

/**
 * Re-register the webhook for an existing bot (e.g. after URL change).
 */
export async function refreshWebhook(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
  options?: { ngrokUrl?: string },
) {
  const bot = store.getById('telegramBots', id);
  if (!bot) return null;

  // If a new ngrokUrl is provided, update it; otherwise use existing stored value
  let ngrokUrl: string | null;
  let ngrokAuto = bot.ngrokAuto as boolean | undefined;
  if (options?.ngrokUrl === 'auto') {
    const tunnelUrl = await startNgrokTunnel();
    ngrokUrl = tunnelUrl;
    ngrokAuto = true;
  } else if (options?.ngrokUrl !== undefined) {
    ngrokUrl = normalizeWebhookBaseUrl(options.ngrokUrl);
    ngrokAuto = false;
  } else if (bot.ngrokAuto) {
    // Re-use auto tunnel — get current URL or start new one
    const tunnelUrl = getNgrokTunnelUrl() ?? await startNgrokTunnel();
    ngrokUrl = tunnelUrl;
  } else {
    ngrokUrl = (bot.ngrokUrl as string | null);
  }
  const baseUrl = ngrokUrl || env.TELEGRAM_WEBHOOK_BASE_URL;

  if (!baseUrl) {
    throw new Error('No webhook base URL configured (set ngrok URL or TELEGRAM_WEBHOOK_BASE_URL)');
  }

  const webhookUrl = `${baseUrl}/api/telegram/webhook/${bot.botId}`;
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  let status: 'active' | 'inactive' | 'error' = 'inactive';
  let statusMessage: string | null = null;

  try {
    await setTelegramWebhook(bot.token as string, webhookUrl, webhookSecret);
    status = 'active';
  } catch (err) {
    status = 'error';
    statusMessage = err instanceof Error ? err.message : 'Failed to register webhook';
  }

  const updated = store.update('telegramBots', id, { webhookUrl, webhookSecret, ngrokUrl, ngrokAuto, status, statusMessage });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'telegram_bot',
      entityId: id,
      changes: { webhookUrl, status },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return updated ? sanitizeBot(updated) : null;
}

/**
 * Get file info from Telegram (for downloading media).
 * Returns the file path that can be used to construct a download URL.
 */
export async function getFileInfo(
  token: string,
  fileId: string,
): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }> {
  return telegramRequest(token, 'getFile', { file_id: fileId });
}

/**
 * Build a download URL for a Telegram file.
 */
export function buildFileUrl(token: string, filePath: string): string {
  return `${TELEGRAM_API}/file/bot${token}/${filePath}`;
}

/**
 * Update auto-greeting settings for a bot.
 */
export async function updateAutoGreeting(
  id: string,
  data: { enabled: boolean; text?: string | null },
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const bot = store.getById('telegramBots', id);
  if (!bot) return null;

  const updated = store.update('telegramBots', id, {
    autoGreetingEnabled: data.enabled,
    autoGreetingText: data.text ?? null,
  });

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'telegram_bot',
      entityId: id,
      changes: { autoGreetingEnabled: data.enabled, autoGreetingText: data.text },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return updated ? sanitizeBot(updated) : null;
}

/**
 * Re-establish managed ngrok tunnels/webhooks for bots that opted into auto mode.
 * This prevents Telegram delivery from silently breaking after a backend restart.
 */
export async function restoreManagedTelegramWebhooks(): Promise<void> {
  const autoBots = store.find('telegramBots', (r) => r.ngrokAuto === true);

  if (autoBots.length === 0) return;

  for (const bot of autoBots) {
    try {
      await refreshWebhook(bot.id as string);
      console.log(`[telegram] Restored managed webhook for bot ${(bot.botUsername as string) ?? (bot.botId as string)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(
        `[telegram] Failed to restore managed webhook for bot ${(bot.botUsername as string) ?? (bot.botId as string)}: ${message}`,
      );
    }
  }
}

/**
 * Strip the token from bot objects before returning to clients.
 */
function sanitizeBot(bot: Record<string, unknown>) {
  const { token, webhookSecret, ...safe } = bot;
  return { ...safe, tokenMasked: `${(token as string).slice(0, 5)}...${(token as string).slice(-4)}` };
}
