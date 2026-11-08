import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';
import { GL, money, postJournal } from './finance.js';

const today = (): string => new Date().toISOString().slice(0, 10);

export type OrderStatus =
  | 'draft'
  | 'placed'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'served'
  | 'completed'
  | 'cancelled';

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['placed', 'cancelled'],
  placed: ['accepted', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served', 'cancelled'],
  served: ['completed'],
  completed: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Outlets, menus and QR
// ---------------------------------------------------------------------------
export async function listOutlets(db: Queryable) {
  const { rows } = await db.query(
    `SELECT id, outlet_code, outlet_name, outlet_type, tax_rate, service_charge_rate,
            accepts_qr_orders, pay_before_order, allow_charge_to_room, status, currency_code
       FROM restaurant.outlets ORDER BY outlet_name`,
  );
  return rows;
}

export async function getOutlet(db: Queryable, outletId: string) {
  const { rows } = await db.query(
    `SELECT id, branch_id, outlet_code, outlet_name, outlet_type, tax_rate, service_charge_rate,
            accepts_qr_orders, pay_before_order, allow_charge_to_room, status, currency_code
       FROM restaurant.outlets WHERE id = $1`,
    [outletId],
  );
  if (!rows[0]) throw notFound('Restaurant outlet not found');
  return rows[0]!;
}

export async function createMenuItem(
  db: Queryable,
  ctx: AuthContext,
  input: {
    menuId: string;
    categoryId?: string;
    sku: string;
    name: string;
    description?: string;
    price: number;
    taxRate?: number;
    kitchenStationId?: string;
    prepMinutes?: number;
    isAlcoholic?: boolean;
    allergens?: string[];
  },
) {
  if (!(input.price >= 0)) throw badRequest('Price must be zero or greater');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO restaurant.menu_items
       (tenant_id, menu_id, category_id, sku, item_name, description, price, tax_rate,
        kitchen_station_id, prep_minutes, is_alcoholic, allergens)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      ctx.tenantId,
      input.menuId,
      input.categoryId ?? null,
      input.sku,
      input.name,
      input.description ?? null,
      money(input.price),
      input.taxRate ?? 0.075,
      input.kitchenStationId ?? null,
      input.prepMinutes ?? 15,
      input.isAlcoholic ?? false,
      input.allergens ?? [],
    ],
  );
  await auditAction(db, ctx, 'restaurant.menu_item_created', 'menu_item', rows[0]!.id, {
    after: { sku: input.sku, price: input.price },
  });
  return rows[0]!;
}

export async function getMenu(db: Queryable, outletId: string) {
  const menu = await db.query<{ id: string; menu_name: string }>(
    'SELECT id, menu_name FROM restaurant.menus WHERE outlet_id = $1 AND is_active ORDER BY created_at LIMIT 1',
    [outletId],
  );
  if (!menu.rows[0]) throw notFound('No active menu for this outlet');
  const menuId = menu.rows[0].id;
  const categories = await db.query(
    'SELECT id, category_name, display_order FROM restaurant.menu_categories WHERE menu_id = $1 ORDER BY display_order, category_name',
    [menuId],
  );
  const items = await db.query(
    `SELECT id, category_id, sku, item_name, description, price, tax_rate, is_available,
            prep_minutes, is_alcoholic, allergens, kitchen_station_id
       FROM restaurant.menu_items WHERE menu_id = $1 ORDER BY display_order, item_name`,
    [menuId],
  );
  return {
    menuId,
    menuName: menu.rows[0].menu_name,
    categories: categories.rows,
    items: items.rows.map((i) => ({ ...i, price: Number(i.price as string) })),
  };
}

