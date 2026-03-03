import 'dotenv/config';
import { z } from 'zod/v4';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),

  DATA_DIR: z.string().default('./data'),

  // JWT
  JWT_SECRET: z.string().min(32).default('change-me-to-a-real-secret-in-production!!'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  CORS_ORIGIN: z.string().default('https://localhost:5173'),

  // HTTPS — paths to TLS cert/key (relative to project root or absolute)
  TLS_CERT_PATH: z.string().optional(),
  TLS_KEY_PATH: z.string().optional(),

  // Telegram
  TELEGRAM_WEBHOOK_BASE_URL: z.string().url().optional(),

  // WhatsApp Business API
  WHATSAPP_WEBHOOK_BASE_URL: z.string().url().optional(),

  // Instagram / Facebook Messenger
  INSTAGRAM_WEBHOOK_BASE_URL: z.string().url().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),

  // Media / file uploads
  UPLOAD_DIR: z.string().default('./uploads'),

  // Backups
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_CRON: z.string().default('0 2 * * *'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  BACKUP_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  // Rate limiting
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(10000),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().default(10000),
  RATE_LIMIT_API_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Email sync
  EMAIL_SYNC_CRON: z.string().default('*/2 * * * *'),
  EMAIL_SYNC_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
