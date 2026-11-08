import type { Queryable } from '../db.js';
import { AppError, conflict, badRequest, moduleNotLicensed } from '../errors.js';
import { DEFAULT_COA, GL, ROLE_TEMPLATES, matchesPatterns } from '../catalogue.js';
import { hashPassword } from '../security.js';
import { audit } from '../audit.js';

export interface BootstrapInput {
  tenantCode: string;
  tenantName: string;
  countryCode?: string;
  currency?: string;
  timezone?: string;
  organizationCode?: string;
  organizationName?: string;
  adminEmail: string;
  adminPassword: string;
  adminName: string;
  products: Array<'hotel' | 'restaurant' | 'bar'>;
  branches: Array<{ code: string; name: string; type: 'hotel' | 'restaurant' | 'bar' | 'mixed'; currency?: string }>;
  hotel?: {
    code: string;
    name: string;
    starRating?: number;
    taxRate?: number;
    serviceChargeRate?: number;
    roomTypes: Array<{ code: string; name: string; baseRate: number; rooms: string[]; capacityAdults?: number; capacityChildren?: number }>;
  };
  restaurant?: {
    code: string;
    name: string;
    outletType?: string;
    taxRate?: number;
    serviceChargeRate?: number;
    payBeforeOrder?: boolean;
    tables?: Array<{ code: string; seats: number }>;
    stations?: Array<{ code: string; name: string }>;
  };
  bar?: { code: string; name: string; barType?: string; taxRate?: number };
}

export interface BootstrapResult {
  tenantId: string;
  organizationId: string;
  legalEntityId: string;
  branches: Array<{ id: string; code: string }>;
  adminUserId: string;
  hotelId?: string;
  restaurantOutletId?: string;
  barOutletId?: string;
  products: string[];
  modulesActivated: number;
}

/**
 * First-run provisioning of a tenant.
 *
 * Runs with the schema owner connection (RLS bypass) because the tenant does not
 * exist yet. Afterwards the runtime role is used for everything else.
 */
