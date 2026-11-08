import nodemailer from 'nodemailer';
import type { AuthContext } from '../auth.js';
import { withTenant, type Queryable } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../errors.js';
import { auditAction } from '../audit.js';

/**
 * Notification queue and delivery worker.
 *
 * Messages are queued in `notification.messages` with status `queued`. A worker
 * (see `src/worker.ts`, or the manual `POST /api/v1/notifications/process`
 * tick) claims due messages with `FOR UPDATE SKIP LOCKED`, delivers them
 * outside the claim transaction, and records the outcome:
 *
 *   - `inapp`  always delivers (the recipient sees it in the application).
 *   - `email`  delivers over SMTP when `SMTP_HOST` is configured; otherwise the
 *              attempt fails permanently with a "channel not configured" detail.
 *   - `sms`/`push` have no provider adapter wired yet, so delivery fails
 *              permanently with the same honest detail. No message is ever
 *              marked `sent` without a real delivery.
 *
 * Transient delivery failures (e.g. a momentarily unreachable SMTP relay)
 * retry with exponential backoff up to `NOTIFICATIONS_MAX_ATTEMPTS`, then the
 * message is terminally `failed` with `error_detail` recorded.
 */

export type NotificationChannel = 'email' | 'sms' | 'push' | 'inapp';

export interface ProcessResult {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
}

interface QueuedMessage {
  id: string;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  attempts: number;
}

class PermanentDeliveryError extends Error {}

/** Exact-message renderer for the email adapter configured check. */
export function channelConfigured(channel: NotificationChannel): boolean {
  switch (channel) {
    case 'inapp':
      return true;
    case 'email':
      return Boolean(config.SMTP_HOST);
    case 'sms':
    case 'push':
      return false;
  }
}

let mailTransport: ReturnType<typeof nodemailer.createTransport> | undefined;
function getMailTransport() {
  if (!mailTransport) {
    const port = config.SMTP_PORT;
    mailTransport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port,
      secure: config.SMTP_SECURE ?? port === 465,
      auth:
        config.SMTP_USER && config.SMTP_PASSWORD
          ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
          : undefined,
    });
  }
  return mailTransport;
}

async function deliver(message: QueuedMessage): Promise<void> {
  switch (message.channel) {
    case 'inapp':
      // In-app delivery is an in-database state change: reaching `sent` below
      // means the message is visible to the recipient's tenant.
      return;
    case 'email': {
      if (!channelConfigured('email')) {
        throw new PermanentDeliveryError(
          'email channel is not configured: set SMTP_HOST (and SMTP_USER / SMTP_PASSWORD) on the worker',
        );
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(message.recipient)) {
        throw new PermanentDeliveryError(`invalid email recipient: ${message.recipient}`);
      }
      await getMailTransport().sendMail({
        from: config.SMTP_FROM,
        to: message.recipient,
        subject: message.subject ?? '(no subject)',
        text: message.body,
      });
      return;
    }
    case 'sms':
    case 'push':
      throw new PermanentDeliveryError(
        `${message.channel} channel is not configured: no provider adapter is wired for this deployment`,
      );
  }
}

export async function queueMessage(
  db: Queryable,
  ctx: AuthContext,
  input: {
    channel: string;
    recipient: string;
    body: string;
    subject?: string;
    templateCode?: string;
    branchId?: string;
    relatedType?: string;
    relatedId?: string;
  },
): Promise<{ id: string; status: string }> {
  const channels: NotificationChannel[] = ['email', 'sms', 'push', 'inapp'];
  if (!channels.includes(input.channel as NotificationChannel)) {
    throw badRequest('channel must be one of email, sms, push, inapp');
  }
  if (!input.recipient?.trim()) throw badRequest('recipient is required');
  if (!input.body?.trim()) throw badRequest('body is required');

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification.messages
       (tenant_id, channel, recipient, template_code, subject, body, related_type, related_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      ctx.tenantId,
      input.channel,
      input.recipient.trim(),
      input.templateCode ?? null,
      input.subject ?? null,
      input.body,
      input.relatedType ?? null,
      input.relatedId ?? null,
    ],
  );
  const id = rows[0]!.id;
  await auditAction(db, ctx, 'notifications.message_queued', 'notification_message', id, {
    after: { channel: input.channel, recipient: input.recipient.trim() },
  });
  return { id, status: 'queued' };
}

