import { store } from '../db/index.js';
import { getBotByTelegramId } from './telegram.js';
import { createConversation } from './conversations.js';
import { sendMessage, type SendMessageData } from './messages.js';
import { answerCallbackQuery, sendTelegramMessage } from './telegram-outbound.js';
import { eventBus } from './event-bus.js';

// ---------------------------------------------------------------------------
// Telegram Update types (subset we handle)
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  emoji?: string;
}

interface TelegramLocation {
  longitude: number;
  latitude: number;
}

interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  sticker?: TelegramSticker;
  location?: TelegramLocation;
  contact?: TelegramContact;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ---------------------------------------------------------------------------
// Webhook secret verification
// ---------------------------------------------------------------------------

/**
 * Verify that the incoming request has a valid webhook secret header.
 */
export function verifyWebhookSecret(
  headerSecret: string | undefined,
  botSecret: string | null,
): boolean {
  if (!botSecret) return false;
  return headerSecret === botSecret;
}

// ---------------------------------------------------------------------------
// Message type detection & attachment extraction
// ---------------------------------------------------------------------------

type MessageType = 'text' | 'image' | 'video' | 'document' | 'voice' | 'sticker' | 'location';

interface ParsedMessage {
  type: MessageType;
  content: string | null;
  attachments: Record<string, unknown>[] | null;
  metadata: Record<string, unknown>;
}