export async function bootstrapTenant(
  db: Queryable,
  input: BootstrapInput,
  actorLabel = 'system:setup',
): Promise<BootstrapResult> {
  if (input.products.length === 0) throw badRequest('At least one product must be selected');
  if (input.branches.length === 0) throw badRequest('At least one branch is required');
  if (input.products.includes('hotel') && !input.hotel) {
    throw badRequest('Hotel ERP requires hotel configuration (room types and rooms)');
  }
  if (input.products.includes('restaurant') && !input.restaurant) {
    throw badRequest('Restaurant management requires outlet configuration');
  }
  if (input.products.includes('bar') && !input.bar) {
    throw badRequest('Bar management requires outlet configuration');
  }
  if (!/^[a-z0-9_]{3,50}$/.test(input.tenantCode)) {
    throw badRequest('tenantCode must be 3-50 lowercase letters, digits or underscores');
  }

  const existing = await db.query('SELECT 1 FROM platform.tenants WHERE tenant_code = $1', [
    input.tenantCode,
  ]);
  if (existing.rowCount) throw conflict('TENANT_EXISTS', 'Tenant code already exists');

  const currency = (input.currency ?? 'NGN').toUpperCase();
  const tenant = await db.query<{ id: string }>(
    `INSERT INTO platform.tenants (tenant_code, tenant_name, country_code, default_currency, timezone)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      input.tenantCode,
      input.tenantName,
      (input.countryCode ?? 'NG').toUpperCase(),
      currency,
      input.timezone ?? 'Africa/Lagos',
    ],
  );
  const tenantId = tenant.rows[0]!.id;

  const orgCode = input.organizationCode ?? `${input.tenantCode}_org`;
  const org = await db.query<{ id: string }>(
    `INSERT INTO platform.organizations (tenant_id, organization_code, organization_name)
     VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, orgCode, input.organizationName ?? input.tenantName],
  );
  const organizationId = org.rows[0]!.id;

  const entity = await db.query<{ id: string }>(
    `INSERT INTO platform.legal_entities
       (tenant_id, organization_id, entity_code, entity_name, base_currency)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, organizationId, `${tenantCodeOf(input)}_le`, input.tenantName, currency],
  );
  const legalEntityId = entity.rows[0]!.id;

  const branches: Array<{ id: string; code: string; type: string }> = [];
  for (const branch of input.branches) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO platform.branches
         (tenant_id, organization_id, legal_entity_id, branch_code, branch_name, branch_type, currency_code, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        tenantId,
        organizationId,
        legalEntityId,
        branch.code,
        branch.name,
        branch.type,
        (branch.currency ?? currency).toUpperCase(),
        input.timezone ?? 'Africa/Lagos',
      ],
    );
    const branchId = row.rows[0]!.id;
    branches.push({ id: branchId, code: branch.code, type: branch.type });

    for (const dept of departmentSet(branch.type)) {
      await db.query(
        `INSERT INTO platform.departments
           (tenant_id, organization_id, branch_id, department_code, department_name)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, organizationId, branchId, dept.code, dept.name],
      );
    }
    await db.query(
      `INSERT INTO inventory.stores (tenant_id, branch_id, store_code, store_name, store_type)
       VALUES ($1,$2,'MAIN','Main Store','main')`,
      [tenantId, branchId],
    );
    if (input.products.includes('restaurant')) {
      await db.query(
        `INSERT INTO inventory.stores (tenant_id, branch_id, store_code, store_name, store_type)
         VALUES ($1,$2,'KITCHEN','Kitchen Store','kitchen')`,
        [tenantId, branchId],
      );
    }
    if (input.products.includes('bar')) {
      await db.query(
        `INSERT INTO inventory.stores (tenant_id, branch_id, store_code, store_name, store_type)
         VALUES ($1,$2,'BAR','Bar Store','bar')`,
        [tenantId, branchId],
      );
    }
  }

  const admin = await db.query<{ id: string }>(
    `INSERT INTO identity.users (tenant_id, email, password_hash, full_name)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [tenantId, input.adminEmail.toLowerCase(), hashPassword(input.adminPassword), input.adminName],
  );
  const adminUserId = admin.rows[0]!.id;

  // Roles + permissions from the templates.
  const allPermissions = await db.query<{ id: string; permission_code: string }>(
    'SELECT id, permission_code FROM access.permissions',
  );
  const roleIds = new Map<string, string>();
  for (const template of ROLE_TEMPLATES) {
    const role = await db.query<{ id: string }>(
      `INSERT INTO access.roles (tenant_id, role_code, role_name, description, is_system)
       VALUES ($1,$2,$3,$4,true) RETURNING id`,
      [tenantId, template.code, template.name, template.description],
    );
    const roleId = role.rows[0]!.id;
    roleIds.set(template.code, roleId);
    const matching = allPermissions.rows.filter((p) =>
      matchesPatterns(p.permission_code, template.allow, template.deny ?? []),
    );
    for (const permission of matching) {
      await db.query(
        `INSERT INTO access.role_permissions (tenant_id, role_id, permission_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [tenantId, roleId, permission.id],
      );
    }
  }

  await db.query(
    `INSERT INTO access.user_role_assignments (tenant_id, user_id, role_id)
     VALUES ($1,$2,$3)`,
    [tenantId, adminUserId, roleIds.get('owner')!],
  );
  for (const branch of branches) {
    await db.query(
      `INSERT INTO access.user_branch_access (tenant_id, user_id, branch_id) VALUES ($1,$2,$3)`,
      [tenantId, adminUserId, branch.id],
    );
  }

  await db.query(
    `INSERT INTO identity.employees
       (tenant_id, organization_id, branch_id, user_id, employee_number, first_name, last_name, job_title)
     VALUES ($1,$2,$3,$4,'EMP-0001',$5,'','Administrator')`,
    [tenantId, organizationId, branches[0]!.id, adminUserId, input.adminName],
  );

  // Licensing: one subscription with the purchased products and all their modules.
  const subscription = await db.query<{ id: string }>(
    `INSERT INTO licensing.subscriptions
       (tenant_id, organization_id, subscription_number, license_type, plan_code, status, user_limit, branch_limit)
     VALUES ($1,$2,$3,'perpetual','standard','active',50,10) RETURNING id`,
    [tenantId, organizationId, `SUB-${input.tenantCode.toUpperCase()}-0001`],
  );
  const subscriptionId = subscription.rows[0]!.id;

  let modulesActivated = 0;
  for (const productCode of input.products) {
    const product = await db.query<{ id: string }>(
      'SELECT id FROM licensing.product_catalogue WHERE product_code = $1',
      [productCode],
    );
    const productId = product.rows[0]?.id;
    if (!productId) throw badRequest(`Unknown product: ${productCode}`);

    const instance = await db.query<{ id: string }>(
      `INSERT INTO licensing.product_instances
         (tenant_id, organization_id, product_id, instance_code)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, organizationId, productId, `${input.tenantCode}-${productCode}`],
    );
    const instanceId = instance.rows[0]!.id;

    await db.query(
      `INSERT INTO licensing.subscription_items (tenant_id, subscription_id, item_type, product_id)
       VALUES ($1,$2,'product',$3)`,
      [tenantId, subscriptionId, productId],
    );

    const modules = await db.query<{ id: string }>(
      'SELECT id FROM licensing.module_catalogue WHERE product_id = $1',
      [productId],
    );

    for (const module of modules.rows) {
      await db.query(
        `INSERT INTO licensing.module_activations
           (tenant_id, product_instance_id, product_id, module_id, status, activated_by)
         VALUES ($1,$2,$3,$4,'active',$5)`,
        [tenantId, instanceId, productId, module.id, adminUserId],
      );
      await db.query(
        `INSERT INTO licensing.license_events
           (tenant_id, product_instance_id, module_id, event_type, actor_user_id, reason)
         VALUES ($1,$2,$3,'activated',$4,'tenant bootstrap')`,
        [tenantId, instanceId, module.id, adminUserId],
      );
      modulesActivated += 1;
    }
  }

  // Chart of accounts.
  const accountIds = new Map<string, string>();
  for (const account of DEFAULT_COA) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO finance.accounts
         (tenant_id, organization_id, account_code, account_name, account_class, normal_balance, currency_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        tenantId,
        organizationId,
        account.code,
        account.name,
        account.class,
        account.normal,
        currency,
      ],
    );
    accountIds.set(account.code, row.rows[0]!.id);
  }

  // Monthly fiscal periods for the current year.
  const year = new Date().getUTCFullYear();
  for (let month = 1; month <= 12; month += 1) {
    const startsOn = `${year}-${String(month).padStart(2, '0')}-01`;
    const endsOn = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    await db.query(
      `INSERT INTO finance.fiscal_periods
         (tenant_id, organization_id, period_code, starts_on, ends_on, status)
       VALUES ($1,$2,$3,$4,$5,'open')`,
      [tenantId, organizationId, `${year}-${String(month).padStart(2, '0')}`, startsOn, endsOn],
    );
  }

  // One operating account per branch. The account number is a placeholder and
  // must be unique per tenant bank, so derive it from the branch position.
  let bankAccountSequence = 0;
  for (const branch of branches) {
    bankAccountSequence += 1;
    await db.query(
      `INSERT INTO finance.bank_accounts
         (tenant_id, branch_id, account_name, bank_name, account_number, gl_account_id, currency_code)
       VALUES ($1,$2,$3,'Primary Bank',$4,$5,$6)`,
      [
        tenantId,
        branch.id,
        `Main Operating Account - ${branch.code}`,
        String(bankAccountSequence).padStart(10, '0'),
        accountIds.get(GL.bank)!,
        currency,
      ],
    );
  }

  let hotelId: string | undefined;
  if (input.products.includes('hotel') && input.hotel) {
    const hotelBranch = branches.find((b) => b.type === 'hotel') ?? branches[0]!;
    const hotel = await db.query<{ id: string }>(
      `INSERT INTO hotel.hotels
         (tenant_id, organization_id, branch_id, hotel_code, hotel_name, star_rating,
          default_currency, timezone, tax_rate, service_charge_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        tenantId,
        organizationId,
        hotelBranch.id,
        input.hotel.code,
        input.hotel.name,
        input.hotel.starRating ?? null,
        currency,
        input.timezone ?? 'Africa/Lagos',
        input.hotel.taxRate ?? 0.075,
        input.hotel.serviceChargeRate ?? 0.1,
      ],
    );
    hotelId = hotel.rows[0]!.id;

    for (const roomType of input.hotel.roomTypes) {
      const rt = await db.query<{ id: string }>(
        `INSERT INTO hotel.room_types
           (tenant_id, hotel_id, room_type_code, room_type_name, capacity_adults, capacity_children, base_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          tenantId,
          hotelId,
          roomType.code,
          roomType.name,
          roomType.capacityAdults ?? 2,
          roomType.capacityChildren ?? 0,
          roomType.baseRate,
        ],
      );
      const ratePlan = await db.query<{ id: string }>(
        `INSERT INTO hotel.rate_plans
           (tenant_id, hotel_id, room_type_id, rate_plan_code, rate_plan_name, meal_plan)
         VALUES ($1,$2,$3,$4,$5,'breakfast') RETURNING id`,
        [tenantId, hotelId, rt.rows[0]!.id, `${roomType.code}-BB`, `${roomType.name} Bed & Breakfast`],
      );
      for (const roomNumber of roomType.rooms) {
        await db.query(
          `INSERT INTO hotel.rooms (tenant_id, hotel_id, room_type_id, room_number)
           VALUES ($1,$2,$3,$4)`,
          [tenantId, hotelId, rt.rows[0]!.id, roomNumber],
        );
      }
    }

    await db.query(
      `INSERT INTO hotel.business_dates (tenant_id, hotel_id, business_date, status)
       VALUES ($1,$2,current_date,'open')`,
      [tenantId, hotelId],
    );

    // Maintenance & Engineering starts with the trades and SLA targets the
    // specification names, both editable by the property afterwards.
    for (const team of [
      ['ELEC', 'Electrical', 'electrical', 'Lighting, sockets, distribution boards, emergency lighting.'],
      ['PLUMB', 'Plumbing', 'plumbing', 'Taps, showers, drainage, leaks and water pressure.'],
      ['HVAC', 'HVAC', 'hvac', 'Air conditioning, ventilation and refrigeration.'],
      ['GEN', 'General maintenance', 'general', 'Building fabric, furniture, carpentry and general repairs.'],
    ]) {
      await db.query(
        `INSERT INTO maintenance.teams (tenant_id, hotel_id, team_code, team_name, trade, description)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, hotel_id, team_code) DO NOTHING`,
        [tenantId, hotelId, team[0], team[1], team[2], team[3]],
      );
    }
    for (const policy of [
      ['urgent', 1, 4],
      ['high', 2, 8],
      ['normal', 4, 24],
      ['low', 8, 72],
    ] as const) {
      await db.query(
        `INSERT INTO maintenance.sla_policies
           (tenant_id, hotel_id, priority, acknowledge_hours, resolve_hours)
         VALUES ($1,NULL,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [tenantId, policy[0], policy[1], policy[2]],
      );
    }

    const template = await db.query<{ id: string }>(
      `INSERT INTO housekeeping.checklist_templates
         (tenant_id, hotel_id, template_code, template_name)
       VALUES ($1,$2,'standard_room_clean','Standard Room Clean') RETURNING id`,
      [tenantId, hotelId],
    );
    const items = [
      'Strip and remake bed',
      'Clean bathroom and replace amenities',
      'Vacuum and dust surfaces',
      'Restock minibar and check consumption',
      'Empty bins and replace liners',
      'Check lights, TV and air conditioning',
      'Inspect linen for damage',
      'Final supervisor-ready photo',
    ];
    for (const [index, text] of items.entries()) {
      await db.query(
        `INSERT INTO housekeeping.checklist_template_items
           (tenant_id, template_id, item_text, display_order, requires_photo)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, template.rows[0]!.id, text, index + 1, index === items.length - 1],
      );
    }
    for (const task of [
      { code: 'CHECKOUT_CLEAN', name: 'Departure clean', minutes: 45 },
      { code: 'STAYOVER_CLEAN', name: 'Stayover service', minutes: 25 },
      { code: 'DEEP_CLEAN', name: 'Deep clean', minutes: 120 },
    ]) {
      await db.query(
        `INSERT INTO housekeeping.task_types
           (tenant_id, hotel_id, task_code, task_name, default_minutes, checklist_template_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, hotelId, task.code, task.name, task.minutes, template.rows[0]!.id],
      );
    }
  }

  let restaurantOutletId: string | undefined;
  if (input.products.includes('restaurant') && input.restaurant) {
    const restBranch = branches.find((b) => b.type === 'restaurant' || b.type === 'mixed') ?? branches[0]!;
    const outlet = await db.query<{ id: string }>(
      `INSERT INTO restaurant.outlets
         (tenant_id, branch_id, outlet_code, outlet_name, outlet_type, currency_code, timezone,
          tax_rate, service_charge_rate, pay_before_order, allow_charge_to_room)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        tenantId,
        restBranch.id,
        input.restaurant.code,
        input.restaurant.name,
        input.restaurant.outletType ?? 'dine_in',
        currency,
        input.timezone ?? 'Africa/Lagos',
        input.restaurant.taxRate ?? 0.075,
        input.restaurant.serviceChargeRate ?? 0.1,
        input.restaurant.payBeforeOrder ?? false,
        input.products.includes('hotel'),
      ],
    );
    restaurantOutletId = outlet.rows[0]!.id;

    const area = await db.query<{ id: string }>(
      `INSERT INTO restaurant.dining_areas (tenant_id, outlet_id, area_name)
       VALUES ($1,$2,'Main Dining') RETURNING id`,
      [tenantId, restaurantOutletId],
    );
    for (const table of input.restaurant.tables ?? []) {
      await db.query(
        `INSERT INTO restaurant.tables (tenant_id, outlet_id, area_id, table_code, seats)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, restaurantOutletId, area.rows[0]!.id, table.code, table.seats],
      );
    }
    for (const station of input.restaurant.stations ?? [{ code: 'KITCHEN', name: 'Main Kitchen' }]) {
      await db.query(
        `INSERT INTO restaurant.kitchen_stations (tenant_id, outlet_id, station_code, station_name)
         VALUES ($1,$2,$3,$4)`,
        [tenantId, restaurantOutletId, station.code, station.name],
      );
    }
    await db.query(
      `INSERT INTO restaurant.menus (tenant_id, outlet_id, menu_name) VALUES ($1,$2,'Main Menu')`,
      [tenantId, restaurantOutletId],
    );
  }

  let barOutletId: string | undefined;
  if (input.products.includes('bar') && input.bar) {
    const barBranch = branches.find((b) => b.type === 'bar' || b.type === 'mixed') ?? branches[0]!;
    const bar = await db.query<{ id: string }>(
      `INSERT INTO bar.outlets
         (tenant_id, branch_id, bar_code, bar_name, bar_type, currency_code, tax_rate, service_charge_rate,
          allow_charge_to_room)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        tenantId,
        barBranch.id,
        input.bar.code,
        input.bar.name,
        input.bar.barType ?? 'lounge',
        currency,
        input.bar.taxRate ?? 0.075,
        0.1,
        input.products.includes('hotel'),
      ],
    );
    barOutletId = bar.rows[0]!.id;
  }

  await audit(db, {
    tenantId,
    actorLabel,
    action: 'tenant.bootstrap',
    entityType: 'tenant',
    entityId: tenantId,
    after: { tenantCode: input.tenantCode, products: input.products, modulesActivated },
    metadata: { source: 'onboarding' },
  });

  return {
    tenantId,
    organizationId,
    legalEntityId,
    branches: branches.map((b) => ({ id: b.id, code: b.code })),
    adminUserId,
    hotelId,
    restaurantOutletId,
    barOutletId,
    products: input.products,
    modulesActivated,
  };
}

const tenantCodeOf = (input: BootstrapInput) => input.tenantCode.toUpperCase();

function departmentSet(branchType: string): Array<{ code: string; name: string }> {
  const common = [
    { code: 'FO', name: 'Front Office' },
    { code: 'HK', name: 'Housekeeping' },
    { code: 'FIN', name: 'Finance' },
    { code: 'STORE', name: 'Stores' },
    { code: 'MAINT', name: 'Maintenance' },
  ];
  if (branchType === 'restaurant' || branchType === 'mixed') {
    common.push({ code: 'KITCHEN', name: 'Kitchen' }, { code: 'SERVICE', name: 'Food Service' });
  }
  if (branchType === 'bar' || branchType === 'mixed') {
    common.push({ code: 'BAR', name: 'Bar Service' });
  }
  if (branchType === 'hotel') {
    common.push({ code: 'HK-SUP', name: 'Housekeeping Supervision' });
  }
  return common;
}

export { AppError };
