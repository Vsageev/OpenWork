import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import {
  connectBot,
  disconnectBot,
  listBots,
  getBotById,
  refreshWebhook,
  updateAutoGreeting,
} from '../services/telegram.js';
import { handleTelegramWebhook, type TelegramUpdate } from '../services/telegram-webhook.js';

const connectBotBody = z.object({
  token: z.string().min(1, 'Bot token is required'),
});

const autoGreetingBody = z.object({
  enabled: z.boolean(),
  text: z.string().max(4096).nullable().optional(),
});

export async function telegramRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List connected bots
  typedApp.get(
    '/api/telegram/bots',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Telegram'],
        summary: 'List connected Telegram bots',
      },
    },
    async (_request, reply) => {
      const bots = await listBots();
      return reply.send({ entries: bots });
    },
  );

  // Get single bot
  typedApp.get(
    '/api/telegram/bots/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Telegram'],
        summary: 'Get single Telegram bot',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const bot = await getBotById(request.params.id);
      if (!bot) {
        return reply.notFound('Telegram bot not found');
      }
      return reply.send(bot);
    },
  );

  // Connect a new bot
  typedApp.post(
    '/api/telegram/bots',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Telegram'],
        summary: 'Connect a new Telegram bot',
        body: connectBotBody,
      },
    },
    async (request, reply) => {
      try {
        const bot = await connectBot(request.body.token, {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        });
        return reply.status(201).send(bot);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to connect bot';
        return reply.badRequest(message);
      }
    },
  );

  // Disconnect (delete) a bot
  typedApp.delete(
    '/api/telegram/bots/:id',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Telegram'],
        summary: 'Disconnect a Telegram bot',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = await disconnectBot(request.params.id, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!deleted) {
        return reply.notFound('Telegram bot not found');
      }

      return reply.status(204).send();
    },
  );

  // Refresh webhook for a bot
  typedApp.post(
    '/api/telegram/bots/:id/refresh-webhook',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Telegram'],
        summary: 'Refresh webhook for a Telegram bot',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      try {
        const bot = await refreshWebhook(request.params.id, {
          userId: request.user.sub,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        });

        if (!bot) {
          return reply.notFound('Telegram bot not found');
        }

        return reply.send(bot);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to refresh webhook';
        return reply.badRequest(message);
      }
    },
  );

  // Update auto-greeting settings for a bot
  typedApp.patch(
    '/api/telegram/bots/:id/auto-greeting',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Telegram'],
        summary: 'Update auto-greeting settings for a bot',
        params: z.object({ id: z.uuid() }),
        body: autoGreetingBody,
      },
    },
    async (request, reply) => {
      const bot = await updateAutoGreeting(request.params.id, request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!bot) {
        return reply.notFound('Telegram bot not found');
      }

      return reply.send(bot);
    },
  );

  // Telegram webhook endpoint — receives inbound updates from Telegram
  // No auth middleware: verified by webhook secret header instead
  typedApp.post(
    '/api/telegram/webhook/:botId',
    {
      schema: {
        tags: ['Telegram'],
        summary: 'Telegram webhook endpoint',
        // Telegram posts to webhook URLs that include its numeric bot ID.
        params: z.object({ botId: z.string().regex(/^\d+$/, 'Invalid Telegram bot ID') }),
      },
    },
    async (request, reply) => {
      const { botId } = request.params;
      const secretHeader = request.headers['x-telegram-bot-api-secret-token'] as string | undefined;

      try {
        const result = await handleTelegramWebhook(
          botId,
          secretHeader,
          request.body as TelegramUpdate,
        );

        if (!result.ok && result.error === 'Invalid webhook secret') {
          return reply.forbidden('Invalid webhook secret');
        }

        if (!result.ok && result.error === 'Bot not found') {
          return reply.notFound('Bot not found');
        }

        // Always return 200 to Telegram to prevent retries
        return reply.send({ ok: true });
      } catch (err) {
        // Log the error but still return 200 to Telegram
        request.log.error(err, 'Telegram webhook processing error');
        return reply.send({ ok: true });
      }
    },
  );
}
