import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';
import { GL, money, postJournal } from './finance.js';

const today = (): string => new Date().toISOString().slice(0, 10);

export async function listOutlets(db: Queryable) {
  const { rows } = await db.query(
    `SELECT id, bar_code, bar_name, bar_type, tax_rate, service_charge_rate,
            allow_charge_to_room, status, currency_code
       FROM bar.outlets ORDER BY bar_name`,
  );
  return rows;
}

export async function getOutlet(db: Queryable, barId: string) {
  const { rows } = await db.query(
    `SELECT id, branch_id, bar_code, bar_name, bar_type, tax_rate, service_charge_rate,
            allow_charge_to_room, status, currency_code
       FROM bar.outlets WHERE id = $1`,
    [barId],
  );
  if (!rows[0]) throw notFound('Bar outlet not found');
  return rows[0]!;
}

export async function createBeverage(
  db: Queryable,
  ctx: AuthContext,
  input: {
    barId: string;
    sku: string;
    name: string;
    category: string;
    salePrice: number;
    costPrice?: number;
    servingSizeMl?: number;
    isAlcoholic?: boolean;
    inventorySku?: string;
  },
) {
  if (!(input.salePrice >= 0)) throw badRequest('Sale price must be zero or greater');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO bar.beverages
       (tenant_id, bar_id, sku, beverage_name, category, serving_size_ml, sale_price, cost_price,
        is_alcoholic, inventory_sku)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      ctx.tenantId,
      input.barId,
      input.sku,
      input.name,
      input.category,
      input.servingSizeMl ?? null,
      money(input.salePrice),
      money(input.costPrice ?? 0),
      input.isAlcoholic ?? true,
      input.inventorySku ?? null,
    ],
  );
  await auditAction(db, ctx, 'bar.beverage_created', 'beverage', rows[0]!.id, {
    after: { sku: input.sku, salePrice: input.salePrice },
  });
  return rows[0]!;
}

export async function listBeverages(db: Queryable, barId: string) {
  const { rows } = await db.query(
    `SELECT id, sku, beverage_name, category, serving_size_ml, sale_price, cost_price,
            is_alcoholic, is_available, inventory_sku
       FROM bar.beverages WHERE bar_id = $1 ORDER BY category, beverage_name`,
    [barId],
  );
  return rows.map((r) => ({
    ...r,
    sale_price: Number(r.sale_price as string),
    cost_price: Number(r.cost_price as string),
  }));
}

export async function createCocktailRecipe(
  db: Queryable,
  ctx: AuthContext,
  input: {
    beverageId: string;
    yieldServings?: number;
    preparation?: string;
    ingredients: Array<{ itemSku: string; quantity: number; unit: string }>;
  },
) {
  const recipe = await db.query<{ id: string }>(
    `INSERT INTO bar.recipes (tenant_id, beverage_id, yield_servings, preparation)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.tenantId, input.beverageId, input.yieldServings ?? 1, input.preparation ?? null],
  );
  for (const ingredient of input.ingredients) {
    await db.query(
      `INSERT INTO bar.recipe_ingredients (tenant_id, recipe_id, item_sku, quantity, unit)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.tenantId, recipe.rows[0]!.id, ingredient.itemSku, ingredient.quantity, ingredient.unit],
    );
  }
  return recipe.rows[0]!;
}

export interface BarOrderInput {
  barId: string;
  items: Array<{ beverageId: string; quantity: number }>;
  customerName?: string;
  channel?: 'counter' | 'table' | 'tab' | 'room_service' | 'event';
  guestId?: string;
  tabId?: string;
}

