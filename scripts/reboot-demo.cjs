import 'dotenv/config';
import pg from 'pg';
import { bootstrapTenant } from './apps/api/dist/services/onboarding.js';
import { login } from './apps/api/dist/services/auth.js';

const adminClient = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await adminClient.connect();

// Check if demo tenant exists
const { rows: existing } = await adminClient.query('SELECT tenant_code FROM platform.tenants WHERE tenant_code = $1', ['demo']);
if (existing.length) {
  console.log('Demo tenant already exists, skipping bootstrap');
} else {
  await adminClient.query('BEGIN');
  try {
    const result = await bootstrapTenant(adminClient, {
      tenantCode: 'demo',
      tenantName: 'Demo Harbour Hotel',
      adminEmail: 'admin@demo.local',
      adminName: 'Demo Manager',
      adminPassword: 'DemoPassw0rd!2026',
      defaultCurrency: 'NGN',
      products: ['hotel', 'restaurant', 'bar'],
      branches: [
        { code: 'DEMO', name: 'Demo Harbour Hotel', type: 'hotel' },
        { code: 'DEMOR', name: 'Demo Harbour Restaurant', type: 'restaurant' },
        { code: 'DEMOB', name: 'Demo Harbour Bar', type: 'bar' },
      ],
      hotel: {
        code: 'DEMO',
        name: 'Demo Harbour Hotel',
        roomTypes: [
          { code: 'STD', name: 'Standard Room', baseRate: 50000, rooms: ['101', '102', '103', '104'] },
          { code: 'DLX', name: 'Deluxe Room', baseRate: 85000, rooms: ['201', '202', '203'] },
        ],
      },
      restaurant: {
        code: 'DEMOR',
        name: 'Demo Harbour Restaurant',
        outletType: 'dine_in',
        taxRate: 0.075,
        serviceChargeRate: 0.1,
        payBeforeOrder: false,
        tables: [{ code: 'T1', seats: 4 }, { code: 'T2', seats: 4 }],
        stations: [{ code: 'KITCHEN', name: 'Main Kitchen' }],
      },
      bar: {
        code: 'DEMOB',
        name: 'Demo Harbour Bar',
        barType: 'lounge',
        taxRate: 0.075,
      },
    });
    await adminClient.query('COMMIT');
    console.log('BOOTSTRAP OK: tenantId=' + result.tenantId.substring(0,8) + ' adminUserId=' + result.adminUserId.substring(0,8));
  } catch (err) {
    await adminClient.query('ROLLBACK');
    console.error('BOOTSTRAP FAILED:', err.message);
    process.exit(1);
  }
}

// Now login and get a token
const apiBase = process.env.VITE_API_BASE ?? 'http://127.0.0.1:4000';
const token = await login(apiBase, 'admin@demo.local', 'DemoPassw0rd!2026');
console.log('LOGIN OK: token=' + token.substring(0, 20) + '...');
console.log('FULL_TOKEN:' + token);

await adminClient.end();
