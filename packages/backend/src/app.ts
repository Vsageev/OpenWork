import fs from 'node:fs';
import path from 'node:path';
import type { SecureContextOptions } from 'node:tls';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { store } from './db/index.js';
import { registerCors } from './plugins/cors.js';
import { registerJwt } from './plugins/jwt.js';
import { registerBackupScheduler } from './plugins/backup-scheduler.js';
import { healthRoutes } from './routes/health.js';
import { backupRoutes } from './routes/backup.js';
import { authRoutes } from './routes/auth.js';
import { auditLogRoutes } from './routes/audit-logs.js';
import { tagRoutes } from './routes/tags.js';
import { conversationRoutes } from './routes/conversations.js';
import { messageRoutes } from './routes/messages.js';
import { telegramRoutes } from './routes/telegram.js';
import { mediaRoutes } from './routes/media.js';
import { widgetRoutes } from './routes/widget.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { webhookRoutes } from './routes/webhooks.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerSanitization } from './middleware/sanitize.js';
import { registerSecurityMiddleware } from './middleware/security.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { initWebhookDeliveryEngine } from './services/webhook-delivery.js';
import { messageDraftRoutes } from './routes/message-drafts.js';
import { connectorRoutes } from './routes/connectors.js';
import { permissionRoutes } from './routes/permissions.js';
import { registerIdempotency } from './middleware/idempotency.js';
import { collectionRoutes } from './routes/collections.js';
import { cardRoutes } from './routes/cards.js';
import { boardRoutes } from './routes/boards.js';
import { storageRoutes } from './routes/storage.js';
import { userRoutes } from './routes/users.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { agentRoutes } from './routes/agents.js';
import { agentChatRoutes } from './routes/agent-chat.js';
import { agentRunRoutes } from './routes/agent-runs.js';
import { settingsRoutes, initRateLimiterFromSettings } from './routes/settings.js';
import { initAllCronJobs, shutdownAgentCronJobs } from './services/agent-cron.js';
import { initAllBoardCronJobs } from './services/board-cron.js';
import { reconcileRunsOnStartup, cleanupOldRunLogs } from './services/agent-runs.js';
import { initializeAgentChatQueue, reattachRunningProcess, RUNS_DIR } from './services/agent-chat.js';
import { initializeAgentBatchQueue } from './services/agent-batch-queue.js';
import { restoreManagedTelegramWebhooks } from './services/telegram.js';

function buildHttpsOptions(): SecureContextOptions | undefined {
  if (!env.TLS_CERT_PATH || !env.TLS_KEY_PATH) return undefined;

  return {
    cert: fs.readFileSync(env.TLS_CERT_PATH),
    key: fs.readFileSync(env.TLS_KEY_PATH),
  };
}

export async function buildApp() {
  const https = buildHttpsOptions();

  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT_BYTES,
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'headers.authorization',
          'headers.cookie',
          'headers["x-api-key"]',
        ],
        censor: '[REDACTED]',
      },
    },
    ...(https ? { https } : {}),
  });

  // Initialize JSON store before anything else
  await store.init();

  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await registerCors(app);
  await registerJwt(app);
  await registerHelmet(app);
  await registerRateLimit(app);
  registerSanitization(app);
  registerSecurityMiddleware(app);
  registerErrorHandler(app);
  registerIdempotency(app);

  // Plugins
  await registerSwagger(app);
  await registerBackupScheduler(app);
  initWebhookDeliveryEngine();

  // Routes
  await app.register(healthRoutes);
  await app.register(backupRoutes);
  await app.register(authRoutes);
  await app.register(auditLogRoutes);
  await app.register(tagRoutes);
  await app.register(conversationRoutes);
  await app.register(messageRoutes);
  await app.register(messageDraftRoutes);
  await app.register(telegramRoutes);
  await app.register(mediaRoutes);
  await app.register(widgetRoutes);
  await app.register(apiKeyRoutes);
  await app.register(webhookRoutes);
  await app.register(connectorRoutes);
  await app.register(permissionRoutes);
  await app.register(collectionRoutes);
  await app.register(cardRoutes);
  await app.register(boardRoutes);
  await app.register(storageRoutes);
  await app.register(userRoutes);
  await app.register(workspaceRoutes);
  await app.register(agentRoutes);
  await app.register(agentChatRoutes);
  await app.register(agentRunRoutes);
  await app.register(settingsRoutes);

  // Serve frontend static files in production
  const staticDir = process.env.STATIC_DIR;
  if (staticDir && fs.existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: path.resolve(staticDir),
      prefix: '/',
      wildcard: false,
    });
    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // Apply persisted rate-limit settings to the in-memory limiter
  initRateLimiterFromSettings();

  // Restore Telegram webhooks for bots using backend-managed ngrok tunnels.
  await restoreManagedTelegramWebhooks();

  // Initialize agent cron jobs
  initAllCronJobs();

  // Initialize board cron template jobs
  initAllBoardCronJobs();

  // Gracefully stop cron schedulers during shutdown
  app.addHook('onClose', () => {
    shutdownAgentCronJobs();
  });

  // Ensure agent-runs log directory exists
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  // Clean old run logs, then reconcile running records (re-attach or mark dead)
  cleanupOldRunLogs();
  reconcileRunsOnStartup((run) => reattachRunningProcess(run));
  initializeAgentChatQueue({ preserveActiveProcessing: true });
  initializeAgentBatchQueue({ preserveActiveProcessing: true });

  return app;
}
