import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { store } from '../db/index.js';
import { env } from '../config/env.js';
import { promptRateLimiter } from './agent-chat.js';
import { getProjectSettings, updateProjectSettings } from '../services/project-settings.js';

const SETTINGS_COLLECTION = 'settings';
const RATE_LIMIT_SETTINGS_ID = 'rate-limits';

interface RateLimitSettings {
  id: string;
  agentPromptMax: number;
  agentPromptWindowS: number;
  createdAt: string;
  updatedAt: string;
}

function getRateLimitSettings(): RateLimitSettings {
  const existing = store.getById(SETTINGS_COLLECTION, RATE_LIMIT_SETTINGS_ID) as RateLimitSettings | null;
  if (existing) return existing;
  return {
    id: RATE_LIMIT_SETTINGS_ID,
    agentPromptMax: env.RATE_LIMIT_AGENT_PROMPT_MAX,
    agentPromptWindowS: env.RATE_LIMIT_AGENT_PROMPT_WINDOW_S,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function initRateLimiterFromSettings(): void {
  const settings = getRateLimitSettings();
  promptRateLimiter.reconfigure(settings.agentPromptMax, settings.agentPromptWindowS * 1000);
}

export async function settingsRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/settings/rate-limits
  typedApp.get(
    '/api/settings/rate-limits',
    { onRequest: [app.authenticate, requirePermission('settings:read')] },
    async () => {
      const settings = getRateLimitSettings();
      return {
        agentPromptMax: settings.agentPromptMax,
        agentPromptWindowS: settings.agentPromptWindowS,
      };
    },
  );

  // GET /api/settings/agent-defaults
  typedApp.get(
    '/api/settings/agent-defaults',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get project-level default agent settings',
      },
    },
    async () => {
      const settings = getProjectSettings();
      return {
        defaultAgentKeyId: settings.defaultAgentKeyId,
      };
    },
  );

  // PATCH /api/settings/agent-defaults
  typedApp.patch(
    '/api/settings/agent-defaults',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Settings'],
        summary: 'Update project-level default agent settings',
        body: z
          .object({
            defaultAgentKeyId: z.uuid().nullable().optional(),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      if (request.body.defaultAgentKeyId) {
        const apiKey = store.getById('apiKeys', request.body.defaultAgentKeyId);
        if (!apiKey || apiKey.isActive === false) {
          return reply.badRequest('Default agent key not found or inactive');
        }
        if ((apiKey.createdById as string) !== request.user.sub) {
          return reply.forbidden('Not authorized to use this API key');
        }
      }

      const updated = updateProjectSettings({
        ...(request.body.defaultAgentKeyId !== undefined
          ? { defaultAgentKeyId: request.body.defaultAgentKeyId }
          : {}),
      });

      return {
        defaultAgentKeyId: updated.defaultAgentKeyId,
      };
    },
  );

  // GET /api/settings/fallback-model
  typedApp.get(
    '/api/settings/fallback-model',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get global fallback model settings',
      },
    },
    async () => {
      const settings = getProjectSettings();
      return {
        fallbackModel: settings.fallbackModel,
        fallbackModelId: settings.fallbackModelId,
      };
    },
  );

  // PATCH /api/settings/fallback-model
  typedApp.patch(
    '/api/settings/fallback-model',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Settings'],
        summary: 'Update global fallback model settings',
        body: z
          .object({
            fallbackModel: z.string().nullable().optional(),
            fallbackModelId: z.string().nullable().optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const updated = updateProjectSettings({
        ...(request.body.fallbackModel !== undefined
          ? { fallbackModel: request.body.fallbackModel }
          : {}),
        ...(request.body.fallbackModelId !== undefined
          ? { fallbackModelId: request.body.fallbackModelId }
          : {}),
      });

      return {
        fallbackModel: updated.fallbackModel,
        fallbackModelId: updated.fallbackModelId,
      };
    },
  );

  // GET /api/settings/chat
  typedApp.get(
    '/api/settings/chat',
    {
      onRequest: [app.authenticate, requirePermission('settings:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get chat composer settings',
      },
    },
    async () => {
      const settings = getProjectSettings();
      return {
        autoAttachOversizedPasteAsTextFile: settings.autoAttachOversizedPasteAsTextFile,
      };
    },
  );

  // PATCH /api/settings/chat
  typedApp.patch(
    '/api/settings/chat',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        tags: ['Settings'],
        summary: 'Update chat composer settings',
        body: z
          .object({
            autoAttachOversizedPasteAsTextFile: z.boolean().optional(),
            autoConvertLargePastedTextToAttachment: z.boolean().optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const updated = updateProjectSettings({
        ...(request.body.autoAttachOversizedPasteAsTextFile !== undefined
          ? {
              autoAttachOversizedPasteAsTextFile:
                request.body.autoAttachOversizedPasteAsTextFile,
            }
          : request.body.autoConvertLargePastedTextToAttachment !== undefined
            ? {
                autoAttachOversizedPasteAsTextFile:
                  request.body.autoConvertLargePastedTextToAttachment,
              }
          : {}),
      });

      return {
        autoAttachOversizedPasteAsTextFile:
          updated.autoAttachOversizedPasteAsTextFile,
      };
    },
  );

  // PATCH /api/settings/rate-limits
  typedApp.patch(
    '/api/settings/rate-limits',
    {
      onRequest: [app.authenticate, requirePermission('settings:update')],
      schema: {
        body: z.object({
          agentPromptMax: z.number().int().min(1).max(1000).optional(),
          agentPromptWindowS: z.number().int().min(5).max(3600).optional(),
        }),
      },
    },
    async (request) => {
      const { agentPromptMax, agentPromptWindowS } = request.body;
      const existing = store.getById(SETTINGS_COLLECTION, RATE_LIMIT_SETTINGS_ID);

      const current = getRateLimitSettings();
      const updated = {
        ...current,
        agentPromptMax: agentPromptMax ?? current.agentPromptMax,
        agentPromptWindowS: agentPromptWindowS ?? current.agentPromptWindowS,
      };

      if (existing) {
        store.update(SETTINGS_COLLECTION, RATE_LIMIT_SETTINGS_ID, updated as unknown as Record<string, unknown>);
      } else {
        store.insert(SETTINGS_COLLECTION, updated as unknown as Record<string, unknown>);
      }

      // Apply to running rate limiter
      promptRateLimiter.reconfigure(updated.agentPromptMax, updated.agentPromptWindowS * 1000);

      return {
        agentPromptMax: updated.agentPromptMax,
        agentPromptWindowS: updated.agentPromptWindowS,
      };
    },
  );
}
