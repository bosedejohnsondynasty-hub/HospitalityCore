#!/usr/bin/env node
/**
 * Provisions a tenant through the guarded first-run endpoint.
 *
 * The API must be running with ALLOW_API_SETUP=true and a SETUP_TOKEN.
 * Usage:
 *   SETUP_TOKEN=... node scripts/provision-tenant.mjs \
 *     --tenant-code lagosgrand --tenant-name "Lagos Grand" \
 *     --admin-email admin@lagosgrand.example --admin-name "Ada Admin" \
 *     --admin-password 'a-long-password-1' --products hotel,restaurant,bar
 */
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (has('--help') || has('-h') || args.length === 0) {
  console.log(`Hospitality Core tenant provisioning

Required (or provide --file payload.json):
  --tenant-code <code>          lowercase tenant identifier
  --tenant-name <name>
  --admin-email <email>
  --admin-name <name>
  --admin-password <password>   12+ chars, letter and number
Optional:
  --products hotel,restaurant,bar   default: hotel
  --currency NGN
  --api-url http://127.0.0.1:4000
  --file payload.json           full BootstrapInput JSON (overrides flags)
Environment:
  SETUP_TOKEN                   required, must match the server
`);
  process.exit(args.length === 0 ? 2 : 0);
}

const apiUrl = value('--api-url', process.env.API_URL ?? 'http://127.0.0.1:4000');
const setupToken = process.env.SETUP_TOKEN;
if (!setupToken) {
  console.error('SETUP_TOKEN is required');
  process.exit(2);
}

let payload;
const file = value('--file');
if (file) {
  payload = JSON.parse(readFileSync(file, 'utf8'));
} else {
  const tenantCode = value('--tenant-code');
  const tenantName = value('--tenant-name');
  const adminEmail = value('--admin-email');
  const adminName = value('--admin-name', 'Administrator');
  const adminPassword = value('--admin-password');
  const products = value('--products', 'hotel').split(',').map((p) => p.trim()).filter(Boolean);
  if (!tenantCode || !tenantName || !adminEmail || !adminPassword) {
    console.error('tenant code, tenant name, admin email and admin password are required');
    process.exit(2);
  }
  payload = {
    tenantCode,
    tenantName,
    adminEmail,
    adminName,
    adminPassword,
    defaultCurrency: value('--currency', 'NGN'),
    products,
    branches: products.map((code) => ({
      code: code.slice(0, 6).toUpperCase(),
      name: `${tenantName} ${code}`,
      type: code,
    })),
  };
  if (products.includes('hotel')) {
    payload.hotel = {
      code: tenantCode.slice(0, 6).toUpperCase(),
      name: `${tenantName} Hotel`,
      roomTypes: [
        { code: 'STD', name: 'Standard Room', baseRate: 50000, rooms: ['101', '102', '103'] },
        { code: 'DLX', name: 'Deluxe Room', baseRate: 85000, rooms: ['201', '202'] },
      ],
    };
  }
  if (products.includes('restaurant')) {
    payload.restaurant = {
      code: 'REST',
      name: `${tenantName} Restaurant`,
      tables: [{ code: 'T1', seats: 4 }],
      stations: [{ code: 'KITCHEN', name: 'Main Kitchen' }],
    };
  }
  if (products.includes('bar')) payload.bar = { code: 'BAR01', name: `${tenantName} Bar` };
}

const response = await fetch(`${apiUrl}/api/v1/setup/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-setup-token': setupToken },
  body: JSON.stringify(payload),
});

const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Provisioning failed (${response.status}):`, body?.error ?? body);
  process.exit(1);
}
console.log('Tenant provisioned');
console.log(JSON.stringify(body, null, 2));
if (existsSync('/dev/null')) {
  console.log('\nNext: sign in at the web client, then set ALLOW_API_SETUP=false and restart the API.');
}
