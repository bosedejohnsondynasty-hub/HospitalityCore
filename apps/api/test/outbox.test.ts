import './env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeAll, seedTenant, sql } from './helpers.js';
import { relayOnce } from '../src/services/outbox.js';
import { processQueuedMessages } from '../src/services/notifications.js';

after(async () => {
  await closeAll();
});

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

test('domain events are relayed into notification messages and delivered', async () => {
  const tenant = await seedTenant();

  const guest = await api('POST', '/api/v1/hotel/guests', {
    token: tenant.token,
    body: { firstName: 'Adaeze', lastName: 'Guest', email: `adaeze.${Date.now()}@example.com` },
  });
  assert.equal(guest.status, 200, 'create guest');
  const guestId = (guest.body as { id: string }).id;

  const reservation = await api('POST', '/api/v1/hotel/reservations', {
    token: tenant.token,
    body: {
      hotelId: tenant.hotelId,
      guestId,
      roomTypeId: tenant.standardRoomTypeId,
      arrivalDate: isoDate(1),
      departureDate: isoDate(3),
    },
  });
  assert.equal(reservation.status, 200, `create reservation: ${JSON.stringify(reservation.body)}`);
  const reservationId = (reservation.body as { id: string }).id;

  const pending = await sql<{ status: string; event_type: string }>(
    `SELECT status, event_type FROM integration.outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event_type = 'reservation.created'`,
    [tenant.tenantId, reservationId],
  );
  assert.equal(pending[0]?.status, 'pending', 'reservation.created event is queued in the outbox');

  const relayed = await relayOnce(tenant.tenantId);
  assert.equal(relayed.claimed, 1, 'relay claimed the event');
  assert.equal(relayed.processed, 1, 'relay processed the event');

  const processed = await sql<{ status: string }>(
    'SELECT status FROM integration.outbox WHERE tenant_id = $1 AND aggregate_id = $2',
    [tenant.tenantId, reservationId],
  );
  assert.equal(processed[0]?.status, 'processed', 'event marked processed');

  const messages = await sql<{
    recipient: string;
    status: string;
    subject: string;
    related_id: string | null;
  }>(
    `SELECT recipient, status, subject, related_id FROM notification.messages
      WHERE tenant_id = $1 AND related_type = 'reservation'`,
    [tenant.tenantId],
  );
  assert.equal(messages.length, 1, 'relay produced exactly one notification');
  assert.equal(messages[0]?.recipient, 'front-desk', 'notification addressed to front desk');
  assert.equal(messages[0]?.related_id, reservationId, 'notification linked to the reservation');

  const delivered = await processQueuedMessages(tenant.tenantId);
  assert.equal(delivered.sent, 1, 'notification delivered by the notification sweep');
});

test('the relay is tenant scoped: other tenants events are untouched', async () => {
  const tenantA = await seedTenant();
  const tenantB = await seedTenant();

  // Emit one event per tenant via the same DB function the services use.
  for (const tenant of [tenantA, tenantB]) {
    await sql(
      'SELECT app_emit_event($1::uuid, $2::text, $3::text, $4::text, $5::jsonb)',
      [tenant.tenantId, 'night_audit.completed', 'hotel', tenant.hotelId, JSON.stringify({})],
    );
  }

  const relayed = await relayOnce(tenantA.tenantId);
  assert.equal(relayed.claimed, 1, 'relay claimed only tenant A events');

  const a = await sql<{ status: string }>(
    'SELECT status FROM integration.outbox WHERE tenant_id = $1',
    [tenantA.tenantId],
  );
  const b = await sql<{ status: string }>(
    'SELECT status FROM integration.outbox WHERE tenant_id = $1',
    [tenantB.tenantId],
  );
  assert.equal(a[0]?.status, 'processed', 'tenant A event processed');
  assert.equal(b[0]?.status, 'pending', 'tenant B event still pending (no cross-tenant relay)');

  const bMessages = await sql(
    'SELECT id FROM notification.messages WHERE tenant_id = $1',
    [tenantB.tenantId],
  );
  assert.equal(bMessages.length, 0, 'tenant B received no notifications from tenant A relay');
});

test('events without a consumer are recorded, not dropped silently', async () => {
  const tenant = await seedTenant();

  await sql(
    'SELECT app_emit_event($1::uuid, $2::text, $3::text, $4::text, $5::jsonb)',
    [
      tenant.tenantId,
      'some.unregistered.event',
      'hotel',
      tenant.hotelId,
      JSON.stringify({}),
    ],
  );

  const relayed = await relayOnce(tenant.tenantId);
  assert.equal(relayed.processed, 1, 'unconsumed event still drained (no accumulation)');

  const rows = await sql<{ status: string; last_error: string | null }>(
    'SELECT status, last_error FROM integration.outbox WHERE tenant_id = $1',
    [tenant.tenantId],
  );
  assert.equal(rows[0]?.status, 'processed', 'event marked processed');
  assert.match(rows[0]?.last_error ?? '', /no consumer registered/, 'record explains the no-op');
});