export async function createRecipe(
  db: Queryable,
  ctx: AuthContext,
  input: {
    itemId: string;
    yieldQuantity?: number;
    yieldUnit?: string;
    instructions?: string;
    ingredients: Array<{ itemSku: string; quantity: number; unit?: string; wastagePercent?: number }>;
  },
) {
  if (input.ingredients.length === 0) throw badRequest('A recipe needs at least one ingredient');
  const recipe = await db.query<{ id: string }>(
    `INSERT INTO restaurant.recipes (tenant_id, item_id, yield_quantity, yield_unit, instructions)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, item_id) DO UPDATE
       SET yield_quantity = EXCLUDED.yield_quantity, instructions = EXCLUDED.instructions
     RETURNING id`,
    [
      ctx.tenantId,
      input.itemId,
      input.yieldQuantity ?? 1,
      input.yieldUnit ?? 'portion',
      input.instructions ?? null,
    ],
  );
  const recipeId = recipe.rows[0]!.id;
  for (const ingredient of input.ingredients) {
    if (!(ingredient.quantity > 0)) throw badRequest('Ingredient quantity must be greater than zero');
    await db.query(
      `INSERT INTO restaurant.recipe_ingredients
         (tenant_id, recipe_id, item_sku, quantity, unit, wastage_percent)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, recipe_id, item_sku) DO UPDATE
         SET quantity = EXCLUDED.quantity, unit = EXCLUDED.unit, wastage_percent = EXCLUDED.wastage_percent`,
      [
        ctx.tenantId,
        recipeId,
        ingredient.itemSku,
        ingredient.quantity,
        ingredient.unit ?? 'kg',
        ingredient.wastagePercent ?? 0,
      ],
    );
  }
  await auditAction(db, ctx, 'restaurant.recipe_saved', 'recipe', recipeId, {
    after: { itemId: input.itemId, ingredients: input.ingredients.length },
  });
  return { recipeId };
}

export async function listTables(db: Queryable, outletId: string) {
  const { rows } = await db.query(
    `SELECT t.id, t.table_code, t.seats, t.status, a.area_name
       FROM restaurant.tables t
       LEFT JOIN restaurant.dining_areas a ON a.id = t.area_id
      WHERE t.outlet_id = $1 ORDER BY t.table_code`,
    [outletId],
  );
  return rows;
}

export async function createMenuCategory(
  db: Queryable,
  ctx: AuthContext,
  input: { menuId: string; name: string; displayOrder?: number },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO restaurant.menu_categories (tenant_id, menu_id, category_name, display_order)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.tenantId, input.menuId, input.name, input.displayOrder ?? 0],
  );
  return rows[0]!;
}

export async function createQrToken(
  db: Queryable,
  ctx: AuthContext,
  input: { outletId: string; tableId?: string; label?: string; expiresAt?: string },
) {
  const outlet = await getOutlet(db, input.outletId);
  if (!outlet.accepts_qr_orders) {
    throw conflict('QR_ORDERS_DISABLED', 'This outlet does not accept QR orders');
  }
  if (input.tableId) {
    const table = await db.query('SELECT 1 FROM restaurant.tables WHERE id = $1 AND outlet_id = $2', [
      input.tableId,
      input.outletId,
    ]);
    if (!table.rowCount) throw badRequest('Table does not belong to this outlet');
  }
  const token = Array.from({ length: 24 }, () =>
    'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)],
  ).join('');
  const { rows } = await db.query<{ id: string; token: string }>(
    `INSERT INTO restaurant.qr_tokens (tenant_id, outlet_id, table_id, token, label, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, token`,
    [
      ctx.tenantId,
      input.outletId,
      input.tableId ?? null,
      token,
      input.label ?? null,
      input.expiresAt ?? null,
      ctx.userId,
    ],
  );
  await auditAction(db, ctx, 'restaurant.qr_created', 'qr_token', rows[0]!.id, {
    after: { outletId: input.outletId, tableId: input.tableId ?? null },
  });
  return rows[0]!;
}

