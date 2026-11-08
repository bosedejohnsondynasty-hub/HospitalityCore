import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

loadEnv({
  path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
  quiet: true,
});

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  APP_ORIGIN: z.string().default('http://localhost:3000'),
  // Development preview origins: Freebuff preview proxy hostname plus localhost.
  // Production sets this to the deployed origin.
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:3000,https://pv-3d8bcf9d0591-8fc23acc-652a-43ad-abe4-1b244e2267f8.style.dev',
    ),
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().optional(),
  APP_DB_USER: z.string().default('hospitality_app'),
  REQUIRE_RESTRICTED_DB_ROLE: bool,
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(480),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),
  SETUP_TOKEN: z.string().optional(),
  ALLOW_API_SETUP: bool,
  LOG_LEVEL: z.string().default('info'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_HASH: z.string().optional(),
  PAYMENTS_ALLOW_OFFLINE_VERIFY: bool,
  BACKUP_DIR: z.string().default('./backups'),
  // Notification delivery (worker). Email is sent only when an SMTP relay is
  // configured; sms/push adapters are intentionally not configured until a
  // provider is wired in. In-app messages are always deliverable.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Hospitality Core <noreply@localhost>'),
  NOTIFICATIONS_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  NOTIFICATIONS_POLL_SECONDS: z.coerce.number().int().positive().default(15),
  // Outbox relay (same worker process): domain events are claimed and fanned
  // out to the notification queue. Transient handler failures retry with
  // backoff up to this limit, then the event is terminally failed.
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  isProduction: parsed.data.NODE_ENV === 'production',
};

export type AppConfig = typeof config;
