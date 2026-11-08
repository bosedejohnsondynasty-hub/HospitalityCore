import './env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD,
  api,
  closeAll,
  expectStatus,
  login,
  paystackEvent,
  seedTenant,
  sql,
  webhook,
  type SeededTenant,
} from './helpers.js';
import { withTenant } from '../src/db.js';

let t: SeededTenant;
let hotelId: string;
let guestId: string;
let reservationA: string;
let reservationB: string;
let stayA: string;
let folioA: string;
let jollofId: string;
let waterId: string;
let qrToken: string;
let riceItemId: string;
let supplierId: string;
let cashierToken: string;
let managerToken: string;
let housekeeperToken: string;
let housekeeperId: string;
let financeToken: string;
let otherTenantToken: string;
let otherTenantId: string;

async function trialBalanceRow(accountCode: string) {
  const res = await api('GET', '/api/v1/finance/trial-balance', { token: t.token });
  expectStatus(res, 200, 'trial balance');
  const row = (res.body.accounts as Array<Record<string, number | string>>).find(
    (a) => a.account_code === accountCode,
  );
  return row ? Number(row.total_debit) : 0;
}

async function netBalance(accountCode: string): Promise<number> {
  const res = await api('GET', '/api/v1/finance/trial-balance', { token: t.token });
  expectStatus(res, 200, 'trial balance');
  const row = (res.body.accounts as Array<Record<string, number | string>>).find(
    (a) => a.account_code === accountCode,
  );
  if (!row) return 0;
  return Number(row.net_debit);
}

async function folioBalance(folioId: string): Promise<number> {
  const res = await api('GET', `/api/v1/hotel/folios/${folioId}`, { token: t.token });
  expectStatus(res, 200, 'get folio');
  return Number((res.body as { balance: string }).balance);
}

async function createGuest(label: string): Promise<string> {
  const res = await api('POST', '/api/v1/hotel/guests', {
    token: t.token,
    body: { firstName: label, lastName: 'Guest', email: `${label}.${Date.now()}@example.com` },
  });
  expectStatus(res, 200, 'create guest');
  return (res.body as { id: string }).id;
}

async function createReservation(
  guest: string,
  roomTypeId: string,
  arrival: string,
  departure: string,
): Promise<string> {
  const res = await api('POST', '/api/v1/hotel/reservations', {
    token: t.token,
    body: { hotelId, guestId: guest, roomTypeId, arrivalDate: arrival, departureDate: departure },
  });
  expectStatus(res, 200, 'create reservation');
  return (res.body as { id: string }).id;
}

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

after(async () => {
  await closeAll();
});

test('provisioning creates products, modules, roles and the chart of accounts', async () => {
  t = await seedTenant();
  hotelId = t.hotelId;

  const me = await api('GET', '/api/v1/auth/me', { token: t.token });
  expectStatus(me, 200, 'me');
  const body = me.body as {
    permissions: string[];
    roles: string[];
    licensedModules: string[];
    branches: Array<{ id: string }>;
  };
  assert.ok(body.user.roles.includes('owner'));
  assert.ok(body.permissions.includes('hotel.folios.post'));
  assert.ok(body.permissions.includes('platform.licensing.manage'));
  assert.ok(body.licensedModules.includes('reservations'));
  assert.ok(body.licensedModules.includes('menu_qr'));
  assert.equal(body.branches.length, 1);

  const catalogue = await api('GET', '/api/v1/licensing/catalogue', { token: t.token });
  expectStatus(catalogue, 200, 'catalogue');
  const products = (catalogue.body as { products: Array<{ code: string; modules: Array<{ licensed: boolean }> }> })
    .products;
  assert.deepEqual(
    products.map((p) => p.code).sort(),
    ['bar', 'hotel', 'restaurant'],
  );
  assert.equal(products.find((p) => p.code === 'hotel')!.modules.length, 45);
  assert.equal(products.find((p) => p.code === 'restaurant')!.modules.length, 17);
  assert.equal(products.find((p) => p.code === 'bar')!.modules.length, 11);
  assert.ok(products.every((p) => p.modules.every((m) => m.licensed)));

  const accounts = await api('GET', '/api/v1/finance/accounts', { token: t.token });
  expectStatus(accounts, 200, 'accounts');
  assert.equal((accounts.body as { accounts: unknown[] }).accounts.length, 26);

  const audit = await api('GET', '/api/v1/platform/audit', { token: t.token });
  expectStatus(audit, 200, 'audit');
  assert.ok(
    (audit.body as { events: Array<{ action: string }> }).events.some(
      (e) => e.action === 'tenant.bootstrap',
    ),
  );
});

test('provisioning supports multiple branches without bank account collisions', async () => {
  const multi = await seedTenant({
    tenantCode: `mb${Date.now().toString(36)}`,
    branches: [
      { code: 'MBH', name: 'Multi Hotel', type: 'hotel' },
      { code: 'MBR', name: 'Multi Restaurant', type: 'restaurant' },
      { code: 'MBB', name: 'Multi Bar', type: 'bar' },
    ],
  });
  const accounts = await sql<{ account_number: string; branch_id: string }>(
    'SELECT account_number, branch_id FROM finance.bank_accounts WHERE tenant_id = $1',
    [multi.tenantId],
  );
  assert.equal(accounts.length, 3, 'one operating account per branch');
  assert.equal(new Set(accounts.map((row) => row.account_number)).size, 3, 'account numbers are unique per tenant');
});