export async function listMessages(
  db: Queryable,
  filter: { status?: string; limit?: number } = {},
) {
  const { rows } = await db.query(
    `SELECT id, channel, recipient, template_code, subject, body, status, attempts,
            related_type, related_id, error_detail, created_at, sent_at, next_attempt_at
       FROM notification.messages
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [filter.status ?? null, Math.min(filter.limit ?? 100, 500)],
  );
  return rows;
}

/**
 * Claims up to `limit` due messages for one tenant, delivers each, and records
 * the result. Claiming and outcome recording are separate short transactions,
 * so SMTP round-trips never hold row locks. A crash between the two simply
 * leaves the message leased: its `next_attempt_at` (set at claim time) makes
 * it due again for the next sweep.
 */
export async function processQueuedMessages(tenantId: string, limit = 100): Promise<ProcessResult> {
  const claimed = await withTenant(tenantId, async (db) => {
    const { rows } = await db.query<QueuedMessage>(
      `UPDATE notification.messages
          SET attempts = attempts + 1,
              next_attempt_at = now() + interval '5 minutes'
        WHERE id IN (
          SELECT id
            FROM notification.messages
           WHERE status = 'queued' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, channel, recipient, subject, body, attempts`,
      [Math.min(limit, 500)],
    );
    return rows;
  });

  const result: ProcessResult = { claimed: claimed.length, sent: 0, retrying: 0, failed: 0 };
  for (const message of claimed) {
    let errorMessage: string | undefined;
    let permanent = false;
    try {
      await deliver(message);
    } catch (err) {
      permanent = err instanceof PermanentDeliveryError;
      errorMessage = err instanceof Error ? err.message : 'unknown delivery error';
    }

    const terminal = permanent || message.attempts >= config.NOTIFICATIONS_MAX_ATTEMPTS;
    await withTenant(tenantId, async (db) => {
      if (!errorMessage) {
        await db.query(
          `UPDATE notification.messages
              SET status = 'sent', sent_at = now(), error_detail = NULL
            WHERE id = $1`,
          [message.id],
        );
        result.sent += 1;
        return;
      }
      if (terminal) {
        await db.query(
          `UPDATE notification.messages
              SET status = 'failed', error_detail = $2
            WHERE id = $1`,
          [message.id, errorMessage],
        );
        result.failed += 1;
        return;
      }
      // Exponential backoff: 2, 4, 8, ... minutes, capped at an hour.
      const backoffMinutes = Math.min(60, 2 ** message.attempts);
      await db.query(
        `UPDATE notification.messages
            SET error_detail = $2,
                next_attempt_at = now() + ($3 || ' minutes')::interval
          WHERE id = $1`,
          [message.id, errorMessage, String(backoffMinutes)],
        );
      result.retrying += 1;
    });
  }
  return result;
}

/** Manual retry of a terminally failed (or cancelled) message. */
export async function requeueMessage(db: Queryable, ctx: AuthContext, id: string) {
  const { rows } = await db.query<{ status: string }>(
    `UPDATE notification.messages
        SET status = 'queued', attempts = 0, error_detail = NULL, next_attempt_at = now()
      WHERE id = $1 AND status IN ('failed', 'cancelled')
      RETURNING status`,
    [id],
  );
  if (!rows[0]) throw notFound('Message not found or not failed');
  await auditAction(db, ctx, 'notifications.message_requeued', 'notification_message', id);
  return { id, status: rows[0].status };
}
