import './env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeAll, getAdmin, login, sql, uniqueCode } from './helpers.js';
import { bootstrapTenant } from '../src/services/onboarding.js';

after(async () => {
  await closeAll();
});

test('licensing activation is scoped to the product that owns the module instance', async () => {
  const admin = await getAdmin();
  const tenantCode = uniqueCode('ps');
  const adminEmail = `admin.${tenantCode}@test.local`;
  await admin.query('BEGIN');
  try {
    await bootstrapTenant(
      admin,
      {
        tenantCode,
        tenantName: 'Product scoped licensing',
        adminEmail,
        adminPassword: 'TestPassw0rd!2026',
        adminName: 'Test Admin',
        products: ['restaurant', 'bar'],
        branches: [{ code: 'BR1', name: 'Main branch', type: 'mixed' }],
        restaurant: { code: 'RES', name: 'Restaurant Test' },
        bar: { code: 'BAR', name: 'Bar Test' },
      },
      'test:product-scoping',
    );
    await admin.query('COMMIT');
  } catch (err) {
    await admin.query('ROLLBACK');
    throw err;
  }

  const token = await login(adminEmail, tenantCode);

  // Shared-module activation without a product is ambiguous and rejected.
  const ambiguous = await api('POST', '/api/v1/licensing/modules/ordering/deactivate', {
    token,
    body: {},
  });
  assert.equal(ambiguous.status, 400, 'activation without product must be rejected');

  // A module cannot be activated through a product that does not own it.
  const wrongProduct = await api('POST', '/api/v1/licensing/modules/ordering/deactivate', {
    token,
    body: { product: 'bar' },
  });
  assert.equal(wrongProduct.status, 400, 'module does not belong to requested product');

  // Deactivating restaurant ordering blocks the restaurant ordering gate.
  const deactivate = await api('POST', '/api/v1/licensing/modules/ordering/deactivate', {
    token,
    body: { product: 'restaurant' },
  });
  assert.equal(deactivate.status, 200, 'deactivate restaurant ordering');

  const blocked = await api('POST', '/api/v1/restaurant/orders', { token, body: {} });
  assert.equal(blocked.status, 402, 'unlicensed shared module route is blocked');

  // Reactivating restores it.
  const reactivate = await api('POST', '/api/v1/licensing/modules/ordering/activate', {
    token,
    body: { product: 'restaurant' },
  });
  assert.equal(reactivate.status, 200, 'reactivate restaurant ordering');

  // `recipes` is a shared capability code: each product owns its own copy.
  // Deactivating the bar copy must block bar recipes without touching restaurant ones.
  const deactivateBarRecipes = await api('POST', '/api/v1/licensing/modules/recipes/deactivate', {
    token,
    body: { product: 'bar' },
  });
  assert.equal(deactivateBarRecipes.status, 200, 'deactivate bar recipes');

  const fakeId = '00000000-0000-4000-8000-000000000001';
  const barBlocked = await api('POST', `/api/v1/bar/beverages/${fakeId}/recipe`, {
    token,
    body: { ingredients: [] },
  });
  assert.equal(barBlocked.status, 402, 'bar recipes blocked after bar deactivation');

  // Restaurant recipes gate is independent: it must not return 402.
  const restaurantStillOpen = await api('POST', `/api/v1/restaurant/menu-items/${fakeId}/recipe`, {
    token,
    body: { ingredients: [] },
  });
  assert.notEqual(
    restaurantStillOpen.status,
    402,
    'restaurant recipes unaffected by bar deactivation',
  );

  // `core` is also shared: bar outlets and restaurant outlets gate independently.
  const deactivateBarCore = await api('POST', '/api/v1/licensing/modules/core/deactivate', {
    token,
    body: { product: 'bar' },
  });
  assert.equal(deactivateBarCore.status, 200, 'deactivate bar core');

  const barOutletsBlocked = await api('GET', '/api/v1/bar/outlets', { token });
  assert.equal(barOutletsBlocked.status, 402, 'bar outlets blocked after bar core deactivation');

  const restaurantOutletsOpen = await api('GET', '/api/v1/restaurant/outlets', { token });
  assert.equal(restaurantOutletsOpen.status, 200, 'restaurant outlets unaffected by bar deactivation');

  // Public QR ordering respects restaurant licensing: deactivating menu_qr locks the QR channel.
  const outlet = await sql<{ id: string }>(
    'SELECT id FROM restaurant.outlets WHERE tenant_id = (SELECT id FROM platform.tenants WHERE tenant_code = $1)',
    [tenantCode],
  );
  const createdToken = await api('POST', `/api/v1/restaurant/outlets/${outlet[0]!.id}/qr`, {
    token,
    body: { label: 'Window' },
  });
  assert.equal(createdToken.status, 200, 'create QR token');
  const qrToken = (createdToken.body as { token: string }).token;

  const qrMenuOpen = await api('GET', `/api/v1/public/qr/${qrToken}/menu`);
  assert.equal(qrMenuOpen.status, 200, 'public QR menu works while licensed');

  const deactivateMenuQr = await api('POST', '/api/v1/licensing/modules/menu_qr/deactivate', {
    token,
    body: { product: 'restaurant' },
  });
  assert.equal(deactivateMenuQr.status, 200, 'deactivate restaurant menu_qr');

  const qrMenuLocked = await api('GET', `/api/v1/public/qr/${qrToken}/menu`);
  assert.equal(qrMenuLocked.status, 402, 'public QR menu locked after menu_qr deactivation');
});

