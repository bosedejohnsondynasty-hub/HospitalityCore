import { withTenant } from '../db.js';
import { config } from '../config.js';

/**
 * Outbox relay.
 *
 * Domain services write transactional outbox events (`integration.outbox`)
 * inside the same transaction as the change they describe, so the event and
 * the state can never diverge. Nothing used to read those rows: events stayed
 * `pending` forever. This relay is the missing consumer.
 *
 * Per tenant it claims due events with `FOR UPDATE SKIP LOCKED` (a 5-minute
 * lease in `available_at`, so a crashed relay simply makes the event due
 * again — delivery is at-least-once), and dispatches each event outside the
 * claim transaction. Handlers translate events into notification messages for
 * the team that reacts to them; the notification worker then delivers those
 * through the normal queue. Event types with no registered consumer are
 * recorded as processed with a `no consumer registered` detail so operators
 * can find them, instead of accumulating forever.
 */

export interface RelayResult {
  claimed: number;
  processed: number;
  retrying: number;
  failed: number;
}

interface OutboxEvent {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Domain event → the team (notification recipient) that acts on it.
 * Keep bodies free of guest PII: ids only.
 */
function notificationForEvent(event: OutboxEvent): { recipient: string; subject: string; body: string } | null {
  const id = event.aggregate_id;
  switch (event.event_type) {
    case 'reservation.created':
      return {
        recipient: 'front-desk',
        subject: 'New reservation created',
        body: `Reservation ${id} was created.`,
      };
    case 'stay.checked_in':
      return {
        recipient: 'housekeeping',
        subject: 'Guest checked in',
        body: `Stay ${id} checked in.`,
      };
    case 'stay.checked_out':
      return {
        recipient: 'housekeeping',
        subject: 'Guest checked out',
        body: `Stay ${id} checked out — the room needs cleaning.`,
      };
    case 'night_audit.completed':
      return {
        recipient: 'finance',
        subject: 'Night audit completed',
        body: `Night audit completed for hotel ${id}.`,
      };
    case 'restaurant.order_placed':
      return {
        recipient: 'kitchen',
        subject: 'New restaurant order',
        body: `Restaurant order ${id} was placed.`,
      };
    case 'bar.order_created':
      return {
        recipient: 'bar-desk',
        subject: 'New bar order',
        body: `Bar order ${id} was created.`,
      };
    case 'restaurant.charged_to_folio':
      return {
        recipient: 'front-desk',
        subject: 'Restaurant order charged to folio',
        body: `Restaurant order ${id} was charged to a guest folio.`,
      };
    default:
      return null;
  }
}

export async function relayOnce(tenantId: string, limit = 100): Promise<RelayResult> {
  const claimed = await withTenant(tenantId, async (db) => {
    const { rows } = await db.query<OutboxEvent>(
      `UPDATE integration.outbox
          SET status = 'processing',
              attempts = attempts + 1,
              available_at = now() + interval '5 minutes'
        WHERE id IN (
          SELECT id
            FROM integration.outbox
           WHERE status IN ('pending', 'processing') AND available_at <= now()
           ORDER BY available_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_type, aggregate_type, aggregate_id, payload, attempts`,
      [Math.min(limit, 500)],
    );
    return rows;
  });

  const result: RelayResult = { claimed: claimed.length, processed: 0, retrying: 0, failed: 0 };
  for (const event of claimed) {
    let errorMessage: string | undefined;
    try {
      const fanOut = notificationForEvent(event);
      await withTenant(tenantId, async (db) => {
        if (fanOut) {
          await db.query(
            `INSERT INTO notification.messages
               (tenant_id, channel, recipient, subject, body, related_type, related_id)
             VALUES ($1, 'inapp', $2, $3, $4, $5, $6)`,
            [tenantId, fanOut.recipient, fanOut.subject, fanOut.body, event.aggregate_type, event.aggregate_id],
          );
        }
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'unknown relay error';
    }

    const terminal = Boolean(errorMessage) && event.attempts >= config.OUTBOX_MAX_ATTEMPTS;
    await withTenant(tenantId, async (db) => {
      if (!errorMessage) {
        const fanOut = notificationForEvent(event);
        await db.query(
          `UPDATE integration.outbox
              SET status = 'processed',
                  processed_at = now(),
                  last_error = $2
            WHERE id = $1`,
          [event.id, fanOut ? null : 'no consumer registered for this event type'],
        );
        result.processed += 1;
        return;
      }
      if (terminal) {
        await db.query(
          `UPDATE integration.outbox
              SET status = 'failed', last_error = $2
            WHERE id = $1`,
          [event.id, errorMessage],
        );
        result.failed += 1;
        return;
      }
      const backoffMinutes = Math.min(60, 2 ** event.attempts);
      await db.query(
        `UPDATE integration.outbox
            SET status = 'pending',
                last_error = $2,
                available_at = now() + ($3 || ' minutes')::interval
          WHERE id = $1`,
          [event.id, errorMessage, String(backoffMinutes)],
        );
      result.retrying += 1;
    });
  }
  return result;
}
