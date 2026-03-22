import { store } from '../../db/index.js';
import { env } from '../../config/env.js';
import {
  connectBot,
  disconnectBot,
  refreshWebhook,
  updateAutoGreeting,
} from '../telegram.js';
import type { ConnectorAdapter, ConnectorSeed, IntegrationStatus, AuditCtx } from './types.js';

function readStatus(integrationId: string): IntegrationStatus {
  const bot = store.getById('telegramBots', integrationId);
  if (!bot) {
    return { status: 'error', statusMessage: 'Bot record not found', settings: {} };
  }
  return {
    status: bot.status as 'active' | 'inactive' | 'error',
    statusMessage: (bot.statusMessage as string) ?? null,
    settings: {
      autoGreetingEnabled: bot.autoGreetingEnabled ?? false,
      autoGreetingText: bot.autoGreetingText ?? null,
      ngrokUrl: (bot.ngrokUrl as string) ?? null,
      ngrokAuto: bot.ngrokAuto ?? false,
    },
  };
}

export const telegramAdapter: ConnectorAdapter = {
  async connect(payload, audit) {
    const ngrokUrl = (payload.ngrokUrl as string | undefined) || undefined;
    const requestedMode = payload.setupMode === 'custom' ? 'custom' : 'managed';
    const token = requestedMode === 'custom'
      ? payload.token as string | undefined
      : env.TELEGRAM_MANAGED_BOT_TOKEN;

    if (!token) {
      throw new Error(
        requestedMode === 'custom'
          ? 'Bot token is required for a custom Telegram bot'
          : 'Managed Telegram bot is not configured. Set TELEGRAM_MANAGED_BOT_TOKEN and try again.',
      );
    }

    const bot = await connectBot(token, audit, { ngrokUrl }) as Record<string, unknown>;

    const seed: ConnectorSeed = {
      name: bot.botFirstName as string,
      integrationId: bot.id as string,
      capabilities: ['messaging'],
      config: {
        setupMode: requestedMode,
        botUsername: bot.botUsername,
        tokenMasked: bot.tokenMasked,
      },
      status: bot.status as 'active' | 'inactive' | 'error',
      statusMessage: (bot.statusMessage as string) ?? null,
      settings: {
        autoGreetingEnabled: false,
        autoGreetingText: null,
      },
    };

    return seed;
  },

  async disconnect(integrationId, audit) {
    await disconnectBot(integrationId, audit);
  },

  async refresh(integrationId, audit) {
    await refreshWebhook(integrationId, audit);
    return readStatus(integrationId);
  },

  getStatus(integrationId) {
    return readStatus(integrationId);
  },

  async updateSettings(integrationId, settings, audit) {
    await updateAutoGreeting(
      integrationId,
      {
        enabled: settings.autoGreetingEnabled as boolean,
        text: (settings.autoGreetingText as string | null | undefined) ?? null,
      },
      audit,
    );

    // Handle ngrok settings changes
    if ('ngrokAuto' in settings && settings.ngrokAuto) {
      await refreshWebhook(integrationId, audit, { ngrokUrl: 'auto' });
    } else if ('ngrokUrl' in settings || ('ngrokAuto' in settings && !settings.ngrokAuto)) {
      const newNgrokUrl = (settings.ngrokUrl as string | null) || undefined;
      await refreshWebhook(integrationId, audit, { ngrokUrl: newNgrokUrl ?? '' });
    }

    return readStatus(integrationId);
  },
};