export async function listQrTokens(db: Queryable, outletId: string) {
  const { rows } = await db.query(
    `SELECT q.id, q.token, q.label, q.is_active, q.expires_at, t.table_code
       FROM restaurant.qr_tokens q LEFT JOIN restaurant.tables t ON t.id = q.table_id
      WHERE q.outlet_id = $1 ORDER BY q.created_at DESC`,
    [outletId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------
interface OrderItemInput {
  itemId: string;
  quantity: number;
  notes?: string;
}

interface Totals {
  subtotal: number;
  tax: number;
  serviceCharge: number;
  discount: number;
  total: number;
  lines: Array<{
    itemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    taxAmount: number;
    kitchenStationId: string | null;
    notes?: string;
  }>;
}

async function computeTotals(
  db: Queryable,
  outlet: { id: string; tax_rate: string; service_charge_rate: string },
  items: OrderItemInput[],
): Promise<Totals> {
  if (items.length === 0) throw badRequest('An order needs at least one item');
  const lines: Totals['lines'] = [];
  let subtotal = 0;
  let tax = 0;

  for (const item of items) {
    if (!(item.quantity > 0)) throw badRequest('Quantity must be greater than zero');
    const { rows } = await db.query<{
      id: string;
      item_name: string;
      price: string;
      tax_rate: string;
      is_available: boolean;
      kitchen_station_id: string | null;
    }>(
      `SELECT id, item_name, price, tax_rate, is_available, kitchen_station_id
         FROM restaurant.menu_items
        WHERE id = $1 AND menu_id IN (SELECT id FROM restaurant.menus WHERE outlet_id = $2)`,
      [item.itemId, outlet.id],
    );
    const row = rows[0];
    if (!row) throw badRequest(`Item ${item.itemId} is not on this outlet's menu`);
    if (!row.is_available) throw conflict('ITEM_UNAVAILABLE', `${row.item_name} is not available`);
    const unitPrice = money(Number(row.price));
    const lineTotal = money(unitPrice * item.quantity);
    const lineTax = money(lineTotal * Number(row.tax_rate));
    subtotal = money(subtotal + lineTotal);
    tax = money(tax + lineTax);
    lines.push({
      itemId: row.id,
      name: row.item_name,
      quantity: item.quantity,
      unitPrice,
      lineTotal,
      taxAmount: lineTax,
      kitchenStationId: row.kitchen_station_id,
      notes: item.notes,
    });
  }

  const serviceCharge = money(subtotal * Number(outlet.service_charge_rate));
  const discount = 0;
  const total = money(subtotal + tax + serviceCharge - discount);
  return { subtotal, tax, serviceCharge, discount, total, lines };
}

async function ensureTableSession(
  db: Queryable,
  ctx: { tenantId: string },
  outletId: string,
  tableId: string | undefined,
  guests: number,
): Promise<string | null> {
  if (!tableId) return null;
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM restaurant.table_sessions WHERE table_id = $1 AND status = 'open'",
    [tableId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await db.query<{ id: string }>(
    `INSERT INTO restaurant.table_sessions (tenant_id, outlet_id, table_id, guests_count)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.tenantId, outletId, tableId, guests],
  );
  await db.query("UPDATE restaurant.tables SET status = 'occupied' WHERE id = $1", [tableId]);
  return created.rows[0]!.id;
}

export interface CreateOrderInput {
  outletId: string;
  channel: string;
  items: OrderItemInput[];
  tableId?: string;
  guestId?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  deliveryAddress?: string;
  paymentTiming?: 'pay_before' | 'pay_after';
  waiterUserId?: string;
  qrTokenId?: string;
  guestsCount?: number;
}

/** Creates an order, calculates totals server side and routes kitchen tickets. */
export async function createOrder(
  db: Queryable,
  tenantId: string,
  input: CreateOrderInput,
  actorUserId: string | null,
) {
  const outlet = await getOutlet(db, input.outletId);
  if (outlet.status !== 'active') throw conflict('OUTLET_INACTIVE', 'Outlet is not active');
  const totals = await computeTotals(db, outlet, input.items);
  const tableSessionId = await ensureTableSession(
    db,
    { tenantId },
    input.outletId,
    input.tableId,
    input.guestsCount ?? 1,
  );

  const paymentTiming = input.paymentTiming ?? (outlet.pay_before_order ? 'pay_before' : 'pay_after');
  const orderNumber = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'restaurant_order', 'ORD-') AS number",
    [tenantId],
  );

  const order = await db.query<{ id: string }>(
    `INSERT INTO restaurant.orders
       (tenant_id, branch_id, outlet_id, order_number, channel, table_id, table_session_id, guest_id,
        customer_name, customer_phone, customer_email, delivery_address, status, payment_status,
        payment_timing, subtotal, tax_total, service_charge_total, discount_total, total_amount,
        currency_code, qr_token_id, waiter_user_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'placed','unpaid',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      tenantId,
      outlet.branch_id,
      input.outletId,
      orderNumber.rows[0]!.number,
      input.channel,
      input.tableId ?? null,
      tableSessionId,
      input.guestId ?? null,
      input.customerName ?? null,
      input.customerPhone ?? null,
      input.customerEmail ?? null,
      input.deliveryAddress ?? null,
      paymentTiming,
      totals.subtotal,
      totals.tax,
      totals.serviceCharge,
      totals.discount,
      totals.total,
      outlet.currency_code,
      input.qrTokenId ?? null,
      input.waiterUserId ?? null,
      actorUserId,
    ],
  );
  const orderId = order.rows[0]!.id;

  for (const line of totals.lines) {
    await db.query(
      `INSERT INTO restaurant.order_lines
         (tenant_id, order_id, item_id, item_name_snapshot, quantity, unit_price, line_total,
          tax_amount, notes, kitchen_station_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'placed')`,
      [
        tenantId,
        orderId,
        line.itemId,
        line.name,
        line.quantity,
        line.unitPrice,
        line.lineTotal,
        line.taxAmount,
        line.notes ?? null,
        line.kitchenStationId,
      ],
    );
  }

  // Kitchen routing: one ticket per station.
  const byStation = new Map<string | null, Totals['lines']>();
  for (const line of totals.lines) {
    const key = line.kitchenStationId;
    byStation.set(key, [...(byStation.get(key) ?? []), line]);
  }
  for (const [stationId, lines] of byStation) {
    const ticketNumber = await db.query<{ number: string }>(
      "SELECT app_next_document_number($1, 'kitchen_ticket', 'KT-') AS number",
      [tenantId],
    );
    await db.query(
      `INSERT INTO restaurant.kitchen_tickets
         (tenant_id, outlet_id, order_id, station_id, ticket_number, item_summary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        tenantId,
        input.outletId,
        orderId,
        stationId,
        ticketNumber.rows[0]!.number,
        lines.map((l) => `${l.quantity} x ${l.name}`).join(', '),
      ],
    );
  }

  await emitEvent(db, tenantId, 'restaurant.order_placed', 'restaurant_order', orderId, {
    outletId: input.outletId,
    channel: input.channel,
    total: totals.total,
  });

  return {
    orderId,
    orderNumber: orderNumber.rows[0]!.number,
    outletId: input.outletId,
    status: 'placed',
    paymentStatus: 'unpaid',
    paymentTiming,
    ...totals,
  };
}

export async function getOrder(db: Queryable, orderId: string) {
  const order = await db.query(
    `SELECT o.id, o.order_number, o.channel, o.status, o.payment_status, o.payment_timing,
            o.subtotal, o.tax_total, o.service_charge_total, o.discount_total, o.total_amount,
            o.currency_code, o.folio_id, o.table_id, o.customer_name, o.placed_at, o.completed_at,
            ol.outlet_name
       FROM restaurant.orders o JOIN restaurant.outlets ol ON ol.id = o.outlet_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!order.rows[0]) throw notFound('Order not found');
  const lines = await db.query(
    `SELECT id, item_name_snapshot, quantity, unit_price, line_total, status, kitchen_station_id
       FROM restaurant.order_lines WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  const tickets = await db.query(
    `SELECT id, ticket_number, status, item_summary, station_id FROM restaurant.kitchen_tickets
      WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  const payments = await db.query(
    `SELECT id, reference, provider, amount, status, created_at FROM payments.intents
      WHERE related_type = 'restaurant_order' AND related_id = $1 ORDER BY created_at`,
    [orderId],
  );
  return { ...order.rows[0], lines: lines.rows, tickets: tickets.rows, payments: payments.rows };
}

export async function listOrders(db: Queryable, outletId: string | undefined, status?: string) {
  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.channel, o.status, o.payment_status, o.total_amount,
            o.placed_at, o.table_id, t.table_code, o.customer_name
       FROM restaurant.orders o
       LEFT JOIN restaurant.tables t ON t.id = o.table_id
      WHERE ($1::uuid IS NULL OR o.outlet_id = $1)
        AND ($2::text IS NULL OR o.status = $2)
      ORDER BY o.placed_at DESC LIMIT 100`,
    [outletId ?? null, status ?? null],
  );
  return rows;
}

export async function advanceOrder(
  db: Queryable,
  ctx: AuthContext,
  orderId: string,
  next: OrderStatus,
) {
  const order = await db.query<{
    id: string;
    outlet_id: string;
    branch_id: string;
    status: OrderStatus;
    payment_status: string;
    payment_timing: string;
    total_amount: string;
    order_number: string;
  }>(
    `SELECT id, outlet_id, branch_id, status, payment_status, payment_timing, total_amount, order_number
       FROM restaurant.orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound('Order not found');
  const allowed = TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(next)) {
    throw conflict('INVALID_ORDER_TRANSITION', `Order ${row.status} cannot move to ${next}`);
  }
  if (
    next === 'completed' &&
    row.payment_timing === 'pay_before' &&
    row.payment_status !== 'paid'
  ) {
    throw conflict('PAYMENT_REQUIRED', 'This order must be paid before it can be completed');
  }

  const timestamps: Record<string, string> = {};
  if (next === 'accepted') timestamps.accepted = 'accepted_at = now()';
  if (next === 'ready') timestamps.ready = 'ready_at = now()';
  if (next === 'completed') timestamps.completed = 'completed_at = now()';

  await db.query(
    `UPDATE restaurant.orders SET status = $2 ${Object.values(timestamps).map((v) => `, ${v}`).join('')}
      WHERE id = $1`,
    [orderId, next],
  );

  const ticketStatus =
    next === 'preparing' ? 'in_progress' : next === 'ready' ? 'ready' : next === 'served' ? 'served' : null;
  if (ticketStatus) {
    await db.query(
      `UPDATE restaurant.kitchen_tickets SET status = $2
         ${ticketStatus === 'in_progress' ? ', started_at = now()' : ''}
         ${ticketStatus === 'ready' ? ', ready_at = now()' : ''}
         ${ticketStatus === 'served' ? ', served_at = now()' : ''}
        WHERE order_id = $1 AND status NOT IN ('served')`,
      [orderId, ticketStatus],
    );
    await db.query(
      `UPDATE restaurant.order_lines SET status = $2 WHERE order_id = $1 AND status <> 'void'`,
      [orderId, ticketStatus === 'in_progress' ? 'preparing' : ticketStatus],
    );
  }

  let ingredientsIssued = 0;
  if (next === 'completed') {
    ingredientsIssued = await deductIngredients(db, ctx.tenantId, row.branch_id, orderId);
  }

  await auditAction(db, ctx, `restaurant.order_${next}`, 'restaurant_order', orderId, {
    before: { status: row.status },
    after: { status: next, ingredientsIssued },
    branchId: row.branch_id,
  });
  await emitEvent(db, ctx.tenantId, `restaurant.order_${next}`, 'restaurant_order', orderId, {
    status: next,
  });
  return { orderId, status: next, ingredientsIssued };
}

/**
 * Deducts recipe ingredients for a completed order.
 *
 * Movements are keyed on (reference_type, reference_id, item, movement_type) with a
 * partial unique index, so a retried completion can never deduct twice.
 */
export async function deductIngredients(
  db: Queryable,
  tenantId: string,
  branchId: string,
  orderId: string,
): Promise<number> {
  const store = await db.query<{ id: string }>(
    `SELECT id FROM inventory.stores
      WHERE branch_id = $1 AND store_type = 'kitchen' AND status = 'active'
      UNION ALL
      SELECT id FROM inventory.stores WHERE branch_id = $1 AND store_type = 'main' AND status = 'active'
      LIMIT 1`,
    [branchId],
  );
  const storeId = store.rows[0]?.id;
  if (!storeId) return 0;

  const lines = await db.query<{ id: string; item_id: string; quantity: string }>(
    'SELECT id, item_id, quantity FROM restaurant.order_lines WHERE order_id = $1 AND status <> \'void\'',
    [orderId],
  );

  let issued = 0;
  for (const line of lines.rows) {
    const recipe = await db.query<{ id: string; yield_quantity: string }>(
      'SELECT id, yield_quantity FROM restaurant.recipes WHERE item_id = $1',
      [line.item_id],
    );
    const recipeRow = recipe.rows[0];
    if (!recipeRow) continue;
    const ingredients = await db.query<{ item_sku: string; quantity: string; wastage_percent: string }>(
      'SELECT item_sku, quantity, wastage_percent FROM restaurant.recipe_ingredients WHERE recipe_id = $1',
      [recipeRow.id],
    );
    for (const ingredient of ingredients.rows) {
      const item = await db.query<{ id: string; standard_cost: string }>(
        'SELECT id, standard_cost FROM inventory.items WHERE sku = $1',
        [ingredient.item_sku],
      );
      const inventoryItem = item.rows[0];
      if (!inventoryItem) continue;
      const perPortion =
        (Number(ingredient.quantity) * (1 + Number(ingredient.wastage_percent) / 100)) /
        Number(recipeRow.yield_quantity);
      const quantity = -money(perPortion * Number(line.quantity));
      const result = await db.query(
        `INSERT INTO inventory.movements
           (tenant_id, branch_id, store_id, item_id, movement_type, quantity, unit_cost, total_cost,
            reference_type, reference_id, notes, performed_by)
         VALUES ($1,$2,$3,$4,'issue',$5,$6,$7,'restaurant_order_line',$8,$9,$10)
         ON CONFLICT (tenant_id, reference_type, reference_id, item_id, movement_type)
           WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL DO NOTHING`,
        [
          tenantId,
          branchId,
          storeId,
          inventoryItem.id,
          quantity,
          Number(inventoryItem.standard_cost),
          money(Math.abs(quantity) * Number(inventoryItem.standard_cost)),
          line.id,
          `Order ${orderId} ingredient deduction`,
          null,
        ],
      );
      issued += result.rowCount ?? 0;
    }
  }
  return issued;
}

export async function voidOrder(db: Queryable, ctx: AuthContext, orderId: string, reason: string) {
  if (!reason?.trim()) throw badRequest('A reason is required to void an order');
  const order = await db.query<{ status: string; payment_status: string }>(
    'SELECT status, payment_status FROM restaurant.orders WHERE id = $1 FOR UPDATE',
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound('Order not found');
  if (row.payment_status === 'paid') {
    throw conflict('ORDER_ALREADY_PAID', 'Paid orders must be refunded, not voided');
  }
  if (row.status === 'cancelled') throw conflict('ORDER_ALREADY_CANCELLED', 'Order is already cancelled');
  await db.query(
    "UPDATE restaurant.orders SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $2 WHERE id = $1",
    [orderId, reason],
  );
  await db.query("UPDATE restaurant.kitchen_tickets SET status = 'recalled' WHERE order_id = $1", [orderId]);
  await db.query("UPDATE restaurant.order_lines SET status = 'void', void_reason = $2 WHERE order_id = $1", [
    orderId,
    reason,
  ]);
  await auditAction(db, ctx, 'restaurant.order_voided', 'restaurant_order', orderId, {
    metadata: { reason },
  });
  return { orderId, status: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Revenue recognition and settlement
// ---------------------------------------------------------------------------
/**
 * Recognises restaurant revenue for an order exactly once.
 *
 * source_type/source_id/purpose are guarded by finance.posting_links, so no
 * settlement path (cash, gateway, folio charge) can double count revenue.
 */
export async function recogniseOrderRevenue(
  db: Queryable,
  ctx: { tenantId: string; userId: string | null },
  orderId: string,
  debitAccount: string,
): Promise<string> {
  const order = await db.query<{ total_amount: string; branch_id: string; order_number: string }>(
    'SELECT total_amount, branch_id, order_number FROM restaurant.orders WHERE id = $1',
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound('Order not found');
  return postJournal(db, {
    tenantId: ctx.tenantId,
    branchId: row.branch_id,
    entryDate: today(),
    description: `Restaurant order ${row.order_number} revenue`,
    sourceType: 'restaurant_order',
    sourceId: orderId,
    purpose: 'revenue',
    lines: [
      { accountCode: debitAccount, debit: Number(row.total_amount) },
      { accountCode: GL.restaurantRevenue, credit: Number(row.total_amount) },
    ],
    postedBy: ctx.userId,
  });
}

export async function chargeOrderToFolio(
  db: Queryable,
  ctx: AuthContext,
  input: { orderId: string; folioId: string },
) {
  const order = await db.query<{
    id: string;
    total_amount: string;
    payment_status: string;
    status: string;
    outlet_id: string;
    order_number: string;
    folio_id: string | null;
    branch_id: string;
  }>(
    `SELECT id, total_amount, payment_status, status, outlet_id, order_number, folio_id, branch_id
       FROM restaurant.orders WHERE id = $1 FOR UPDATE`,
    [input.orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound('Order not found');
  if (row.folio_id) throw conflict('ORDER_ALREADY_ON_FOLIO', 'Order is already charged to a folio');
  if (row.payment_status === 'paid') {
    throw conflict('ORDER_ALREADY_PAID', 'Order is already settled');
  }
  if (row.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'Cancelled orders cannot be charged');

  const outlet = await getOutlet(db, row.outlet_id);
  if (!outlet.allow_charge_to_room) {
    throw forbidden('This outlet is not configured to charge to guest rooms');
  }
  const folio = await db.query<{ id: string; status: string; hotel_id: string }>(
    'SELECT id, status, hotel_id FROM hotel.folios WHERE id = $1',
    [input.folioId],
  );
  const folioRow = folio.rows[0];
  if (!folioRow) throw notFound('Guest folio not found');
  if (folioRow.status !== 'open') throw conflict('FOLIO_CLOSED', 'Guest folio is not open');

  // Revenue is recognised once, debiting guest receivable (not cash).
  const journalEntryId = await recogniseOrderRevenue(db, ctx, input.orderId, GL.guestReceivable);

  // The folio entry records the guest's liability; it must not post revenue again.
  const entry = await db.query<{ id: string }>(
    `INSERT INTO hotel.folio_entries
       (tenant_id, hotel_id, folio_id, entry_type, description, amount, currency_code,
        source_type, source_id, journal_entry_id, business_date, posted_by)
     VALUES ($1,$2,$3,'restaurant_charge',$4,$5,$6,'restaurant_order',$7,$8,current_date,$9)
     RETURNING id`,
    [
      ctx.tenantId,
      folioRow.hotel_id,
      input.folioId,
      `Restaurant order ${row.order_number}`,
      Number(row.total_amount),
      outlet.currency_code,
      input.orderId,
      journalEntryId,
      ctx.userId,
    ],
  );

  await db.query(
    "UPDATE restaurant.orders SET folio_id = $2, payment_status = 'paid' WHERE id = $1",
    [input.orderId, input.folioId],
  );
  await auditAction(db, ctx, 'restaurant.charged_to_folio', 'restaurant_order', input.orderId, {
    after: { folioId: input.folioId, amount: Number(row.total_amount), journalEntryId },
  });
  await emitEvent(db, ctx.tenantId, 'restaurant.charged_to_folio', 'restaurant_order', input.orderId, {
    folioId: input.folioId,
  });
  return {
    orderId: input.orderId,
    folioId: input.folioId,
    folioEntryId: entry.rows[0]!.id,
    journalEntryId,
    amount: Number(row.total_amount),
  };
}

/** Public QR menu: resolved through an opaque token, no authentication. */
export async function publicMenuByToken(db: Queryable, tokenRow: { outlet_id: string }) {
  const outlet = await getOutlet(db, tokenRow.outlet_id);
  const menu = await getMenu(db, tokenRow.outlet_id);
  return {
    outlet: {
      id: outlet.id,
      name: outlet.outlet_name,
      currency: outlet.currency_code,
      taxRate: Number(outlet.tax_rate),
      serviceChargeRate: Number(outlet.service_charge_rate),
      payBeforeOrder: outlet.pay_before_order,
      allowChargeToRoom: outlet.allow_charge_to_room,
      type: outlet.outlet_type,
    },
    menu,
  };
}
