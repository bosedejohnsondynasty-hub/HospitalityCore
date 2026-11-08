import './env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeAll, seedTenant, sql } from './helpers.js';
import { processQueuedMessages } from '../src/services/notifications.js';

after(async () => {
  await closeAll();
});

test('notification queue delivers in-app messages through the worker sweep', async () => {
  const tenant = await seedTenant();

  const queued = await api('POST', '/api/v1/notifications/messages', {
    token: tenant.token,
    body: {
      channel: 'inapp',
      recipient: 'front-desk',
      subject: 'Guest request',
      body: 'Room 101 needs extra towels.',
      templateCode: 'guest_request',
    },
  });
  assert.equal(queued.status, 200, `queue in-app message: ${JSON.stringify(queued.body)}`);
  const messageId = (queued.body as { id: string }).id;

  const queuedRows = await sql<{ status: string }>(
    'SELECT status FROM notification.messages WHERE tenant_id = $1 AND id = $2',
    [tenant.tenantId, messageId],
  );
  assert.equal(queuedRows[0]?.status, 'queued', 'new message starts queued');

  // The manual process tick drains the tenant queue.
  const tick = await api('POST', '/api/v1/notifications/process', { token: tenant.token });
  assert.equal(tick.status, 200, `process tick: ${JSON.stringify(tick.body)}`);
  assert.deepEqual(
    (tick.body as { claimed: number; sent: number }).sent,
    1,
    'exactly one message sent',
  );

  const sent = await sql<{ status: string; sent_at: Date | null; attempts: number }>(
    'SELECT status, sent_at, attempts FROM notification.messages WHERE tenant_id = $1 AND id = $2',
    [tenant.tenantId, messageId],
  );
  assert.equal(sent[0]?.status, 'sent', 'in-app message delivered');
  assert.ok(sent[0]?.sent_at, 'sent_at recorded');
  assert.equal(sent[0]?.attempts, 1, 'one delivery attempt recorded');

  // The list endpoint shows the delivered message.
  const list = await api('GET', '/api/v1/notifications/messages?status=sent', {
    token: tenant.token,
  });
  assert.equal(list.status, 200, 'list sent messages');
  const messages = (list.body as { messages: Array<{ id: string }> }).messages;
  assert.equal(messages.length, 1, 'one sent message listed');
  assert.equal(messages[0]!.id, messageId, 'listed message is the queued one');
});

test('unconfigured channels fail permanently with an honest error detail', async () => {
  const tenant = await seedTenant();

  const queued = await api('POST', '/api/v1/notifications/messages', {
    token: tenant.token,
    body: { channel: 'email', recipient: 'guest@example.com', subject: 'Stay', body: 'Welcome.' },
  });
  assert.equal(queued.status, 200, 'queue email message');
  const messageId = (queued.body as { id: string }).id;

  // No SMTP_* configured in the test environment: the worker must not fake a send.
  const result = await processQueuedMessages(tenant.tenantId);
  assert.equal(result.claimed, 1, 'one message claimed');
  assert.equal(result.sent, 0, 'nothing sent');
  assert.equal(result.failed, 1, 'message terminally failed');

  const rows = await sql<{ status: string; error_detail: string | null; sent_at: unknown }>(
    'SELECT status, error_detail, sent_at FROM notification.messages WHERE tenant_id = $1 AND id = $2',
    [tenant.tenantId, messageId],
  );
  assert.equal(rows[0]?.status, 'failed', 'message failed, not sent');
  assert.equal(rows[0]?.sent_at, null, 'no sent_at recorded');
  assert.match(rows[0]?.error_detail ?? '', /not configured/, 'error detail explains why');

  // A failed message can be requeued and is back in the queue.
  const requeue = await api('POST', `/api/v1/notifications/messages/${messageId}/requeue`, {
    token: tenant.token,
  });
  assert.equal(requeue.status, 200, `requeue: ${JSON.stringify(requeue.body)}`);
  const requeued = await sql<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM notification.messages WHERE tenant_id = $1 AND id = $2',
    [tenant.tenantId, messageId],
  );
  assert.equal(requeued[0]?.status, 'queued', 'message back in the queue');
  assert.equal(requeued[0]?.attempts, 0, 'attempt counter reset');
});

test('deactivating the notifications module blocks queuing', async () => {
  const tenant = await seedTenant();

  const deactivate = await api('POST', '/api/v1/licensing/modules/notifications/deactivate', {
    token: tenant.token,
    body: { product: 'hotel' },
  });
  assert.equal(deactivate.status, 200, 'deactivate notifications module');

  const blocked = await api('POST', '/api/v1/notifications/messages', {
    token: tenant.token,
    body: { channel: 'inapp', recipient: 'front-desk', body: 'Hello' },
  });
  assert.equal(blocked.status, 402, 'queue blocked while module deactivated');

  await api('POST', '/api/v1/licensing/modules/notifications/activate', {
    token: tenant.token,
    body: { product: 'hotel' },
  });
});
