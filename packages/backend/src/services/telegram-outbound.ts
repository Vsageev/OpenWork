import fs from 'node:fs';
import { store } from '../db/index.js';
import { findFirstActiveTelegramBot } from '../db/repositories/telegram-bots-repository.js';
import { updateMessageStatus } from './messages.js';

const TELEGRAM_API = 'https://api.telegram.org';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type ParseMode = 'HTML' | 'MarkdownV2';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramSentMessage {
  message_id: number;
  chat: { id: number };
  date: number;
  text?: string;
}

export interface SendTelegramMessageParams {
  conversationId: string;
  messageId: string;
  text: string;
  parseMode?: ParseMode;
  inlineKeyboard?: InlineKeyboardButton[][];
}

export interface SendTelegramMessageResult {
  ok: boolean;
  telegramMessageId?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function telegramPost<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramApiResponse<T>> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as TelegramApiResponse<T>;
}

/**
 * Resolve the bot token and Telegram chat ID for a conversation.
 * Returns null if the conversation is not a Telegram channel or no active bot exists.
 */
async function resolveConversationBot(conversationId: string) {
  const conversation = store.getById('conversations', conversationId);

  if (!conversation || conversation.channelType !== 'telegram' || !conversation.externalId) {
    return null;
  }

  // Find an active Telegram bot to send with
  const bot = await findFirstActiveTelegramBot();

  if (!bot) return null;

  return { token: bot.token as string, chatId: conversation.externalId as string };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a text message (with optional formatting and inline keyboard) via Telegram.
 * Updates message status to 'sent' or 'failed' based on the result.
 */
export async function sendTelegramMessage(
  params: SendTelegramMessageParams,
): Promise<SendTelegramMessageResult> {
  const resolved = await resolveConversationBot(params.conversationId);

  if (!resolved) {
    await updateMessageStatus(params.messageId, 'failed');
    return { ok: false, error: 'Not a Telegram conversation or no active bot' };
  }

  const { token, chatId } = resolved;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: params.text,
  };

  if (params.parseMode) {
    body.parse_mode = params.parseMode;
  }

  if (params.inlineKeyboard && params.inlineKeyboard.length > 0) {
    body.reply_markup = {
      inline_keyboard: params.inlineKeyboard,
    } satisfies InlineKeyboardMarkup;
  }

  try {
    const result = await telegramPost<TelegramSentMessage>(token, 'sendMessage', body);

    if (!result.ok) {
      await updateMessageStatus(params.messageId, 'failed');
      return { ok: false, error: result.description ?? 'Telegram API error' };
    }

    // Update message with Telegram's message_id and mark as sent
    store.update('messages', params.messageId, {
      externalId: String(result.result!.message_id),
      status: 'sent',
    });

    return { ok: true, telegramMessageId: result.result!.message_id };
  } catch (err) {
    await updateMessageStatus(params.messageId, 'failed');
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to send Telegram message',
    };
  }
}

/**
 * Answer a callback query (acknowledge inline button press).
 */
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert?: boolean,
): Promise<boolean> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };
  if (text) body.text = text;
  if (showAlert) body.show_alert = true;

  const result = await telegramPost<boolean>(botToken, 'answerCallbackQuery', body);
  return result.ok;
}

/**
 * Edit an existing Telegram message text (and optionally its inline keyboard).
 */
export async function editTelegramMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  parseMode?: ParseMode,
  inlineKeyboard?: InlineKeyboardButton[][],
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };

  if (parseMode) body.parse_mode = parseMode;

  if (inlineKeyboard && inlineKeyboard.length > 0) {
    body.reply_markup = { inline_keyboard: inlineKeyboard } satisfies InlineKeyboardMarkup;
  }

  const result = await telegramPost<TelegramSentMessage>(botToken, 'editMessageText', body);
  return result.ok;
}

// ---------------------------------------------------------------------------
// Media sending
// ---------------------------------------------------------------------------

export interface SendTelegramMediaParams {
  conversationId: string;
  messageId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  type: 'image' | 'video' | 'document' | 'voice';
  caption?: string;
}

export interface SendTelegramMediaResult {
  ok: boolean;
  telegramMessageId?: number;
  error?: string;
}

/**
 * Send a media file (photo, video, document, or voice) via Telegram.
 * Uses multipart/form-data to upload the file directly.
 */
export async function sendTelegramMedia(
  params: SendTelegramMediaParams,
): Promise<SendTelegramMediaResult> {
  const resolved = await resolveConversationBot(params.conversationId);

  if (!resolved) {
    await updateMessageStatus(params.messageId, 'failed');
    return { ok: false, error: 'Not a Telegram conversation or no active bot' };
  }

  const { token, chatId } = resolved;

  // Map type to Telegram API method and form field name
  const methodMap: Record<string, { method: string; field: string }> = {
    image: { method: 'sendPhoto', field: 'photo' },
    video: { method: 'sendVideo', field: 'video' },
    voice: { method: 'sendVoice', field: 'voice' },
    document: { method: 'sendDocument', field: 'document' },
  };

  const { method, field } = methodMap[params.type] || methodMap.document;

  try {
    // Build multipart form data
    const formData = new FormData();
    formData.append('chat_id', chatId);

    if (params.caption) {
      formData.append('caption', params.caption);
    }

    // Read file and create a Blob
    const fileBuffer = fs.readFileSync(params.filePath);
    const blob = new Blob([fileBuffer], { type: params.mimeType });
    formData.append(field, blob, params.fileName);

    const url = `${TELEGRAM_API}/bot${token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    const data = (await res.json()) as TelegramApiResponse<TelegramSentMessage>;

    if (!data.ok) {
      await updateMessageStatus(params.messageId, 'failed');
      return { ok: false, error: data.description ?? 'Telegram API error' };
    }

    // Update message with Telegram's message_id and mark as sent
    store.update('messages', params.messageId, {
      externalId: String(data.result!.message_id),
      status: 'sent',
    });

    return { ok: true, telegramMessageId: data.result!.message_id };
  } catch (err) {
    await updateMessageStatus(params.messageId, 'failed');
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to send Telegram media',
    };
  }
}
