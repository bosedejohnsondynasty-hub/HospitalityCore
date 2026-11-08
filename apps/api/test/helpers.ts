import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { bootstrapTenant, type BootstrapInput } from '../src/services/onboarding.js';

export const PASSWORD = 'TestPassw0rd!2026';
export const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;

let app: FastifyInstance | undefined;
let admin: pg.Client | undefined;

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp({
    logger: process.env.TEST_VERBOSE === 'true' ? { level: 'error' } : false,
  });
  await app.ready();
  return app;
}

export async function getAdmin(): Promise<pg.Client> {
  if (!admin) {
    admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await admin.connect();
  }
  return admin;
}

export async function closeAll(): Promise<void> {
  await app?.close();
  app = undefined;
  if (admin) {
    await admin.end();
    admin = undefined;
  }
  const { closePools } = await import('../src/db.js');
  await closePools();
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const server = await getApp();
  const response = await server.inject({
    method,
    url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    payload: options.body as Record<string, unknown> | undefined,
  });
  let body: unknown = undefined;
  try {
    body = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body: body as T };
}

/** Superuser SQL for test fixtures and invariants the API must not allow. */
export async function sql<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const client = await getAdmin();
  const result = await client.query(query, params);
  return result.rows as T[];
}

export async function login(email: string, tenantCode?: string, password = PASSWORD): Promise<string> {
  const res = await api('POST', '/api/v1/auth/login', { body: { email, password, tenantCode } });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return (res.body as { token: string }).token;
}

export function uniqueCode(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.toLowerCase();
}

export interface SeededTenant {
  tenantId: string;
  tenantCode: string;
  adminEmail: string;
  token: string;
  hotelId: string;
  branchId: string;
  hotelBranchId: string;
  standardRoomTypeId: string;
  deluxeRoomTypeId: string;
  room101: string;
  room102: string;
  room201: string;
  outletId: string;
  barId: string;
  menuId: string;
  kitchenStationId: string;
  tableId: string;
  storeMain: string;
  storeKitchen: string;
  storeBar: string;
}

export async function seedTenant(
  overrides: Partial<BootstrapInput> = {},
): Promise<SeededTenant> {
  const client = await getAdmin();
  const tenantCode = overrides.tenantCode ?? uniqueCode('t');
  const adminEmail = overrides.adminEmail ?? `admin-${tenantCode}@test.local`;

  const input: BootstrapInput = {
    tenantCode,
    tenantName: 'Test Hospitality Group',
    adminEmail,
    adminPassword: PASSWORD,
    adminName: 'Test Administrator',
    products: ['hotel', 'restaurant', 'bar'],
    branches: [{ code: 'HQ', name: 'Head Office Hotel', type: 'hotel' }],
    hotel: {
      code: 'TST',
      name: 'Test Hotel',
      roomTypes: [
        { code: 'STD', name: 'Standard Room', baseRate: 50000, rooms: ['101', '102'] },
        { code: 'DLX', name: 'Deluxe Room', baseRate: 75000, rooms: ['201'] },
      ],
    },
    restaurant: {
      code: 'REST',
      name: 'Test Restaurant',
      tables: [{ code: 'T1', seats: 4 }],
      stations: [{ code: 'KITCHEN', name: 'Main Kitchen' }],
    },
    bar: { code: 'BAR01', name: 'Test Bar' },
    ...overrides,
  };

  await client.query('BEGIN');
  let result;
  try {
    result = await bootstrapTenant(client, input, 'test:harness');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  const hotel = await sql<{ id: string; branch_id: string }>(
    'SELECT h.id, h.branch_id FROM hotel.hotels h WHERE h.tenant_id = $1',
    [result.tenantId],
  );
  const roomTypes = await sql<{ id: string; room_type_code: string }>(
    'SELECT id, room_type_code FROM hotel.room_types WHERE tenant_id = $1',
    [result.tenantId],
  );
  const rooms = await sql<{ id: string; room_number: string }>(
    'SELECT id, room_number FROM hotel.rooms WHERE tenant_id = $1',
    [result.tenantId],
  );
  const outlet = await sql<{ id: string }>(
    'SELECT id FROM restaurant.outlets WHERE tenant_id = $1',
    [result.tenantId],
  );
  const bar = await sql<{ id: string }>('SELECT id FROM bar.outlets WHERE tenant_id = $1', [
    result.tenantId,
  ]);
  const menu = await sql<{ id: string }>('SELECT id FROM restaurant.menus WHERE tenant_id = $1', [
    result.tenantId,
  ]);
  const station = await sql<{ id: string }>(
    'SELECT id FROM restaurant.kitchen_stations WHERE tenant_id = $1',
    [result.tenantId],
  );
  const table = await sql<{ id: string }>(
    "SELECT id FROM restaurant.tables WHERE tenant_id = $1 AND table_code = 'T1'",
    [result.tenantId],
  );
  const stores = await sql<{ id: string; store_type: string }>(
    'SELECT id, store_type FROM inventory.stores WHERE tenant_id = $1',
    [result.tenantId],
  );

  const token = await login(adminEmail, tenantCode);

  return {
    tenantId: result.tenantId,
    tenantCode,
    adminEmail,
    token,
    hotelId: hotel[0]?.id ?? '',
    branchId: hotel[0]?.branch_id ?? result.branches[0]!.id,
    hotelBranchId: hotel[0]?.branch_id ?? result.branches[0]!.id,
    standardRoomTypeId: roomTypes.find((r) => r.room_type_code === 'STD')?.id ?? '',
    deluxeRoomTypeId: roomTypes.find((r) => r.room_type_code === 'DLX')?.id ?? '',
    room101: rooms.find((r) => r.room_number === '101')?.id ?? '',
    room102: rooms.find((r) => r.room_number === '102')?.id ?? '',
    room201: rooms.find((r) => r.room_number === '201')?.id ?? '',
    outletId: outlet[0]?.id ?? '',
    barId: bar[0]?.id ?? '',
    menuId: menu[0]?.id ?? '',
    kitchenStationId: station[0]?.id ?? '',
    tableId: table[0]?.id ?? '',
    storeMain: stores.find((s) => s.store_type === 'main')?.id ?? '',
    storeKitchen: stores.find((s) => s.store_type === 'kitchen')?.id ?? '',
    storeBar: stores.find((s) => s.store_type === 'bar')?.id ?? '',
  };
}

export function paystackSignature(rawBody: string, secret = PAYSTACK_SECRET): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export function paystackEvent(options: {
  reference: string;
  amountMajor: number;
  status?: string;
  eventId?: string;
  currency?: string;
}): { raw: string; signature: string } {
  const payload = {
    event: 'charge.success',
    data: {
      id: options.eventId ?? randomUUID(),
      reference: options.reference,
      amount: Math.round(options.amountMajor * 100),
      currency: options.currency ?? 'NGN',
      status: options.status ?? 'success',
      channel: 'card',
      fees: 0,
    },
  };
  const raw = JSON.stringify(payload);
  return { raw, signature: paystackSignature(raw) };
}

export async function webhook(
  provider: 'paystack' | 'flutterwave',
  raw: string,
  headers: Record<string, string>,
): Promise<ApiResponse> {
  const server = await getApp();
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/webhooks/${provider}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: raw,
  });
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body };
}

export function expectStatus(res: ApiResponse, status: number, context: string): void {
  if (res.status !== status) {
    throw new Error(`${context}: expected ${status}, received ${res.status} ${JSON.stringify(res.body)}`);
  }
}