export async function createOrder(
  db: Queryable,
  ctx: AuthContext,
  input: BarOrderInput,
) {
  if (input.items.length === 0) throw badRequest('A bar order needs at least one item');
  const outlet = await getOutlet(db, input.barId);
  if (outlet.status !== 'active') throw conflict('BAR_INACTIVE', 'Bar outlet is not active');

  let subtotal = 0;
  const lines: Array<{ id: string; name: string; quantity: number; unitPrice: number; lineTotal: number }> = [];
  for (const item of input.items) {
    if (!(item.quantity > 0)) throw badRequest('Quantity must be greater than zero');
    const beverage = await db.query<{
      id: string;
      beverage_name: string;
      sale_price: string;
      is_available: boolean;
    }>('SELECT id, beverage_name, sale_price, is_available FROM bar.beverages WHERE id = $1 AND bar_id = $2', [
      item.beverageId,
      input.barId,
    ]);
    const beverageRow = beverage.rows[0];
    if (!beverageRow) throw badRequest(`Beverage ${item.beverageId} is not on this bar's menu`);
    if (!beverageRow.is_available) {
      throw conflict('BEVERAGE_UNAVAILABLE', `${beverageRow.beverage_name} is not available`);
    }
    const unitPrice = money(Number(beverageRow.sale_price));
    const lineTotal = money(unitPrice * item.quantity);
    subtotal = money(subtotal + lineTotal);
    lines.push({
      id: beverageRow.id,
      name: beverageRow.beverage_name,
      quantity: item.quantity,
      unitPrice,
      lineTotal,
    });
  }

  const tax = money(subtotal * Number(outlet.tax_rate));
  const service = money(subtotal * Number(outlet.service_charge_rate));
  const total = money(subtotal + tax + service);
  const orderNumber = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'bar_order', 'BAR-') AS number",
    [ctx.tenantId],
  );

  const order = await db.query<{ id: string }>(
    `INSERT INTO bar.orders
       (tenant_id, branch_id, bar_id, tab_id, order_number, channel, guest_id, customer_name,
        status, payment_status, subtotal, tax_total, service_charge_total, total_amount,
        currency_code, served_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'served','unpaid',$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      ctx.tenantId,
      outlet.branch_id,
      input.barId,
      input.tabId ?? null,
      orderNumber.rows[0]!.number,
      input.channel ?? 'counter',
      input.guestId ?? null,
      input.customerName ?? null,
      subtotal,
      tax,
      service,
      total,
      outlet.currency_code,
      ctx.userId,
      ctx.userId,
    ],
  );
  const orderId = order.rows[0]!.id;

  for (const line of lines) {
    await db.query(
      `INSERT INTO bar.order_lines
         (tenant_id, order_id, beverage_id, beverage_name_snapshot, quantity, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, orderId, line.id, line.name, line.quantity, line.unitPrice, line.lineTotal],
    );
    // Deduct bottle/stock usage when the beverage is mapped to an inventory item.
    const beverage = await db.query<{ inventory_sku: string | null }>(
      'SELECT inventory_sku FROM bar.beverages WHERE id = $1',
      [line.id],
    );
    const sku = beverage.rows[0]?.inventory_sku;
    if (sku) {
      const item = await db.query<{ id: string; standard_cost: string }>(
        'SELECT id, standard_cost FROM inventory.items WHERE sku = $1',
        [sku],
      );
      const inventoryItem = item.rows[0];
      const store = await db.query<{ id: string }>(
        `SELECT id FROM inventory.stores WHERE branch_id = $1 AND store_type = 'bar' AND status = 'active'
          UNION ALL SELECT id FROM inventory.stores WHERE branch_id = $1 AND store_type = 'main' AND status = 'active'
          LIMIT 1`,
        [outlet.branch_id],
      );
      const storeId = store.rows[0]?.id;
      if (inventoryItem && storeId) {
        await db.query(
          `INSERT INTO inventory.movements
             (tenant_id, branch_id, store_id, item_id, movement_type, quantity, unit_cost, total_cost,
              reference_type, reference_id, notes, performed_by)
           VALUES ($1,$2,$3,$4,'issue',$5,$6,$7,'bar_order',$8,$9,$10)
           ON CONFLICT (tenant_id, reference_type, reference_id, item_id, movement_type)
             WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL DO NOTHING`,
          [
            ctx.tenantId,
            outlet.branch_id,
            storeId,
            inventoryItem.id,
            -money(line.quantity),
            Number(inventoryItem.standard_cost),
            money(line.quantity * Number(inventoryItem.standard_cost)),
            orderId,
            `Bar order ${orderNumber.rows[0]!.number}`,
            ctx.userId,
          ],
        );
      }
    }
  }

  await auditAction(db, ctx, 'bar.order_created', 'bar_order', orderId, {
    after: { total, barId: input.barId },
    branchId: outlet.branch_id,
  });
  await emitEvent(db, ctx.tenantId, 'bar.order_created', 'bar_order', orderId, { total });

  return {
    orderId,
    orderNumber: orderNumber.rows[0]!.number,
    subtotal,
    taxTotal: tax,
    serviceChargeTotal: service,
    totalAmount: total,
    status: 'served',
    paymentStatus: 'unpaid',
  };
}

