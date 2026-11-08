import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError } from './errors.js';
import { registerRoutes } from './routes/index.js';

const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers["x-setup-token"]',
  'body.password',
  'body.newPassword',
];

export async function buildApp(
  options: { logger?: boolean | { level: string } } = {},
): Promise<FastifyInstance> {
  const logger =
    options.logger === false
      ? false
      : typeof options.logger === 'object'
        ? { ...options.logger, redact: LOG_REDACT }
        : { level: config.LOG_LEVEL, redact: LOG_REDACT };
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'), false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-setup-token', 'idempotency-key'],
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    allowList: config.NODE_ENV === 'test' ? ['127.0.0.1', '::1'] : [],
  });

  // Keep the raw payload so webhook signatures can be verified byte for byte.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (!req.url.startsWith('/api/v1/webhooks/')) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    (req as typeof req & { rawBody?: string }).rawBody = raw;
    const { Readable } = await import('node:stream');
    return Readable.from([Buffer.from(raw)]);
  });

  app.setErrorHandler((rawError, req, reply) => {
    if (rawError instanceof AppError) {
      return reply.status(rawError.statusCode).send({
        error: { code: rawError.code, message: rawError.message, details: rawError.details },
      });
    }
    if (rawError instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: rawError.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
          details: rawError.issues,
        },
      });
    }
    const error = rawError as Error & {
      code?: string;
      constraint?: string;
      detail?: string;
      statusCode?: number;
      validation?: unknown;
    };
    const pgError = error as { code?: string; constraint?: string; detail?: string; statusCode?: number };
    const mapped: Record<string, { status: number; code: string; message: string }> = {
      '23505': { status: 409, code: 'DUPLICATE_RECORD', message: 'That record already exists' },
      '23503': { status: 400, code: 'INVALID_REFERENCE', message: 'Referenced record does not exist' },
      '23514': { status: 400, code: 'CONSTRAINT_VIOLATION', message: 'A data constraint rejected this request' },
      '23P01': { status: 409, code: 'CONFLICT', message: 'That time slot conflicts with an existing record' },
      '42501': { status: 403, code: 'NOT_AUTHORIZED_DB', message: 'Database permission denied' },
    };
    if (pgError.code && mapped[pgError.code]) {
      const m = mapped[pgError.code]!;
      return reply.status(m.status).send({
        error: {
          code: m.code,
          message: m.message,
          details: config.isProduction ? undefined : { constraint: pgError.constraint, detail: pgError.detail },
        },
      });
    }
    if (pgError.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    }
    if (error.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: error.message, details: error.validation },
      });
    }
    req.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  await registerRoutes(app);
  return app;
}