test('hotel reservations are gated on the hotel copy of the shared module', async () => {
  const admin = await getAdmin();
  const tenantCode = uniqueCode('psh');
  const adminEmail = `admin.${tenantCode}@test.local`;
  await admin.query('BEGIN');
  try {
    await bootstrapTenant(
      admin,
      {
        tenantCode,
        tenantName: 'Hotel scoped licensing',
        adminEmail,
        adminPassword: 'TestPassw0rd!2026',
        adminName: 'Test Admin',
        products: ['hotel', 'restaurant'],
        branches: [{ code: 'HQ', name: 'Head Office', type: 'hotel' }],
        hotel: { code: 'TST', name: 'Test Hotel', roomTypes: [{ code: 'STD', name: 'Standard', baseRate: 50000, rooms: ['101'] }] },
        restaurant: { code: 'RES', name: 'Restaurant Test' },
      },
      'test:product-scoping-hotel',
    );
    await admin.query('COMMIT');
  } catch (err) {
    await admin.query('ROLLBACK');
    throw err;
  }

  const token = await login(adminEmail, tenantCode);
  const hotel = await sql<{ id: string }>(
    'SELECT id FROM hotel.hotels WHERE tenant_id = (SELECT id FROM platform.tenants WHERE tenant_code = $1)',
    [tenantCode],
  );
  const hotelId = hotel[0]!.id;
  const availabilityUrl =
    `/api/v1/hotel/availability?hotelId=${hotelId}&from=2030-01-01&to=2030-01-02`;

  // Deactivating the restaurant copy must not lock hotel reservations.
  const deactivateRestaurantReservations = await api(
    'POST',
    '/api/v1/licensing/modules/reservations/deactivate',
    { token, body: { product: 'restaurant' } },
  );
  assert.equal(deactivateRestaurantReservations.status, 200, 'deactivate restaurant reservations');

  const hotelOpen = await api('GET', availabilityUrl, { token });
  assert.equal(hotelOpen.status, 200, 'hotel reservations unaffected by restaurant deactivation');

  // Deactivating the hotel copy locks the hotel routes.
  const deactivateHotelReservations = await api(
    'POST',
    '/api/v1/licensing/modules/reservations/deactivate',
    { token, body: { product: 'hotel' } },
  );
  assert.equal(deactivateHotelReservations.status, 200, 'deactivate hotel reservations');

  const hotelBlocked = await api('GET', availabilityUrl, { token });
  assert.equal(hotelBlocked.status, 402, 'hotel reservations blocked after hotel deactivation');
});