export async function getOrder(db: Queryable, orderId: string) {
  const order = await db.query(
    `SELECT o.id, o.order_number, o.channel, o.status, o.payment_status, o.subtotal, o.tax_total,
            o.service_charge_total, o.total_amount, o.folio_id, o.opened_at, b.bar_name
       FROM bar.orders o JOIN bar.outlets b ON b.id = o.bar_id WHERE o.id = $1`,
    [orderId],
  );
  if (!order.rows[0]) throw notFound('Bar order not found');
  const lines = await db.query(
    'SELECT id, beverage_name_snapshot, quantity, unit_price, line_total, status FROM bar.order_lines WHERE order_id = $1',
    [orderId],
  );
  return { ...order.rows[0], lines: lines.rows };
}

export async function listOrders(db: Queryable, barId?: string) {
  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.channel, o.status, o.payment_status, o.total_amount,
            o.opened_at, o.customer_name
       FROM bar.orders o
      WHERE ($1::uuid IS NULL OR o.bar_id = $1)
      ORDER BY o.opened_at DESC LIMIT 100`,
    [barId ?? null],
  );
  return rows;
}

export async function recogniseOrderRevenue(
  db: Queryable,
  ctx: { tenantId: string; userId: string | null },
  orderId: string,
  debitAccount: string,
): Promise<string> {
  const order = await db.query<{ total_amount: string; branch_id: string; order_number: string }>(
    'SELECT total_amount, branch_id, order_number FROM bar.orders WHERE id = $1',
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound('Bar order not found');
  return postJournal(db, {
    tenantId: ctx.tenantId,
    branchId: row.branch_id,
    entryDate: today(),
    description: `Bar order ${row.order_number} revenue`,
    sourceType: 'bar_order',
    sourceId: orderId,
    purpose: 'revenue',
    lines: [
      { accountCode: debitAccount, debit: Number(row.total_amount) },
      { accountCode: GL.barRevenue, credit: Number(row.total_amount) },
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
    bar_id: string;
    order_number: string;
    folio_id: string | null;
  }>('SELECT id, total_amount, payment_status, bar_id, order_number, folio_id FROM bar.orders WHERE id = $1 FOR UPDATE', [
    input.orderId,
  ]);
  const row = order.rows[0];
  if (!row) throw notFound('Bar order not found');
  if (row.folio_id) throw conflict('ORDER_ALREADY_ON_FOLIO', 'Order is already charged to a folio');
  if (row.payment_status === 'paid') throw conflict('ORDER_ALREADY_PAID', 'Order is already settled');

  const outlet = await getOutlet(db, row.bar_id);
  if (!outlet.allow_charge_to_room) {
    throw forbidden('This bar is not configured to charge to guest rooms');
  }
  const folio = await db.query<{ id: string; status: string; hotel_id: string }>(
    'SELECT id, status, hotel_id FROM hotel.folios WHERE id = $1',
    [input.folioId],
  );
  const folioRow = folio.rows[0];
  if (!folioRow) throw notFound('Guest folio not found');
  if (folioRow.status !== 'open') throw conflict('FOLIO_CLOSED', 'Guest folio is not open');

  const journalEntryId = await recogniseOrderRevenue(db, ctx, input.orderId, GL.guestReceivable);
  const entry = await db.query<{ id: string }>(
    `INSERT INTO hotel.folio_entries
       (tenant_id, hotel_id, folio_id, entry_type, description, amount, currency_code,
        source_type, source_id, journal_entry_id, business_date, posted_by)
     VALUES ($1,$2,$3,'bar_charge',$4,$5,$6,'bar_order',$7,$8,current_date,$9)
     RETURNING id`,
    [
      ctx.tenantId,
      folioRow.hotel_id,
      input.folioId,
      `Bar order ${row.order_number}`,
      Number(row.total_amount),
      outlet.currency_code,
      input.orderId,
      journalEntryId,
      ctx.userId,
    ],
  );
  await db.query("UPDATE bar.orders SET folio_id = $2, payment_status = 'paid', status = 'closed' WHERE id = $1", [
    input.orderId,
    input.folioId,
  ]);
  await auditAction(db, ctx, 'bar.charged_to_folio', 'bar_order', input.orderId, {
    after: { folioId: input.folioId, amount: Number(row.total_amount) },
  });
  return {
    orderId: input.orderId,
    folioId: input.folioId,
    folioEntryId: entry.rows[0]!.id,
    journalEntryId,
    amount: Number(row.total_amount),
  };
}
