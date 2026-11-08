#!/usr/bin/env node
/**
 * Background worker: outbox relay plus notification delivery.
 *
 * Each poll first relays due tenant outbox events into notification messages
 * (see `services/outbox.ts`), then delivers due notification messages through
 * the adapters in `services/notifications.ts`. Relay-then-deliver ordering
 * means an event produced by a business write can reach the recipient in
 * the same tick. Each tenant is processed through the tenant-scoped pool,
 * so row level security is never bypassed. Run with
 * `npm run worker -w @hospitality/api`. Small deployments without a process
 * manager can instead call the authenticated
 * `POST /api/v1/notifications/process` endpoint per tenant for messages.
 *
 * Email requires `SMTP_HOST` (plus `SMTP_USER`/`SMTP_PASSWORD` for auth);
 * sms/push delivery fails visibly as unconfigured until a provider adapter is
 * wired in. In-app messages always deliver.
 */
import { config } from './config.js';
import { getAdminPool } from './db.js';
import { processQueuedMessages, type ProcessResult } from './services/notifications.js';
import { relayOnce, type RelayResult } from './services/outbox.js';

const admin = getAdminPool();
let stopping = false;

async function dueTenants(query: string): Promise<string[]> {
  // The admin connection is the table owner, so this enumeration sees every
  // tenant; the actual work always runs through withTenant below.
  const { rows } = await admin.query<{ tenant_id: string }>(query);
  return rows.map((r) => r.tenant_id);
}

export interface SweepResult extends ProcessResult, RelayResult {}

export async function sweepOnce(limit = 100): Promise<SweepResult> {
  const totals: SweepResult = {
    claimed: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    processed: 0,
  };
  const relayTenants = await dueTenants(
    `SELECT DISTINCT tenant_id FROM integration.outbox
      WHERE status IN ('pending', 'processing') AND available_at <= now()`,
  );
  for (const tenantId of relayTenants) {
    const once = await relayOnce(tenantId, limit);
    totals.processed += once.processed;
    totals.retrying += once.retrying;
    totals.failed += once.failed;
  }
  const notifyTenants = await dueTenants(
    `SELECT DISTINCT tenant_id FROM notification.messages
      WHERE status = 'queued' AND next_attempt_at <= now()`,
  );
  for (const tenantId of notifyTenants) {
    const once = await processQueuedMessages(tenantId, limit);
    totals.claimed += once.claimed;
    totals.sent += once.sent;
    totals.retrying += once.retrying;
    totals.failed += once.failed;
  }
  return totals;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

if (process.env.NODE_ENV !== 'test') {
  console.log(
    `hospitality worker started: outbox relay + notifications (poll every ${config.NOTIFICATIONS_POLL_SECONDS}s, max notification attempts ${config.NOTIFICATIONS_MAX_ATTEMPTS}, max outbox attempts ${config.OUTBOX_MAX_ATTEMPTS})`,
  );
  while (!stopping) {
    const started = Date.now();
    const result = await sweepOnce().catch((err: unknown) => {
      console.error('worker sweep failed:', err instanceof Error ? err.message : err);
      return undefined;
    });
    if (result && (result.claimed > 0 || result.processed > 0)) {
      console.log(
        `sweep: events processed=${result.processed} messages claimed=${result.claimed} sent=${result.sent} retrying=${result.retrying} failed=${result.failed}`,
      );
    }
    const elapsed = Date.now() - started;
    const waitMs = Math.max(1_000, config.NOTIFICATIONS_POLL_SECONDS * 1_000 - elapsed);
    await sleep(waitMs);
  }
  await admin.end().catch(() => {});
  console.log('worker stopped');
}