test('reservations allocate rooms and the database blocks double booking', async () => {
  guestId = await createGuest('Ada');
  const availability = await api(
    'GET',
    `/api/v1/hotel/availability?hotelId=${hotelId}&from=${isoDate(1)}&to=${isoDate(3)}`,
    { token: t.token },
  );
  expectStatus(availability, 200, 'availability');
  assert.equal((availability.body as { rooms: unknown[] }).rooms.length, 3);

  reservationA = await createReservation(guestId, t.standardRoomTypeId, isoDate(1), isoDate(3));
  const allocated = await api('POST', `/api/v1/hotel/reservations/${reservationA}/allocate`, {
    token: t.token,
    body: { roomId: t.room101 },
  });
  expectStatus(allocated, 200, 'allocate room 101');

  // Overlapping reservation for the same room must be rejected by the exclusion constraint.
  const guest2 = await createGuest('Bola');
  reservationB = await createReservation(guest2, t.standardRoomTypeId, isoDate(1), isoDate(4));
  const overlap = await api('POST', `/api/v1/hotel/reservations/${reservationB}/allocate`, {
    token: t.token,
    body: { roomId: t.room101 },
  });
  expectStatus(overlap, 409, 'double booking rejected');
  assert.equal((overlap.body as { error: { code: string } }).error.code, 'ROOM_UNAVAILABLE');

  const secondRoom = await api('POST', `/api/v1/hotel/reservations/${reservationB}/allocate`, {
    token: t.token,
    body: { roomId: t.room102 },
  });
  expectStatus(secondRoom, 200, 'allocate room 102');

  // Two concurrent allocations of the same room: exactly one may win.
  const guest3 = await createGuest('Chidi');
  const guest4 = await createGuest('Dami');
  const resC = await createReservation(guest3, t.deluxeRoomTypeId, isoDate(5), isoDate(7));
  const resD = await createReservation(guest4, t.deluxeRoomTypeId, isoDate(5), isoDate(7));
  const [first, second] = await Promise.all([
    api('POST', `/api/v1/hotel/reservations/${resC}/allocate`, {
      token: t.token,
      body: { roomId: t.room201 },
    }),
    api('POST', `/api/v1/hotel/reservations/${resD}/allocate`, {
      token: t.token,
      body: { roomId: t.room201 },
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one concurrent allocation succeeds');
});

test('reservations amend, cancel and no-show enforce their guard rails', async () => {
  const guest = await createGuest('Emeka');
  const id = await createReservation(guest, t.standardRoomTypeId, isoDate(10), isoDate(12));

  const amended = await api('PATCH', `/api/v1/hotel/reservations/${id}`, {
    token: t.token,
    body: { departureDate: isoDate(13), adults: 2, specialRequests: 'High floor' },
  });
  expectStatus(amended, 200, 'amend reservation');
  assert.equal((amended.body as { nights: number }).nights, 3);

  const inverted = await api('PATCH', `/api/v1/hotel/reservations/${id}`, {
    token: t.token,
    body: { departureDate: isoDate(10) },
  });
  expectStatus(inverted, 400, 'departure before arrival rejected');

  const allocated = await api('POST', `/api/v1/hotel/reservations/${id}/allocate`, {
    token: t.token,
    body: { roomId: t.room101 },
  });
  expectStatus(allocated, 200, 'allocate amended reservation');

  const pinned = await api('PATCH', `/api/v1/hotel/reservations/${id}`, {
    token: t.token,
    body: { arrivalDate: isoDate(11) },
  });
  expectStatus(pinned, 409, 'allocated reservation cannot silently move dates');
  assert.equal((pinned.body as { error: { code: string } }).error.code, 'RESERVATION_HAS_ALLOCATION');

  const noReason = await api('POST', `/api/v1/hotel/reservations/${id}/cancel`, {
    token: t.token,
    body: {},
  });
  expectStatus(noReason, 400, 'cancellation requires a reason');

  const cancelled = await api('POST', `/api/v1/hotel/reservations/${id}/cancel`, {
    token: t.token,
    body: { reason: 'Guest travel plans changed' },
  });
  expectStatus(cancelled, 200, 'cancel reservation');
  assert.equal((cancelled.body as { status: string }).status, 'cancelled');

  const released = await sql<{ status: string }>(
    `SELECT status FROM hotel.room_allocations WHERE reservation_id = $1`,
    [id],
  );
  assert.deepEqual(
    released.map((row) => row.status),
    ['released'],
    'cancelling frees the room allocation',
  );

  const twice = await api('POST', `/api/v1/hotel/reservations/${id}/cancel`, {
    token: t.token,
    body: { reason: 'again' },
  });
  expectStatus(twice, 409, 'second cancellation refused');
  assert.equal((twice.body as { error: { code: string } }).error.code, 'ALREADY_CANCELLED');

  const futureGuest = await createGuest('Funmi');
  const future = await createReservation(
    futureGuest,
    t.standardRoomTypeId,
    isoDate(20),
    isoDate(22),
  );
  const early = await api('POST', `/api/v1/hotel/reservations/${future}/no-show`, {
    token: t.token,
    body: {},
  });
  expectStatus(early, 409, 'no-show before the arrival date refused');
  assert.equal((early.body as { error: { code: string } }).error.code, 'RESERVATION_NOT_DUE');
});

test('check-in opens a folio and posted entries are immutable', async () => {
  const checkin = await api('POST', `/api/v1/hotel/reservations/${reservationA}/checkin`, {
    token: t.token,
    body: {},
  });
  expectStatus(checkin, 200, 'check in');
  stayA = (checkin.body as { stayId: string }).stayId;
  folioA = (checkin.body as { folioId: string }).folioId;
  assert.equal(await folioBalance(folioA), 0);

  const charge = await api('POST', `/api/v1/hotel/folios/${folioA}/charges`, {
    token: t.token,
    body: { entryType: 'room_charge', description: 'Late checkout fee', amount: 25000 },
  });
  expectStatus(charge, 200, 'post folio charge');
  const entryId = (charge.body as { entryId: string }).entryId;
  assert.equal(await folioBalance(folioA), 25000);

  // Direct mutation of a posted folio entry is refused by the database itself.
  await assert.rejects(
    () =>
      withTenant(t.tenantId, (db) =>
        db.query("UPDATE hotel.folio_entries SET amount = 1 WHERE id = $1", [entryId]),
      ),
    (err: Error & { code?: string }) =>
      err.code === '42501' || /append-only|permission denied/i.test(err.message),
    'posted folio entries must not be updatable',
  );
  await assert.rejects(
    () => withTenant(t.tenantId, (db) => db.query('DELETE FROM hotel.folio_entries WHERE id = $1', [entryId])),
    (err: Error & { code?: string }) =>
      err.code === '42501' || /append-only|permission denied/i.test(err.message),
    'posted folio entries must not be deletable',
  );

  const reversal = await api('POST', `/api/v1/hotel/folio-entries/${entryId}/reverse`, {
    token: t.token,
    body: { reason: 'Charged in error' },
  });
  expectStatus(reversal, 200, 'reverse folio entry');
  assert.equal(await folioBalance(folioA), 0, 'reversal restores the balance');

  const rows = await sql<{ entry_type: string }>(
    'SELECT entry_type FROM hotel.folio_entries WHERE folio_id = $1 ORDER BY posted_at',
    [folioA],
  );
  assert.deepEqual(
    rows.map((r) => r.entry_type),
    ['room_charge', 'reversal'],
  );
  assert.equal(await folioBalance(folioA), 0);
});

test('night audit posts room charges, advances the business date and enforces exceptions', async () => {
  const audit = await api('POST', '/api/v1/hotel/night-audit', {
    token: t.token,
    body: { hotelId },
  });
  expectStatus(audit, 200, 'night audit');
  const result = audit.body as { businessDate: string; nextBusinessDate: string; status: string; roomChargesPosted: number };
  assert.equal(result.status, 'completed');
  assert.ok(result.roomChargesPosted >= 1, 'in-house stays are charged for the night');
  assert.ok(result.nextBusinessDate > result.businessDate);
  assert.equal(await folioBalance(folioA), 50000, 'nightly room charge posted to the folio');

  // A guest in house without an open folio is a critical exception.
  await withTenant(t.tenantId, (db) =>
    db.query("UPDATE hotel.folios SET status = 'closed', closed_at = now() WHERE id = $1", [folioA]),
  );
  const blocked = await api('POST', '/api/v1/hotel/night-audit', {
    token: t.token,
    body: { hotelId },
  });
  expectStatus(blocked, 409, 'critical exception blocks the audit');
  const error = blocked.body as { error: { code: string; details: { exceptions: Array<{ code: string; severity: string }> } } };
  assert.equal(error.error.code, 'NIGHT_AUDIT_EXCEPTIONS');
  assert.ok(error.error.details.exceptions.some((e) => e.severity === 'critical'));

  const overridden = await api('POST', '/api/v1/hotel/night-audit', {
    token: t.token,
    body: { hotelId, overrideReason: 'Guest settled the folio offline at the desk' },
  });
  expectStatus(overridden, 200, 'authorised override completes the audit');
  assert.equal((overridden.body as { status: string }).status, 'completed_with_override');

  const businessDate = await api('GET', `/api/v1/hotel/business-date?hotelId=${hotelId}`, {
    token: t.token,
  });
  expectStatus(businessDate, 200, 'business date');
  assert.equal((businessDate.body as { businessDate: { status: string } }).businessDate.status, 'open');
});

test('housekeeping tasks are assigned, completed with a checklist and inspected', async () => {
  const checklist = await api('GET', `/api/v1/hotel/housekeeping/checklist?hotelId=${hotelId}`, {
    token: t.token,
  });
  expectStatus(checklist, 200, 'checklist');
  const items = (checklist.body as { items: Array<{ id: string }> }).items;
  assert.ok(items.length >= 5);

  const task = await api('POST', '/api/v1/hotel/housekeeping/tasks', {
    token: t.token,
    body: { hotelId, roomId: t.room101, taskCode: 'CHECKOUT_CLEAN' },
  });
  expectStatus(task, 200, 'create task');
  const taskId = (task.body as { taskId: string }).taskId;

  const complete = await api('POST', `/api/v1/hotel/housekeeping/tasks/${taskId}/complete`, {
    token: t.token,
    body: {
      notes: 'Cleaned and restocked',
      checklist: items.map((i) => ({ itemId: i.id, done: true })),
    },
  });
  expectStatus(complete, 200, 'complete task');

  const inspect = await api('POST', `/api/v1/hotel/housekeeping/tasks/${taskId}/inspect`, {
    token: t.token,
    body: { result: 'passed', score: 95 },
  });
  expectStatus(inspect, 200, 'inspect task');

  const rooms = await api('GET', `/api/v1/hotel/rooms?hotelId=${hotelId}`, { token: t.token });
  expectStatus(rooms, 200, 'rooms');
  const room = (rooms.body as { rooms: Array<{ id: string; housekeeping_status: string }> }).rooms.find(
    (r) => r.id === t.room101,
  )!;
  assert.equal(room.housekeeping_status, 'inspected');
});

test('maintenance requests need a different approver and work orders record parts', async () => {
  const item = await api('POST', '/api/v1/inventory/items', {
    token: t.token,
    body: { sku: 'FILTER', name: 'AC Filter', category: 'engineering', standardCost: 2500 },
  });
  expectStatus(item, 200, 'create engineering item');
  const filterItemId = (item.body as { id: string }).id;

  const request = await api('POST', '/api/v1/hotel/maintenance/requests', {
    token: t.token,
    body: { branchId: t.branchId, roomId: t.room101, description: 'Air conditioner not cooling', priority: 'high' },
  });
  expectStatus(request, 200, 'create request');
  const requestId = (request.body as { requestId: string }).requestId;

  const selfApprove = await api('POST', `/api/v1/hotel/maintenance/requests/${requestId}/approve`, {
    token: t.token,
  });
  expectStatus(selfApprove, 403, 'self approval is refused');

  const user = await api('POST', '/api/v1/platform/users', {
    token: t.token,
    body: {
      email: `manager.${Date.now()}@test.local`,
      fullName: 'Grace Manager',
      password: PASSWORD,
      roles: ['general_manager'],
      branchIds: [t.branchId],
    },
  });
  expectStatus(user, 200, 'create manager user');
  managerToken = await login((user.body as { email: string }).email, t.tenantCode);

  const approve = await api('POST', `/api/v1/hotel/maintenance/requests/${requestId}/approve`, {
    token: managerToken,
  });
  expectStatus(approve, 200, 'manager approves');

  const workOrder = await api('POST', '/api/v1/hotel/maintenance/work-orders', {
    token: managerToken,
    body: { requestId, priority: 'high' },
  });
  expectStatus(workOrder, 200, 'create work order');
  const workOrderId = (workOrder.body as { workOrderId: string }).workOrderId;

  const complete = await api('POST', `/api/v1/hotel/maintenance/work-orders/${workOrderId}/complete`, {
    token: managerToken,
    body: {
      resolutionNote: 'Replaced filter and regassed unit',
      parts: [{ itemId: filterItemId, quantity: 2, unitCost: 2500 }],
      labourCost: 10000,
    },
  });
  expectStatus(complete, 200, 'complete work order');
  assert.equal((complete.body as { partsValue: number }).partsValue, 5000);

  const parts = await sql<{ quantity: string }>(
    'SELECT quantity FROM inventory.movements WHERE reference_type = $1 AND reference_id = $2',
    ['work_order', workOrderId],
  );
  assert.equal(parts.length, 1);
  assert.equal(Number(parts[0]!.quantity), -2);
});

test('restaurant works standalone: menu, QR code, ordering, kitchen routing and recipes', async () => {
  const stations = await api('GET', `/api/v1/restaurant/outlets/${t.outletId}/stations`, {
    token: t.token,
  });
  expectStatus(stations, 200, 'stations');
  const stationId = (stations.body as { stations: Array<{ id: string }> }).stations[0]!.id;

  const jollof = await api('POST', `/api/v1/restaurant/menus/${t.menuId}/items`, {
    token: t.token,
    body: {
      sku: 'JOL',
      name: 'Jollof Rice',
      price: 5000,
      taxRate: 0.075,
      kitchenStationId: stationId,
      prepMinutes: 20,
    },
  });
  expectStatus(jollof, 200, 'create jollof');
  jollofId = (jollof.body as { id: string }).id;

  const water = await api('POST', `/api/v1/restaurant/menus/${t.menuId}/items`, {
    token: t.token,
    body: { sku: 'WATER', name: 'Bottled Water', price: 1000, taxRate: 0.075, kitchenStationId: stationId },
  });
  expectStatus(water, 200, 'create water');
  waterId = (water.body as { id: string }).id;

  const qr = await api('POST', `/api/v1/restaurant/outlets/${t.outletId}/qr`, {
    token: t.token,
    body: { tableId: t.tableId, label: 'Table 1' },
  });
  expectStatus(qr, 200, 'create QR token');
  qrToken = (qr.body as { token: string }).token;
  assert.ok(qrToken.length >= 16);

  const publicMenu = await api('GET', `/api/v1/public/qr/${qrToken}/menu`);
  expectStatus(publicMenu, 200, 'public menu');
  const menuBody = publicMenu.body as { menu: { items: Array<{ sku: string; price: number }> } };
  assert.ok(menuBody.menu.items.some((i) => i.sku === 'JOL' && i.price === 5000));

  const order = await api('POST', `/api/v1/public/qr/${qrToken}/orders`, {
    body: {
      items: [{ itemId: jollofId, quantity: 2 }],
      customerName: 'Walk-in Guest',
      customerPhone: '08000000000',
    },
  });
  expectStatus(order, 200, 'QR order accepted');
  const orderBody = order.body as { orderId: string; total: number; paymentTiming: string; status: string };
  assert.equal(orderBody.total, 11750, 'subtotal 10000 + tax 750 + service 1000');
  assert.equal(orderBody.status, 'placed');
  assert.equal(orderBody.paymentTiming, 'pay_after');

  const tickets = await api('GET', `/api/v1/restaurant/kitchen?outletId=${t.outletId}`, {
    token: t.token,
  });
  expectStatus(tickets, 200, 'kitchen board');
  const ticket = (tickets.body as { tickets: Array<{ order_number: string; status: string }> }).tickets.find(
    (k) => k.order_number === (order.body as { orderNumber: string }).orderNumber,
  );
  assert.ok(ticket, 'order routed to a kitchen ticket');
  assert.equal(ticket!.status, 'queued');

  // Recipe + stock so completing the order deducts ingredients.
  const rice = await api('POST', '/api/v1/inventory/items', {
    token: t.token,
    body: { sku: 'RICE', name: 'Long Grain Rice', category: 'food', baseUnit: 'kg', standardCost: 1000 },
  });
  expectStatus(rice, 200, 'create rice');
  riceItemId = (rice.body as { id: string }).id;

  const supplier = await api('POST', '/api/v1/procurement/suppliers', {
    token: t.token,
    body: { code: 'SUP1', name: 'Lagos Foods Ltd' },
  });
  expectStatus(supplier, 200, 'create supplier');
  supplierId = (supplier.body as { id: string }).id;

  const receipt = await api('POST', '/api/v1/inventory/receipts', {
    token: t.token,
    body: {
      storeId: t.storeKitchen,
      supplierId,
      items: [{ itemId: riceItemId, quantity: 10, unitCost: 1000 }],
    },
  });
  expectStatus(receipt, 200, 'receive rice');

  const recipe = await api('POST', `/api/v1/restaurant/menu-items/${jollofId}/recipe`, {
    token: t.token,
    body: { yieldQuantity: 1, ingredients: [{ itemSku: 'RICE', quantity: 0.2, unit: 'kg' }] },
  });
  expectStatus(recipe, 200, 'save recipe');

  for (const status of ['accepted', 'preparing', 'ready', 'served', 'completed']) {
    const res = await api('POST', `/api/v1/restaurant/orders/${orderBody.orderId}/status`, {
      token: t.token,
      body: { status },
    });
    expectStatus(res, 200, `advance order to ${status}`);
    if (status === 'completed') {
      assert.equal((res.body as { ingredientsIssued: number }).ingredientsIssued, 1);
    }
  }

  const balances = await api('GET', `/api/v1/inventory/balances?storeId=${t.storeKitchen}`, {
    token: t.token,
  });
  expectStatus(balances, 200, 'stock balances');
  const riceBalance = (balances.body as { balances: Array<{ item_id: string; quantity: number }> }).balances.find(
    (b) => b.item_id === riceItemId,
  )!;
  assert.equal(riceBalance.quantity, 9.6, '0.2kg per portion x 2 portions deducted');

  // Completing twice must not deduct twice (guarded by the unique movement index).
  const repeat = await api('POST', `/api/v1/restaurant/orders/${orderBody.orderId}/status`, {
    token: t.token,
    body: { status: 'completed' },
  });
  expectStatus(repeat, 409, 'completed orders cannot be completed twice');

  const orderState = await api('GET', `/api/v1/restaurant/orders/${orderBody.orderId}`, {
    token: t.token,
  });
  expectStatus(orderState, 200, 'order detail');
  assert.equal((orderState.body as { payment_status: string }).payment_status, 'unpaid');
});

test('cash payment recognises restaurant revenue exactly once', async () => {
  const before = await netBalance('4100');
  const order = await api('POST', '/api/v1/restaurant/orders', {
    token: t.token,
    body: { outletId: t.outletId, channel: 'pos', items: [{ itemId: jollofId, quantity: 1 }] },
  });
  expectStatus(order, 200, 'POS order');
  const orderId = (order.body as { orderId: string }).orderId;
  assert.equal((order.body as { total: number }).total, 5875);

  const intent = await api('POST', '/api/v1/payments/intents', {
    token: t.token,
    body: { relatedType: 'restaurant_order', relatedId: orderId, provider: 'cash' },
  });
  expectStatus(intent, 200, 'cash intent');
  assert.equal((intent.body as { status: string }).status, 'successful');

  const after = await netBalance('4100');
  assert.equal(Math.round((after - before) * 100) / 100, -5875, 'revenue credited once');

  const links = await sql(
    "SELECT count(*) AS n FROM finance.posting_links WHERE source_type = 'restaurant_order' AND source_id = $1 AND purpose = 'revenue'",
    [orderId],
  );
  assert.equal(Number(links[0]!.n), 1);

  const detail = await api('GET', `/api/v1/restaurant/orders/${orderId}`, { token: t.token });
  assert.equal((detail.body as { payment_status: string }).payment_status, 'paid');
});

test('payment webhooks are signature verified, replay safe and amount checked', async () => {
  const order = await api('POST', '/api/v1/restaurant/orders', {
    token: t.token,
    body: { outletId: t.outletId, channel: 'website', items: [{ itemId: waterId, quantity: 1 }] },
  });
  expectStatus(order, 200, 'website order');
  const orderId = (order.body as { orderId: string }).orderId;
  const total = (order.body as { total: number }).total;

  const intent = await api('POST', '/api/v1/payments/intents', {
    token: t.token,
    body: { relatedType: 'restaurant_order', relatedId: orderId, provider: 'paystack' },
  });
  expectStatus(intent, 200, 'create paystack intent');
  const reference = (intent.body as { reference: string }).reference;

  const before = await netBalance('4100');

  const signed = paystackEvent({ reference, amountMajor: total });
  const badSignature = await webhook('paystack', signed.raw, { 'x-paystack-signature': 'deadbeef' });
  assert.equal(badSignature.status, 401);
  const stillUnpaid = await api('GET', `/api/v1/restaurant/orders/${orderId}`, { token: t.token });
  assert.equal((stillUnpaid.body as { payment_status: string }).payment_status, 'pending');

  const processed = await webhook('paystack', signed.raw, { 'x-paystack-signature': signed.signature });
  assert.equal(processed.status, 200);
  assert.equal((processed.body as { status: string }).status, 'processed');

  const paid = await api('GET', `/api/v1/restaurant/orders/${orderId}`, { token: t.token });
  assert.equal((paid.body as { payment_status: string }).payment_status, 'paid');

  const duplicate = await webhook('paystack', signed.raw, { 'x-paystack-signature': signed.signature });
  assert.equal(duplicate.status, 200);
  assert.equal((duplicate.body as { status: string }).status, 'duplicate');

  const after = await netBalance('4100');
  assert.equal(Math.round((after - before) * 100) / 100, -total, 'duplicate delivery does not double count revenue');

  // Amount tampering: a signed event for a different amount must not settle the order.
  const order2 = await api('POST', '/api/v1/restaurant/orders', {
    token: t.token,
    body: { outletId: t.outletId, channel: 'website', items: [{ itemId: waterId, quantity: 1 }] },
  });
  const orderId2 = (order2.body as { orderId: string }).orderId;
  const total2 = (order2.body as { total: number }).total;
  const intent2 = await api('POST', '/api/v1/payments/intents', {
    token: t.token,
    body: { relatedType: 'restaurant_order', relatedId: orderId2, provider: 'paystack' },
  });
  const tampered = paystackEvent({
    reference: (intent2.body as { reference: string }).reference,
    amountMajor: total2 + 1000,
  });
  const rejected = await webhook('paystack', tampered.raw, {
    'x-paystack-signature': tampered.signature,
  });
  assert.equal(rejected.status, 400);
  assert.equal((rejected.body as { status: string }).status, 'rejected');
  const order2State = await api('GET', `/api/v1/restaurant/orders/${orderId2}`, { token: t.token });
  assert.notEqual((order2State.body as { payment_status: string }).payment_status, 'paid');
});

test('bar sales deduct stock and charge to a guest folio without double revenue', async () => {
  const item = await api('POST', '/api/v1/inventory/items', {
    token: t.token,
    body: { sku: 'BEER', name: 'Lager 33cl', category: 'beverage', baseUnit: 'bottle', standardCost: 500 },
  });
  expectStatus(item, 200, 'create beer item');
  const beerItemId = (item.body as { id: string }).id;

  const receipt = await api('POST', '/api/v1/inventory/receipts', {
    token: t.token,
    body: {
      storeId: t.storeBar,
      supplierId,
      items: [{ itemId: beerItemId, quantity: 100, unitCost: 500 }],
    },
  });
  expectStatus(receipt, 200, 'receive beer');

  const beverage = await api('POST', '/api/v1/bar/beverages', {
    token: t.token,
    body: {
      barId: t.barId,
      sku: 'BEER-BTL',
      name: 'Lager Bottle',
      category: 'beer',
      salePrice: 1500,
      costPrice: 500,
      inventorySku: 'BEER',
    },
  });
  expectStatus(beverage, 200, 'create beverage');
  const beverageId = (beverage.body as { id: string }).id;

  // Check in the second reservation to get an open folio for cross-product billing.
  const checkin = await api('POST', `/api/v1/hotel/reservations/${reservationB}/checkin`, {
    token: t.token,
    body: {},
  });
  expectStatus(checkin, 200, 'check in second guest');
  const folioB = (checkin.body as { folioId: string }).folioId;

  const restaurantOrder = await api('POST', '/api/v1/restaurant/orders', {
    token: t.token,
    body: { outletId: t.outletId, channel: 'dine_in', items: [{ itemId: jollofId, quantity: 1 }] },
  });
  expectStatus(restaurantOrder, 200, 'dine-in order');
  const restaurantOrderId = (restaurantOrder.body as { orderId: string }).orderId;
  const restaurantTotal = (restaurantOrder.body as { total: number }).total;

  const barOrder = await api('POST', '/api/v1/bar/orders', {
    token: t.token,
    body: { barId: t.barId, items: [{ beverageId, quantity: 2 }] },
  });
  expectStatus(barOrder, 200, 'bar order');
  const barOrderId = (barOrder.body as { orderId: string }).orderId;
  const barTotal = (barOrder.body as { totalAmount: number }).totalAmount;
  assert.equal(barTotal, 3525);

  const barBalances = await api('GET', `/api/v1/inventory/balances?storeId=${t.storeBar}`, {
    token: t.token,
  });
  const beerBalance = (barBalances.body as { balances: Array<{ item_id: string; quantity: number }> }).balances.find(
    (b) => b.item_id === beerItemId,
  )!;
  assert.equal(beerBalance.quantity, 98, 'two bottles deducted from stock');

  const restaurantRevenueBefore = await netBalance('4100');
  const barRevenueBefore = await netBalance('4200');
  const receivableBefore = await netBalance('1100');

  const chargeRestaurant = await api(
    'POST',
    `/api/v1/restaurant/orders/${restaurantOrderId}/charge-to-folio`,
    { token: t.token, body: { folioId: folioB } },
  );
  expectStatus(chargeRestaurant, 200, 'charge restaurant order to folio');

  const chargeBar = await api('POST', `/api/v1/bar/orders/${barOrderId}/charge-to-folio`, {
    token: t.token,
    body: { folioId: folioB },
  });
  expectStatus(chargeBar, 200, 'charge bar order to folio');

  const restaurantRevenueAfter = await netBalance('4100');
  const barRevenueAfter = await netBalance('4200');
  assert.equal(Math.round((restaurantRevenueBefore - restaurantRevenueAfter) * 100) / 100, restaurantTotal);
  assert.equal(Math.round((barRevenueBefore - barRevenueAfter) * 100) / 100, barTotal);
  assert.equal(
    Math.round(((await netBalance('1100')) - receivableBefore) * 100) / 100,
    restaurantTotal + barTotal,
    'guest receivable carries the liability once',
  );
  assert.equal(await folioBalance(folioB), restaurantTotal + barTotal);

  const links = await sql(
    "SELECT purpose, count(*) AS n FROM finance.posting_links WHERE source_id IN ($1,$2) GROUP BY purpose",
    [restaurantOrderId, barOrderId],
  );
  assert.deepEqual(
    links.map((l) => [l.purpose, Number(l.n)]),
    [['revenue', 2]],
    'one revenue posting per order and no duplicate settlement posting',
  );

  const duplicateCharge = await api(
    'POST',
    `/api/v1/restaurant/orders/${restaurantOrderId}/charge-to-folio`,
    { token: t.token, body: { folioId: folioB } },
  );
  expectStatus(duplicateCharge, 409, 'duplicate folio charge refused');
  assert.equal(Math.round((await netBalance('4100')) * 100) / 100, Math.round(restaurantRevenueAfter * 100) / 100);

  const settlement = await api('POST', `/api/v1/hotel/folios/${folioB}/settle`, {
    token: t.token,
    body: { amount: restaurantTotal + barTotal, method: 'bank_transfer', reference: 'TRF-9001' },
  });
  expectStatus(settlement, 200, 'settle folio');
  assert.equal(await folioBalance(folioB), 0);
});

test('permissions are enforced on refunds, stock adjustments and approvals', async () => {
  const cashier = await api('POST', '/api/v1/platform/users', {
    token: t.token,
    body: {
      email: `cashier.${Date.now()}@test.local`,
      fullName: 'Cashier User',
      password: PASSWORD,
      roles: ['cashier'],
      branchIds: [t.branchId],
    },
  });
  expectStatus(cashier, 200, 'create cashier');
  cashierToken = await login((cashier.body as { email: string }).email, t.tenantCode);

  const financeUser = await api('POST', '/api/v1/platform/users', {
    token: t.token,
    body: {
      email: `finance.${Date.now()}@test.local`,
      fullName: 'Finance Officer',
      password: PASSWORD,
      roles: ['finance_officer'],
      branchIds: [t.branchId],
    },
  });
  expectStatus(financeUser, 200, 'create finance user');
  financeToken = await login((financeUser.body as { email: string }).email, t.tenantCode);

  const adjust = await api('POST', '/api/v1/inventory/adjustments', {
    token: cashierToken,
    body: { storeId: t.storeMain, itemId: riceItemId, quantity: -5, reason: 'Shrinkage' },
  });
  expectStatus(adjust, 403, 'cashier cannot adjust stock');

  const refund = await api('POST', '/api/v1/payments/refunds', {
    token: cashierToken,
    body: { intentId: (await sql<{ id: string }>('SELECT id FROM payments.intents LIMIT 1'))[0]!.id, amount: 100, reason: 'test' },
  });
  expectStatus(refund, 403, 'cashier cannot request refunds');

  const sync = await api('POST', '/api/v1/sync/commands', {
    token: cashierToken,
    body: { deviceId: 'dev-cashier', commandId: `cmd-${Date.now()}`, commandType: 'housekeeping.task.complete', payload: {} },
  });
  expectStatus(sync, 403, 'cashier cannot use offline sync');

  const po = await api('POST', '/api/v1/procurement/purchase-orders', {
    token: financeToken,
    body: {
      branchId: t.branchId,
      supplierId,
      items: [{ itemId: riceItemId, quantity: 20, unitCost: 1000 }],
    },
  });
  expectStatus(po, 200, 'finance officer raises PO');
  const poId = (po.body as { poId: string }).poId;

  const selfApprove = await api('POST', `/api/v1/procurement/purchase-orders/${poId}/approve`, {
    token: financeToken,
  });
  expectStatus(selfApprove, 409, 'requester cannot approve their own PO');

  const approvePo = await api('POST', `/api/v1/procurement/purchase-orders/${poId}/approve`, {
    token: t.token,
  });
  expectStatus(approvePo, 200, 'owner approves PO');

  const invoice = await api('POST', '/api/v1/procurement/invoices', {
    token: financeToken,
    body: {
      supplierId,
      purchaseOrderId: poId,
      invoiceNumber: `INV-${Date.now()}`,
      invoiceDate: isoDate(0),
      amount: 20000,
    },
  });
  expectStatus(invoice, 200, 'record invoice');
  assert.equal((invoice.body as { matchStatus: string }).matchStatus, 'exception');

  // Refund flow requires a second approver.
  const paidIntent = await sql<{ id: string; amount: string }>(
    "SELECT id, amount FROM payments.intents WHERE status = 'successful' AND provider = 'cash' ORDER BY created_at DESC LIMIT 1",
  );
  const refundRequest = await api('POST', '/api/v1/payments/refunds', {
    token: t.token,
    body: { intentId: paidIntent[0]!.id, amount: 500, reason: 'Guest complaint' },
  });
  expectStatus(refundRequest, 200, 'owner requests refund');
  const refundId = (refundRequest.body as { id: string }).id;

  const selfApproveRefund = await api('POST', `/api/v1/payments/refunds/${refundId}/approve`, {
    token: t.token,
    body: { approve: true },
  });
  expectStatus(selfApproveRefund, 403, 'requester cannot approve their own refund');

  const approveRefund = await api('POST', `/api/v1/payments/refunds/${refundId}/approve`, {
    token: financeToken,
    body: { approve: true },
  });
  expectStatus(approveRefund, 200, 'second approver processes refund');
  assert.equal((approveRefund.body as { status: string }).status, 'processed');
});

test('tenant isolation hides another tenant records at the database layer', async () => {
  const other = await seedTenant({
    tenantCode: `o${Date.now().toString(36)}`,
    products: ['hotel', 'restaurant'],
    hotel: {
      code: 'OTH',
      name: 'Other Hotel',
      roomTypes: [{ code: 'STD', name: 'Standard', baseRate: 40000, rooms: ['901'] }],
    },
  });
  otherTenantToken = other.token;
  otherTenantId = other.tenantId;

  const folio = await api('GET', `/api/v1/hotel/folios/${folioA}`, { token: otherTenantToken });
  expectStatus(folio, 404, 'foreign folio is invisible');

  const rooms = await api('GET', `/api/v1/hotel/rooms?hotelId=${t.hotelId}`, {
    token: otherTenantToken,
  });
  expectStatus(rooms, 200, 'rooms request succeeds');
  assert.equal((rooms.body as { rooms: unknown[] }).rooms.length, 0, 'no rows leak across tenants');

  const guests = await api('GET', '/api/v1/hotel/guests', { token: otherTenantToken });
  expectStatus(guests, 200, 'guests request succeeds');
  assert.equal((guests.body as { guests: unknown[] }).guests.length, 0);

  const counts = await sql<{ tenant_id: string; n: string }>(
    'SELECT tenant_id, count(*) AS n FROM hotel.guests WHERE tenant_id IN ($1,$2) GROUP BY tenant_id',
    [t.tenantId, other.tenantId],
  );
  const mine = counts.find((c) => c.tenant_id === t.tenantId);
  assert.ok(Number(mine?.n ?? 0) > 0);
  assert.equal(counts.find((c) => c.tenant_id === other.tenantId), undefined);

  // Disabling a product for one tenant does not touch another tenant's records.
  const deactivate = await api('POST', '/api/v1/licensing/modules/ordering/deactivate', {
    token: otherTenantToken,
    body: { product: 'restaurant' },
  });
  expectStatus(deactivate, 200, 'other tenant deactivates its own module');
  const stillWorking = await api('GET', '/api/v1/restaurant/orders', { token: t.token });
  expectStatus(stillWorking, 200, 'first tenant restaurant unaffected');
});

test('unlicensed modules are locked server side', async () => {
  const deactivate = await api('POST', '/api/v1/licensing/modules/ordering/deactivate', {
    token: t.token,
    body: { product: 'restaurant' },
  });
  expectStatus(deactivate, 200, 'deactivate ordering module');

  const blocked = await api('GET', '/api/v1/restaurant/orders', { token: t.token });
  expectStatus(blocked, 402, 'unlicensed module refused');
  assert.equal((blocked.body as { error: { code: string } }).error.code, 'MODULE_NOT_LICENSED');

  const activate = await api('POST', '/api/v1/licensing/modules/ordering/activate', {
    token: t.token,
    body: { product: 'restaurant' },
  });
  expectStatus(activate, 200, 'reactivate ordering module');
  const allowed = await api('GET', '/api/v1/restaurant/orders', { token: t.token });
  expectStatus(allowed, 200, 'module works again');
});

test('offline sync is idempotent and records conflicts instead of overwriting', async () => {
  const user = await api('POST', '/api/v1/platform/users', {
    token: t.token,
    body: {
      email: `hk.${Date.now()}@test.local`,
      fullName: 'House Keeper',
      password: PASSWORD,
      roles: ['housekeeper'],
      branchIds: [t.branchId],
    },
  });
  expectStatus(user, 200, 'create housekeeper');
  housekeeperId = (user.body as { userId: string }).userId;
  housekeeperToken = await login((user.body as { email: string }).email, t.tenantCode);

  const task = await api('POST', '/api/v1/hotel/housekeeping/tasks', {
    token: t.token,
    body: { hotelId, roomId: t.room102, taskCode: 'STAYOVER_CLEAN', assignedTo: housekeeperId },
  });
  expectStatus(task, 200, 'assign task');
  const taskId = (task.body as { taskId: string }).taskId;

  const device = await api('POST', '/api/v1/sync/devices', {
    token: housekeeperToken,
    body: { deviceId: 'pwa-hk-1', platform: 'pwa', appVersion: '0.1.0' },
  });
  expectStatus(device, 200, 'register device');

  const commandId = `cmd-${Date.now()}`;
  const first = await api('POST', '/api/v1/sync/commands', {
    token: housekeeperToken,
    body: {
      deviceId: 'pwa-hk-1',
      commandId,
      commandType: 'housekeeping.task.complete',
      payload: { taskId, notes: 'Done offline' },
    },
  });
  expectStatus(first, 200, 'apply offline command');
  assert.equal((first.body as { status: string }).status, 'applied');

  const replay = await api('POST', '/api/v1/sync/commands', {
    token: housekeeperToken,
    body: {
      deviceId: 'pwa-hk-1',
      commandId,
      commandType: 'housekeeping.task.complete',
      payload: { taskId },
    },
  });
  expectStatus(replay, 200, 'replay accepted');
  assert.equal((replay.body as { status: string }).status, 'duplicate');
  assert.equal((replay.body as { applied: boolean }).applied, false);

  const tasks = await api('GET', `/api/v1/hotel/housekeeping/tasks?hotelId=${hotelId}`, {
    token: t.token,
  });
  const taskRow = (tasks.body as { tasks: Array<{ id: string; status: string }> }).tasks.find(
    (x) => x.id === taskId,
  )!;
  assert.equal(taskRow.status, 'completed');

  // A later offline command for the same task conflicts rather than overwriting.
  const conflict = await api('POST', '/api/v1/sync/commands', {
    token: housekeeperToken,
    body: {
      deviceId: 'pwa-hk-1',
      commandId: `cmd-${Date.now()}-b`,
      commandType: 'housekeeping.task.complete',
      payload: { taskId },
    },
  });
  expectStatus(conflict, 200, 'conflict recorded');
  assert.equal((conflict.body as { status: string }).status, 'conflict');

  const conflicts = await api('GET', '/api/v1/sync/conflicts', { token: t.token });
  expectStatus(conflicts, 200, 'list conflicts');
  const list = (conflicts.body as { conflicts: Array<{ id: string; resolution: string }> }).conflicts;
  const pending = list.find((c) => c.resolution === 'pending');
  assert.ok(pending, 'the new conflict is listed as pending');
  const resolved = await api('POST', `/api/v1/sync/conflicts/${pending!.id}/resolve`, {
    token: t.token,
    body: { resolution: 'server_wins', note: 'Server state is authoritative' },
  });
  expectStatus(resolved, 200, 'resolve conflict');
});

test('reports reconcile with the posted ledger', async () => {
  const dashboard = await api('GET', `/api/v1/reports/dashboard?hotelId=${hotelId}`, {
    token: t.token,
  });
  expectStatus(dashboard, 200, 'dashboard');
  const body = dashboard.body as {
    ledger: { totalDebit: number; totalCredit: number; balanced: boolean };
    rooms: { total: number };
    inHouse: number;
  };
  assert.equal(body.ledger.balanced, true);
  assert.equal(body.rooms.total, 3);
  assert.ok(body.inHouse >= 2);

  const trial = await api('GET', '/api/v1/finance/trial-balance', { token: t.token });
  expectStatus(trial, 200, 'trial balance');
  const trialBody = trial.body as { balanced: boolean; totalDebit: number; totalCredit: number };
  assert.equal(trialBody.balanced, true);
  assert.ok(trialBody.totalDebit > 0);

  const sales = await api('GET', '/api/v1/reports/daily-sales', { token: t.token });
  expectStatus(sales, 200, 'daily sales');
  const restaurantRows = (sales.body as { restaurant: Array<{ total: number }> }).restaurant;
  assert.ok(restaurantRows.reduce((sum, r) => sum + r.total, 0) > 0, 'paid restaurant sales are reported');
});

test('payroll computes statutory deductions, posts once and settles net pay', async () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  const first = await api('POST', '/api/v1/workforce/employees', {
    token: t.token,
    body: {
      fullName: 'Ada Okafor',
      jobTitle: 'Front Office Manager',
      department: 'Rooms',
      hireDate: '2024-01-15',
      baseSalary: 300000,
    },
  });
  expectStatus(first, 200, 'create employee');
  const firstId = (first.body as { id: string }).id;

  const second = await api('POST', '/api/v1/workforce/employees', {
    token: t.token,
    body: {
      fullName: 'Bola Adeyemi',
      jobTitle: 'Chef de Partie',
      department: 'Kitchen',
      hireDate: '2024-03-01',
      baseSalary: 150000,
    },
  });
  expectStatus(second, 200, 'create second employee');

  const employees = await api('GET', '/api/v1/workforce/employees', { token: t.token });
  expectStatus(employees, 200, 'list employees');
  assert.equal((employees.body as { employees: unknown[] }).employees.length, 2);

  // Rostering rejects overlapping shifts for the same employee.
  const shift = await api('POST', '/api/v1/workforce/shifts', {
    token: t.token,
    body: {
      employeeId: firstId,
      startsAt: '2030-01-10T09:00:00Z',
      endsAt: '2030-01-10T17:00:00Z',
      shiftRole: 'Front desk',
    },
  });
  expectStatus(shift, 200, 'create shift');
  const overlap = await api('POST', '/api/v1/workforce/shifts', {
    token: t.token,
    body: {
      employeeId: firstId,
      startsAt: '2030-01-10T12:00:00Z',
      endsAt: '2030-01-10T20:00:00Z',
    },
  });
  expectStatus(overlap, 409, 'overlapping shift rejected');

  const run = await api('POST', '/api/v1/workforce/payroll-runs', {
    token: t.token,
    body: { periodStart, periodEnd },
  });
  expectStatus(run, 200, 'create payroll run');
  const runId = (run.body as { id: string }).id;
  assert.equal((run.body as { gross: number }).gross, 450000);

  const duplicate = await api('POST', '/api/v1/workforce/payroll-runs', {
    token: t.token,
    body: { periodStart, periodEnd },
  });
  expectStatus(duplicate, 409, 'duplicate payroll period rejected');

  const detail = await api('GET', `/api/v1/workforce/payroll-runs/${runId}`, { token: t.token });
  expectStatus(detail, 200, 'payroll detail');
  const payslips = (detail.body as { payslips: Array<Record<string, number>> }).payslips;
  assert.equal(payslips.length, 2);
  for (const slip of payslips) {
    assert.ok(slip.paye > 0, 'PAYE is calculated');
    assert.equal(slip.pension_employee, Math.round(slip.gross * 0.08 * 10000) / 10000);
    assert.equal(
      slip.net,
      Math.round((slip.gross - slip.paye - slip.pension_employee) * 10000) / 10000,
    );
  }

  const posted = await api('POST', `/api/v1/workforce/payroll-runs/${runId}/post`, {
    token: t.token,
    body: {},
  });
  expectStatus(posted, 200, 'post payroll');
  const journalId = (posted.body as { journalEntryId: string }).journalEntryId;
  assert.ok(journalId);

  const gross = Number((detail.body as { run: { gross_total: number } }).run.gross_total);
  const paye = Number((detail.body as { run: { paye_total: number } }).run.paye_total);
  const pension = Number((detail.body as { run: { pension_total: number } }).run.pension_total);
  const net = Number((detail.body as { run: { net_total: number } }).run.net_total);
  const employerPension = payslips.reduce((sum, slip) => sum + slip.pension_employer, 0);

  assert.equal(await netBalance('6000'), gross + employerPension);
  assert.equal(await netBalance('2200'), -(paye + pension));
  assert.equal(await netBalance('2300'), -net);

  const repost = await api('POST', `/api/v1/workforce/payroll-runs/${runId}/post`, {
    token: t.token,
    body: {},
  });
  expectStatus(repost, 409, 'payroll cannot post twice');

  const paid = await api('POST', `/api/v1/workforce/payroll-runs/${runId}/payment`, {
    token: t.token,
    body: {},
  });
  expectStatus(paid, 200, 'pay payroll');
  assert.equal(await netBalance('2300'), 0);
  assert.ok(await netBalance('1010') < 0, 'bank account reduced by net pay');

  const repay = await api('POST', `/api/v1/workforce/payroll-runs/${runId}/payment`, {
    token: t.token,
    body: {},
  });
  expectStatus(repay, 409, 'payroll cannot be paid twice');
});

test('fixed assets capitalise, depreciate once per month and derecognise on disposal', async () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  const created = await api('POST', '/api/v1/assets', {
    token: t.token,
    body: {
      assetCode: 'FA-1001',
      assetName: 'Delivery Van',
      category: 'Vehicles',
      acquisitionDate: periodStart,
      acquisitionCost: 1200000,
      salvageValue: 0,
      usefulLifeMonths: 12,
    },
  });
  expectStatus(created, 200, 'create asset');
  const assetId = (created.body as { id: string }).id;

  assert.equal(await netBalance('1500'), 1200000);

  const run = await api('POST', '/api/v1/assets/depreciation-runs', {
    token: t.token,
    body: { periodStart, periodEnd },
  });
  expectStatus(run, 200, 'create depreciation run');
  const runId = (run.body as { id: string }).id;
  assert.equal((run.body as { total: number }).total, 100000);

  const duplicate = await api('POST', '/api/v1/assets/depreciation-runs', {
    token: t.token,
    body: { periodStart, periodEnd },
  });
  expectStatus(duplicate, 409, 'duplicate depreciation month rejected');

  const posted = await api('POST', `/api/v1/assets/depreciation-runs/${runId}/post`, {
    token: t.token,
    body: {},
  });
  expectStatus(posted, 200, 'post depreciation');
  assert.equal(await netBalance('6600'), 100000);
  assert.equal(await netBalance('1510'), -100000);

  const assets = await api('GET', '/api/v1/assets', { token: t.token });
  expectStatus(assets, 200, 'list assets');
  const asset = (
    assets.body as { assets: Array<{ id: string; accumulated_depreciation: number; net_book_value: number }> }
  ).assets.find((a) => a.id === assetId)!;
  assert.equal(asset.accumulated_depreciation, 100000);
  assert.equal(asset.net_book_value, 1100000);

  const disposed = await api('POST', `/api/v1/assets/${assetId}/dispose`, {
    token: t.token,
    body: { disposedOn: periodEnd, proceeds: 1050000 },
  });
  expectStatus(disposed, 200, 'dispose asset');
  assert.equal((disposed.body as { loss: number }).loss, 50000);
  assert.equal(await netBalance('6700'), 50000);
  assert.equal(await netBalance('1500'), 0);
  assert.equal(await netBalance('1510'), 0);

  const again = await api('POST', `/api/v1/assets/${assetId}/dispose`, {
    token: t.token,
    body: { disposedOn: periodEnd, proceeds: 0 },
  });
  expectStatus(again, 409, 'asset cannot be disposed twice');
});

function nextWeekday(target: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const delta = (target - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

test('maintenance depth: trades, checklist engine, fault routing and four-eyes verification', async () => {
  const teams = await api('GET', `/api/v1/hotel/maintenance/teams?hotelId=${hotelId}`, {
    token: t.token,
  });
  expectStatus(teams, 200, 'list trades');
  const trades = (teams.body as { teams: Array<{ trade: string }> }).teams.map((row) => row.trade);
  assert.ok(trades.includes('electrical'), 'Electrical trade exists');
  assert.ok(trades.includes('plumbing'), 'Plumbing trade exists');

  const locations = await api('GET', `/api/v1/hotel/maintenance/locations?hotelId=${hotelId}`, {
    token: t.token,
  });
  expectStatus(locations, 200, 'list locations');
  assert.ok(
    (locations.body as { locations: Array<{ category: string }> }).locations.some(
      (row) => row.category === 'guest_room',
    ),
    'guest rooms are a first-class location category',
  );

  const template = await api('POST', '/api/v1/hotel/maintenance/checklists', {
    token: t.token,
    body: {
      hotelId,
      templateCode: 'ELEC-TUE-FRI',
      templateName: 'Electrical room check',
      department: 'maintenance',
      locationCategory: 'guest_room',
      frequency: 'selected_days',
      daysOfWeek: [2, 5],
      requiresVerification: true,
      items: [
        {
          itemCode: 'LIGHTS',
          prompt: 'All room lights and switches work',
          inputType: 'pass_fail',
          faultCategory: 'electrical',
        },
        {
          itemCode: 'SOCKET',
          prompt: 'Sockets and faceplates are intact',
          inputType: 'pass_fail',
          faultCategory: 'electrical',
        },
        {
          itemCode: 'VOLT',
          prompt: 'Voltage reading at the desk socket',
          inputType: 'numeric',
          unit: 'V',
          isMandatory: false,
        },
      ],
    },
  });
  expectStatus(template, 200, 'create checklist template');

  const tuesday = nextWeekday(2);
  const generated = await api('POST', '/api/v1/hotel/maintenance/checklists/generate', {
    token: t.token,
    body: { hotelId, date: tuesday },
  });
  expectStatus(generated, 200, 'generate checklists');
  assert.equal((generated.body as { created: number }).created, 3, 'one instance per room');

  const repeated = await api('POST', '/api/v1/hotel/maintenance/checklists/generate', {
    token: t.token,
    body: { hotelId, date: tuesday },
  });
  expectStatus(repeated, 200, 'regenerate checklists');
  assert.equal((repeated.body as { created: number }).created, 0, 'regeneration creates no duplicates');

  const instances = await api(
    'GET',
    `/api/v1/hotel/maintenance/checklist-instances?hotelId=${hotelId}&status=pending`,
    { token: t.token },
  );
  expectStatus(instances, 200, 'list instances');
  const instance = (
    instances.body as { instances: Array<{ id: string; template_name: string }> }
  ).instances.find((row) => row.template_name === 'Electrical room check')!;
  assert.ok(instance, 'generated instance is listed');

  const detail = await api('GET', `/api/v1/hotel/maintenance/checklist-instances/${instance.id}`, {
    token: t.token,
  });
  expectStatus(detail, 200, 'instance detail');

  const incomplete = await api(
    'POST',
    `/api/v1/hotel/maintenance/checklist-instances/${instance.id}/complete`,
    { token: t.token, body: { results: [] } },
  );
  expectStatus(incomplete, 400, 'mandatory items cannot be left blank');

  const items = (
    detail.body as { items: Array<{ id: string; item_code: string; is_mandatory: boolean }> }
  ).items;
  const results = items
    .filter((item) => item.item_code !== 'VOLT')
    .map((item) => ({
      itemId: item.id,
      result: item.item_code === 'SOCKET' ? 'fail' : 'pass',
      remark: item.item_code === 'SOCKET' ? 'Faceplate cracked' : 'Checked',
    }));
  const completed = await api(
    'POST',
    `/api/v1/hotel/maintenance/checklist-instances/${instance.id}/complete`,
    { token: t.token, body: { results, note: 'Room inspection' } },
  );
  expectStatus(completed, 200, 'complete checklist');
  assert.equal((completed.body as { faults: number }).faults, 1, 'failed item raises one fault');

  const requests = await api('GET', '/api/v1/hotel/maintenance/requests', { token: t.token });
  expectStatus(requests, 200, 'list requests');
  const fault = (
    requests.body as { requests: Array<{ id: string; description: string; status: string }> }
  ).requests.find((row) => row.description.includes('Sockets and faceplates'))!;
  assert.ok(fault, 'fault is visible to maintenance');

  const routed = await sql<{
    trade: string;
    affects_room_readiness: boolean;
    sla_due_at: string | null;
    category: string;
  }>(
    `SELECT t.trade, r.affects_room_readiness, r.sla_due_at, r.category
       FROM maintenance.requests r
       JOIN maintenance.teams t ON t.id = r.team_id
      WHERE r.id = $1`,
    [fault.id],
  );
  assert.equal(routed[0]!.trade, 'electrical', 'fault routed to the Electrical trade');
  assert.equal(routed[0]!.category, 'electrical');
  assert.equal(routed[0]!.affects_room_readiness, true, 'room fault affects readiness');
  assert.ok(routed[0]!.sla_due_at, 'SLA due time is set from policy');

  const approved = await api(
    'POST',
    `/api/v1/hotel/maintenance/requests/${fault.id}/approve`,
    { token: managerToken, body: {} },
  );
  expectStatus(approved, 200, 'approve fault');

  const workOrder = await api('POST', '/api/v1/hotel/maintenance/work-orders', {
    token: t.token,
    body: { requestId: fault.id },
  });
  expectStatus(workOrder, 200, 'convert fault to work order');
  const workOrderId = (workOrder.body as { workOrderId: string }).workOrderId;

  await sql(
    `UPDATE maintenance.work_orders
        SET affects_room_readiness = true, verification_required = true
      WHERE id = $1`,
    [workOrderId],
  );

  const done = await api('POST', `/api/v1/hotel/maintenance/work-orders/${workOrderId}/complete`, {
    token: t.token,
    body: { resolutionNote: 'Replaced the faceplate' },
  });
  expectStatus(done, 200, 'complete work order');

  const selfVerified = await api(
    'POST',
    `/api/v1/hotel/maintenance/work-orders/${workOrderId}/transition`,
    { token: t.token, body: { status: 'verified', reason: 'Looks fine' } },
  );
  expectStatus(selfVerified, 403, 'completer cannot verify their own work');

  const verified = await api(
    'POST',
    `/api/v1/hotel/maintenance/work-orders/${workOrderId}/transition`,
    { token: managerToken, body: { status: 'verified', reason: 'Checked on site' } },
  );
  expectStatus(verified, 200, 'a second user verifies');
  assert.equal((verified.body as { status: string }).status, 'verified');

  const history = await api('GET', `/api/v1/hotel/maintenance/rooms/${t.room101}/history`, {
    token: t.token,
  });
  expectStatus(history, 200, 'room maintenance history');
  assert.ok((history.body as { workOrders: unknown[] }).workOrders.length >= 1);
});

test('room readiness is blocked while a room-affecting work order is open', async () => {
  const task = await api('POST', '/api/v1/hotel/housekeeping/tasks', {
    token: t.token,
    body: { hotelId, roomId: t.room201, taskCode: 'CHECKOUT_CLEAN' },
  });
  expectStatus(task, 200, 'create readiness task');
  const taskId = (task.body as { taskId: string }).taskId;

  const complete = await api('POST', `/api/v1/hotel/housekeeping/tasks/${taskId}/complete`, {
    token: t.token,
    body: { notes: 'Cleaned' },
  });
  expectStatus(complete, 200, 'complete readiness task');

  const fault = await api('POST', '/api/v1/hotel/maintenance/faults', {
    token: t.token,
    body: {
      hotelId,
      roomId: t.room201,
      category: 'plumbing',
      description: 'Shower drain blocked',
      source: 'housekeeping',
      affectsRoomReadiness: true,
    },
  });
  expectStatus(fault, 200, 'housekeeping hands off a plumbing fault');
  const requestId = (fault.body as { requestId: string }).requestId;

  const routed = await sql<{ trade: string }>(
    `SELECT t.trade FROM maintenance.requests r JOIN maintenance.teams t ON t.id = r.team_id WHERE r.id = $1`,
    [requestId],
  );
  assert.equal(routed[0]!.trade, 'plumbing', 'plumbing fault routes to the Plumbing trade');

  const approve = await api('POST', `/api/v1/hotel/maintenance/requests/${requestId}/approve`, {
    token: managerToken,
    body: {},
  });
  expectStatus(approve, 200, 'approve plumbing fault');

  const workOrder = await api('POST', '/api/v1/hotel/maintenance/work-orders', {
    token: t.token,
    body: { requestId },
  });
  expectStatus(workOrder, 200, 'create plumbing work order');
  const workOrderId = (workOrder.body as { workOrderId: string }).workOrderId;
  await sql('UPDATE maintenance.work_orders SET affects_room_readiness = true WHERE id = $1', [
    workOrderId,
  ]);

  const blocked = await api('POST', `/api/v1/hotel/housekeeping/tasks/${taskId}/inspect`, {
    token: t.token,
    body: { result: 'passed', score: 95 },
  });
  expectStatus(blocked, 409, 'room cannot be released with maintenance open');
  assert.equal((blocked.body as { error: { code: string } }).error.code, 'ROOM_MAINTENANCE_HOLD');

  const cancelled = await api(
    'POST',
    `/api/v1/hotel/maintenance/work-orders/${workOrderId}/transition`,
    { token: managerToken, body: { status: 'cancelled', reason: 'Duplicate of an earlier repair' } },
  );
  expectStatus(cancelled, 200, 'cancel work order with a reason');

  const released = await api('POST', `/api/v1/hotel/housekeeping/tasks/${taskId}/inspect`, {
    token: t.token,
    body: { result: 'passed', score: 95 },
  });
  expectStatus(released, 200, 'room is released once maintenance is closed');
  assert.equal((released.body as { roomReadiness: string }).roomReadiness, 'inspected');
});

test('maintenance SLA policies are configurable per hotel', async () => {
  const updated = await api('PATCH', '/api/v1/hotel/maintenance/sla-policies', {
    token: t.token,
    body: { hotelId, priority: 'urgent', acknowledgeHours: 1, resolveHours: 2 },
  });
  expectStatus(updated, 200, 'update SLA policy');

  const before = Date.now();
  const safety = await api('POST', '/api/v1/hotel/maintenance/faults', {
    token: t.token,
    body: {
      hotelId,
      locationId: undefined,
      category: 'safety',
      description: 'Exposed wiring beside the lift lobby',
      source: 'manual',
    },
  });
  expectStatus(safety, 200, 'raise safety fault');
  assert.equal((safety.body as { priority: string }).priority, 'urgent', 'safety faults are urgent');

  const rows = await sql<{ hours: number }>(
    `SELECT extract(epoch FROM (sla_due_at - created_at)) / 3600 AS hours
       FROM maintenance.requests WHERE id = $1`,
    [(safety.body as { requestId: string }).requestId],
  );
  assert.ok(Number(rows[0]!.hours) <= 2.01, 'custom resolve target applied');
  assert.ok(Number(rows[0]!.hours) > 1.5);
  assert.ok(Date.now() >= before);

  const policies = await api('GET', `/api/v1/hotel/maintenance/sla-policies?hotelId=${hotelId}`, {
    token: t.token,
  });
  expectStatus(policies, 200, 'read SLA policies');
  const urgent = (
    policies.body as { policies: Array<{ priority: string; resolve_hours: number }> }
  ).policies.find((row) => row.priority === 'urgent')!;
  assert.equal(urgent.resolve_hours, 2);
});