function parseInboundMessage(msg: TelegramMessage): ParsedMessage {
  const metadata: Record<string, unknown> = {
    telegram_message_id: msg.message_id,
    telegram_chat_id: msg.chat.id,
    telegram_date: msg.date,
  };

  if (msg.from) {
    metadata.telegram_from = {
      id: msg.from.id,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name,
      username: msg.from.username,
    };
  }

  // Photo – pick the largest resolution
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      type: 'image',
      content: msg.caption ?? null,
      attachments: [
        {
          type: 'photo',
          fileId: largest.file_id,
          fileUniqueId: largest.file_unique_id,
          width: largest.width,
          height: largest.height,
          fileSize: largest.file_size,
        },
      ],
      metadata,
    };
  }

  // Video
  if (msg.video) {
    return {
      type: 'video',
      content: msg.caption ?? null,
      attachments: [
        {
          type: 'video',
          fileId: msg.video.file_id,
          fileUniqueId: msg.video.file_unique_id,
          width: msg.video.width,
          height: msg.video.height,
          duration: msg.video.duration,
          mimeType: msg.video.mime_type,
          fileSize: msg.video.file_size,
        },
      ],
      metadata,
    };
  }

  // Voice
  if (msg.voice) {
    return {
      type: 'voice',
      content: msg.caption ?? null,
      attachments: [
        {
          type: 'voice',
          fileId: msg.voice.file_id,
          fileUniqueId: msg.voice.file_unique_id,
          duration: msg.voice.duration,
          mimeType: msg.voice.mime_type,
          fileSize: msg.voice.file_size,
        },
      ],
      metadata,
    };
  }

  // Audio (treated as document)
  if (msg.audio) {
    return {
      type: 'document',
      content: msg.caption ?? null,
      attachments: [
        {
          type: 'audio',
          fileId: msg.audio.file_id,
          fileUniqueId: msg.audio.file_unique_id,
          duration: msg.audio.duration,
          performer: msg.audio.performer,
          title: msg.audio.title,
          mimeType: msg.audio.mime_type,
          fileSize: msg.audio.file_size,
        },
      ],
      metadata,
    };
  }

  // Document
  if (msg.document) {
    return {
      type: 'document',
      content: msg.caption ?? null,
      attachments: [
        {
          type: 'document',
          fileId: msg.document.file_id,
          fileUniqueId: msg.document.file_unique_id,
          fileName: msg.document.file_name,
          mimeType: msg.document.mime_type,
          fileSize: msg.document.file_size,
        },
      ],
      metadata,
    };
  }

  // Sticker
  if (msg.sticker) {
    return {
      type: 'sticker',
      content: msg.sticker.emoji ?? null,
      attachments: [
        {
          type: 'sticker',
          fileId: msg.sticker.file_id,
          fileUniqueId: msg.sticker.file_unique_id,
          width: msg.sticker.width,
          height: msg.sticker.height,
          isAnimated: msg.sticker.is_animated,
          isVideo: msg.sticker.is_video,
          emoji: msg.sticker.emoji,
        },
      ],
      metadata,
    };
  }

  // Location
  if (msg.location) {
    return {
      type: 'location',
      content: `${msg.location.latitude}, ${msg.location.longitude}`,
      attachments: [
        {
          type: 'location',
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
        },
      ],
      metadata,
    };
  }

  // Shared contact (store as text with metadata)
  if (msg.contact) {
    metadata.shared_contact = {
      phone_number: msg.contact.phone_number,
      first_name: msg.contact.first_name,
      last_name: msg.contact.last_name,
      user_id: msg.contact.user_id,
    };
    return {
      type: 'text',
      content:
        `Shared contact: ${msg.contact.first_name} ${msg.contact.last_name ?? ''} (${msg.contact.phone_number})`.trim(),
      attachments: null,
      metadata,
    };
  }

  // Plain text (default)
  return {
    type: 'text',
    content: msg.text ?? null,
    attachments: null,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Contact resolution: find or create from Telegram user
// ---------------------------------------------------------------------------

function buildTelegramNotes(telegramUser: TelegramUser): string {
  const telegramUserId = String(telegramUser.id);
  return telegramUser.username
    ? `Telegram: @${telegramUser.username}`
    : `Telegram ID: ${telegramUserId}`;
}

async function syncContactFromTelegram(
  contact: Record<string, unknown>,
  telegramUser: TelegramUser,
) {
  const telegramUserId = String(telegramUser.id);
  const updates: Record<string, unknown> = {};

  // Backfill telegramId for contacts created before this migration
  if (!contact.telegramId) {
    updates.telegramId = telegramUserId;
  }

  // Sync name if the user changed it on Telegram
  if (contact.firstName !== telegramUser.first_name) {
    updates.firstName = telegramUser.first_name;
  }
  const newLastName = telegramUser.last_name ?? null;
  if (contact.lastName !== newLastName) {
    updates.lastName = newLastName;
  }

  if (Object.keys(updates).length > 0) {
    const updated = store.update('contacts', contact.id as string, updates);
    return updated ?? contact;
  }

  return contact;
}

async function findOrCreateContact(telegramUser: TelegramUser) {
  const telegramUserId = String(telegramUser.id);

  const directMatch = store
    .getAll('contacts')
    .find((r: Record<string, unknown>) => r.telegramId === telegramUserId);
  if (directMatch) {
    return syncContactFromTelegram(directMatch, telegramUser);
  }

  // Create a new contact from the Telegram user info.
  const contact = store.insert('contacts', {
    firstName: telegramUser.first_name,
    lastName: telegramUser.last_name ?? null,
    source: 'telegram',
    telegramId: telegramUserId,
    notes: buildTelegramNotes(telegramUser),
  });

  eventBus.emit('contact_created', {
    contactId: String(contact.id),
    contact: contact as unknown as Record<string, unknown>,
  });

  return contact;
}

// ---------------------------------------------------------------------------
// Conversation resolution: find or create for a chat
// ---------------------------------------------------------------------------

async function findOrCreateConversation(
  chatId: string,
  contactId: string,
  contact?: Record<string, unknown>,
) {
  const existing = store
    .getAll('conversations')
    .find((r) => r.channelType === 'telegram' && r.externalId === chatId);

  if (existing) return { conversation: existing, isNew: false };

  const conversation = await createConversation({
    contactId,
    channelType: 'telegram',
    externalId: chatId,
    status: 'open',
  });

  // Emit automation trigger for new conversations from Telegram (enriched for routing rules)
  const tagNames: string[] = [];
  eventBus.emit('conversation_created', {
    conversationId: conversation.id as string,
    contactId,
    conversation: conversation as unknown as Record<string, unknown>,
    contact: { ...(contact ?? {}), tagNames } as unknown as Record<string, unknown>,
  });

  return { conversation, isNew: true };
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

export interface WebhookResult {
  ok: boolean;
  messageId?: string;
  conversationId?: string;
  error?: string;
}

/**
 * Process an incoming Telegram webhook update.
 * Handles messages and edited messages: texts, media, voice, etc.
 */
export async function handleTelegramWebhook(
  botId: string,
  secretHeader: string | undefined,
  update: TelegramUpdate,
): Promise<WebhookResult> {
  // 1. Look up the bot
  const bot = await getBotByTelegramId(botId);
  if (!bot) {
    return { ok: false, error: 'Bot not found' };
  }

  // 2. Verify webhook secret
  if (!verifyWebhookSecret(secretHeader, bot.webhookSecret as string | null)) {
    return { ok: false, error: 'Invalid webhook secret' };
  }

  // 3. Handle callback_query (inline button clicks)
  if (update.callback_query) {
    return handleCallbackQuery(bot.token as string, update.callback_query);
  }

  // 4. Extract the message (support both new and edited messages)
  const telegramMessage = update.message ?? update.edited_message;
  if (!telegramMessage) {
    // No message to handle (could be other update types)
    return { ok: true };
  }

  // 5. Must have a sender
  if (!telegramMessage.from || telegramMessage.from.is_bot) {
    return { ok: true }; // Ignore messages from bots
  }

  // 6. Find or create the contact
  const contact = await findOrCreateContact(telegramMessage.from);

  // 7. Find or create the conversation
  const chatId = String(telegramMessage.chat.id);
  const { conversation, isNew: isNewConversation } = await findOrCreateConversation(
    chatId,
    contact.id as string,
    contact as unknown as Record<string, unknown>,
  );

  // 8. Parse the message
  const parsed = parseInboundMessage(telegramMessage);

  // 9. Store in our messages table
  const messageData: SendMessageData = {
    conversationId: conversation.id as string,
    direction: 'inbound',
    type: parsed.type,
    content: parsed.content ?? undefined,
    externalId: String(telegramMessage.message_id),
    attachments: parsed.attachments ?? undefined,
    metadata: JSON.stringify(parsed.metadata),
  };

  const message = await sendMessage(messageData);

  if (!message) {
    return { ok: false, error: 'Failed to store message' };
  }

  // Emit automation trigger for inbound message (enriched for routing rules)
  const contactTagNames: string[] = [];
  eventBus.emit('message_received', {
    messageId: message.id as string,
    conversationId: conversation.id as string,
    contactId: contact.id as string,
    message: message as unknown as Record<string, unknown>,
    contact: { ...contact, tagNames: contactTagNames } as unknown as Record<string, unknown>,
    conversation: conversation as unknown as Record<string, unknown>,
  });

  // 10. Reopen conversation if it was closed
  if (conversation.status === 'closed' || conversation.status === 'archived') {
    store.update('conversations', conversation.id as string, { status: 'open', closedAt: null });
  }

  // 11. Auto-greeting for new conversations
  if (isNewConversation && bot.autoGreetingEnabled && bot.autoGreetingText) {
    const greetingMessage = await sendMessage({
      conversationId: conversation.id as string,
      direction: 'outbound',
      type: 'text',
      content: bot.autoGreetingText as string,
      metadata: JSON.stringify({ autoGreeting: true }),
    });

    if (greetingMessage) {
      sendTelegramMessage({
        conversationId: conversation.id as string,
        messageId: greetingMessage.id as string,
        text: bot.autoGreetingText as string,
      }).catch(() => {
        // Fire-and-forget — status tracked via message record
      });
    }
  }

  return {
    ok: true,
    messageId: message.id as string,
    conversationId: conversation.id as string,
  };
}

// ---------------------------------------------------------------------------
// Callback query handler (inline button clicks)
// ---------------------------------------------------------------------------

async function handleCallbackQuery(
  botToken: string,
  callbackQuery: TelegramCallbackQuery,
): Promise<WebhookResult> {
  // Acknowledge the button press immediately
  await answerCallbackQuery(botToken, callbackQuery.id);

  if (!callbackQuery.message || !callbackQuery.data) {
    return { ok: true };
  }

  const chatId = String(callbackQuery.message.chat.id);

  // Find the conversation for this chat
  const conversation = store
    .getAll('conversations')
    .find((r) => r.channelType === 'telegram' && r.externalId === chatId);

  if (!conversation) {
    return { ok: true };
  }

  // Find or create contact from the user who clicked
  await findOrCreateContact(callbackQuery.from);

  // Store the button click as an inbound system message
  const message = await sendMessage({
    conversationId: conversation.id as string,
    direction: 'inbound',
    type: 'system',
    content: `Clicked button: ${callbackQuery.data}`,
    metadata: JSON.stringify({
      telegram_callback_query_id: callbackQuery.id,
      telegram_callback_data: callbackQuery.data,
      telegram_message_id: callbackQuery.message.message_id,
      telegram_from: {
        id: callbackQuery.from.id,
        first_name: callbackQuery.from.first_name,
        last_name: callbackQuery.from.last_name,
        username: callbackQuery.from.username,
      },
    }),
  });

  return {
    ok: true,
    messageId: message?.id as string | undefined,
    conversationId: conversation.id as string,
  };
}
