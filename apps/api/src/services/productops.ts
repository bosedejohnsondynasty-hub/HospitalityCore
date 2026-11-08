import type { AuthContext } from '../auth.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';
import { money } from './finance.js';

const NUMERIC = (value: unknown): number => Number(value as string);

async function nextCode(db: Queryable, ctx: AuthContext, key: string, prefix: string): Promise<string> {
  const { rows } = await db.query<{ number: string }>(
    'SELECT app_next_document_number($1, $2, $3) AS number',
    [ctx.tenantId, key, prefix],
  );
  return rows[0]!.number;
}

// ---------------------------------------------------------------------------
// Table reservations
// ---------------------------------------------------------------------------

export async function listReservations(db: Queryable, outletId?: string, onDate?: string) {
  const { rows } = await db.query(
    `SELECT r.*, t.table_code, o.outlet_name,
            lower(r.dining_period) AS period_start, upper(r.dining_period) AS period_end
       FROM restaurant.reservations r
       JOIN restaurant.outlets o ON o.id = r.outlet_id
       LEFT JOIN restaurant.tables t ON t.id = r.table_id
      WHERE ($1::uuid IS NULL OR r.outlet_id = $1)
        AND ($2::date IS NULL OR r.reservation_at >= $2::date AND r.reservation_at < $2::date + interval '1 day')
      ORDER BY r.reservation_at LIMIT 200`,
    [outletId ?? null, onDate ?? null],
  );
  return rows;
}

export async function createReservation(
  db: Queryable,
  ctx: AuthContext,
  input: {
    outletId: string;
    tableId?: string;
    customerName: string;
    customerPhone?: string;
    partySize: number;
    reservationAt: string;
    durationMinutes?: number;
    notes?: string;
  },
) {
  if (!Number.isInteger(input.partySize) || input.partySize <= 0) throw badRequest('partySize must be a positive integer');
  const duration = input.durationMinutes ?? 120;
  if (!Number.isInteger(duration) || duration <= 0) throw badRequest('durationMinutes must be positive');

  if (input.tableId) {
    const table = await db.query<{ seats: number }>('SELECT seats FROM restaurant.tables WHERE id = $1', [input.tableId]);
    if (!table.rows[0]) throw notFound('Table not found');
    if (input.partySize > table.rows[0].seats) {
      throw conflict('PARTY_EXCEEDS_TABLE', `This table seats ${table.rows[0].seats} guests`);
    }
  }

  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO restaurant.reservations
         (tenant_id, outlet_id, table_id, customer_name, customer_phone, party_size, reservation_at, dining_period, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7, tstzrange($7::timestamptz, $7::timestamptz + ($8 * interval '1 minute'), '[)'), $9)
       RETURNING id`,
      [ctx.tenantId, input.outletId, input.tableId ?? null, input.customerName, input.customerPhone ?? null, input.partySize, input.reservationAt, duration, input.notes ?? null],
    );
    await auditAction(db, ctx, 'restaurant.reservation_created', 'restaurant_reservation', rows[0]!.id, {
      after: { reservationAt: input.reservationAt, partySize: input.partySize },
    });
    await emitEvent(db, ctx.tenantId, 'restaurant.reservation_booked', 'restaurant_reservation', rows[0]!.id, {
      outletId: input.outletId,
      partySize: input.partySize,
      reservationAt: input.reservationAt,
    });
    return { id: rows[0]!.id, durationMinutes: duration };
  } catch (err) {
    if ((err as { code?: string }).code === '23P01') {
      throw conflict('TABLE_ALREADY_RESERVED', 'That table is already reserved for an overlapping seating period');
    }
    throw err;
  }
}

export async function updateReservationStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  const { rows } = await db.query<{ status: string; table_id: string | null }>(
    'SELECT status, table_id FROM restaurant.reservations WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw notFound('Reservation not found');
  const allowed: Record<string, string[]> = {
    booked: ['seated', 'cancelled', 'no_show'],
    seated: ['completed', 'cancelled'],
    cancelled: [],
    no_show: [],
    completed: [],
  };
  if (!(allowed[rows[0].status] ?? []).includes(status)) {
    throw conflict('RESERVATION_TRANSITION', `Reservation cannot move from ${rows[0].status} to ${status}`);
  }
  await db.query('UPDATE restaurant.reservations SET status = $2 WHERE id = $1', [id, status]);
  if (rows[0].table_id) {
    if (status === 'seated') {
      await db.query("UPDATE restaurant.tables SET status = 'occupied' WHERE id = $1", [rows[0].table_id]);
    } else if (status === 'completed' || status === 'cancelled' || status === 'no_show') {
      await db.query("UPDATE restaurant.tables SET status = 'free' WHERE id = $1 AND status = 'reserved'", [rows[0].table_id]);
    }
  }
  await auditAction(db, ctx, 'restaurant.reservation_status', 'restaurant_reservation', id, { after: { status } });
  return { id, status };
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export async function listWaitlist(db: Queryable, outletId?: string) {
  const { rows } = await db.query(
    `SELECT * FROM restaurant.waitlist
      WHERE ($1::uuid IS NULL OR outlet_id = $1)
      ORDER BY CASE status WHEN 'waiting' THEN 0 ELSE 1 END, queued_at LIMIT 200`,
    [outletId ?? null],
  );
  return rows;
}

export async function addToWaitlist(
  db: Queryable,
  ctx: AuthContext,
  input: { outletId: string; customerName: string; customerPhone?: string; partySize: number; quotedMinutes?: number },
) {
  if (!Number.isInteger(input.partySize) || input.partySize <= 0) throw badRequest('partySize must be a positive integer');
  const { rows } = await db.query<{ id: string; queued_at: string }>(
    `INSERT INTO restaurant.waitlist
       (tenant_id, outlet_id, customer_name, customer_phone, party_size, quoted_minutes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, queued_at`,
    [ctx.tenantId, input.outletId, input.customerName, input.customerPhone ?? null, input.partySize, input.quotedMinutes ?? 15],
  );
  const position = await db.query<{ position: string }>(
    `SELECT COUNT(*)::text AS position FROM restaurant.waitlist
      WHERE outlet_id = $1 AND status = 'waiting'
        AND queued_at <= (SELECT queued_at FROM restaurant.waitlist WHERE id = $2)`,
    [input.outletId, rows[0]!.id],
  );
  await auditAction(db, ctx, 'restaurant.waitlist_added', 'waitlist_entry', rows[0]!.id);
  return { id: rows[0]!.id, position: Number(position.rows[0]!.position) };
}

async function closeWaitlistEntry(db: Queryable, ctx: AuthContext, id: string, status: 'seated' | 'abandoned') {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM restaurant.waitlist WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Waitlist entry not found');
  if (rows[0].status !== 'waiting') throw conflict('WAITLIST_CLOSED', `This waitlist entry is already ${rows[0].status}`);
  await db.query(
    'UPDATE restaurant.waitlist SET status = $2, seated_at = CASE WHEN $2 = $3 THEN now() ELSE seated_at END WHERE id = $1',
    [id, status, 'seated'],
  );
  await auditAction(db, ctx, `restaurant.waitlist_${status}`, 'waitlist_entry', id);
  return { id, status };
}

export const seatWaitlist = (db: Queryable, ctx: AuthContext, id: string) => closeWaitlistEntry(db, ctx, id, 'seated');
export const abandonWaitlist = (db: Queryable, ctx: AuthContext, id: string) => closeWaitlistEntry(db, ctx, id, 'abandoned');

// ---------------------------------------------------------------------------
// Customers and loyalty
// ---------------------------------------------------------------------------

export async function listCustomers(db: Queryable, search?: string) {
  const { rows } = await db.query(
    `SELECT * FROM restaurant.customers
      WHERE ($1::text IS NULL OR full_name ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
      ORDER BY full_name LIMIT 200`,
    [search ?? null],
  );
  return rows;
}

export async function createCustomer(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    customerCode?: string;
    fullName: string;
    email?: string;
    phone?: string;
    segment?: string;
    marketingConsent?: boolean;
  },
) {
  const code = input.customerCode ?? (await nextCode(db, ctx, 'restaurant_customer', 'CUS-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO restaurant.customers
       (tenant_id, branch_id, customer_code, full_name, email, phone, segment, marketing_consent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.fullName, input.email ?? null, input.phone ?? null, input.segment ?? 'general', input.marketingConsent ?? false],
  );
  await auditAction(db, ctx, 'restaurant.customer_created', 'restaurant_customer', rows[0]!.id);
  return { id: rows[0]!.id, customerCode: code };
}

export async function updateCustomerSegment(db: Queryable, ctx: AuthContext, id: string, segment: string) {
  const { rows } = await db.query<{ id: string }>(
    'UPDATE restaurant.customers SET segment = $2, updated_at = now() WHERE id = $1 RETURNING id',
    [id, segment],
  );
  if (!rows[0]) throw notFound('Customer not found');
  await auditAction(db, ctx, 'restaurant.customer_segment', 'restaurant_customer', id, { after: { segment } });
  return { id, segment };
}

export async function loyaltyBalance(db: Queryable, customerId: string) {
  const customer = await db.query<{ loyalty_points: number; full_name: string }>(
    'SELECT loyalty_points, full_name FROM restaurant.customers WHERE id = $1',
    [customerId],
  );
  if (!customer.rows[0]) throw notFound('Customer not found');
  const movements = await db.query(
    'SELECT event_type, points, balance_after, reference, created_at FROM restaurant.loyalty_ledger WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50',
    [customerId],
  );
  return {
    customerId,
    customerName: customer.rows[0].full_name,
    pointsBalance: customer.rows[0].loyalty_points,
    movements: movements.rows,
  };
}

/** Appends an immutable loyalty movement and updates the cached customer balance. */
async function moveLoyaltyPoints(
  db: Queryable,
  ctx: AuthContext,
  customerId: string,
  input: { eventType: 'earn' | 'redeem' | 'adjustment'; points: number; reference?: string },
) {
  if (!Number.isInteger(input.points) || input.points === 0) throw badRequest('points must be a non-zero integer');
  if (input.eventType === 'redeem' && input.points > 0) throw badRequest('Redemptions must be recorded as negative points');
  if (input.eventType === 'earn' && input.points < 0) throw badRequest('Earnings must be recorded as positive points');

  const { rows } = await db.query<{ loyalty_points: number }>(
    'SELECT loyalty_points FROM restaurant.customers WHERE id = $1 FOR UPDATE',
    [customerId],
  );
  if (!rows[0]) throw notFound('Customer not found');
  const balanceAfter = rows[0].loyalty_points + input.points;
  if (balanceAfter < 0) throw conflict('INSUFFICIENT_POINTS', `Customer has only ${rows[0].loyalty_points} points`);
  await db.query(
    `INSERT INTO restaurant.loyalty_ledger
       (tenant_id, customer_id, event_type, points, balance_after, reference)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, customerId, input.eventType, input.points, balanceAfter, input.reference ?? null],
  );
  await db.query(
    'UPDATE restaurant.customers SET loyalty_points = $2, updated_at = now() WHERE id = $1',
    [customerId, balanceAfter],
  );
  await auditAction(db, ctx, `restaurant.loyalty_${input.eventType}`, 'restaurant_customer', customerId, {
    after: { points: input.points, balanceAfter },
  });
  return { customerId, points: input.points, balanceAfter };
}

export const earnLoyaltyPoints = (
  db: Queryable,
  ctx: AuthContext,
  customerId: string,
  input: { points: number; reference?: string },
) => moveLoyaltyPoints(db, ctx, customerId, { eventType: 'earn', ...input });

export const redeemLoyaltyPoints = (
  db: Queryable,
  ctx: AuthContext,
  customerId: string,
  input: { points: number; reference?: string },
) => moveLoyaltyPoints(db, ctx, customerId, { eventType: 'redeem', ...input, points: -Math.abs(input.points) });

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export async function listPromotions(db: Queryable) {
  const { rows } = await db.query(
    `SELECT *, (starts_at <= now() AND ends_at >= now()) AS in_window
       FROM restaurant.promotions ORDER BY starts_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({
    ...r,
    discount_percent: NUMERIC(r.discount_percent),
    fixed_discount: NUMERIC(r.fixed_discount),
    minimum_subtotal: NUMERIC(r.minimum_subtotal),
  }));
}

export async function createPromotion(
  db: Queryable,
  ctx: AuthContext,
  input: {
    promoCode: string;
    promoName: string;
    promotionType?: string;
    discountPercent?: number;
    fixedDiscount?: number;
    minimumSubtotal?: number;
    startsAt: string;
    endsAt: string;
  },
) {
  const percent = input.discountPercent ?? 0;
  const fixed = input.fixedDiscount ?? 0;
  if (percent > 0 && fixed > 0) throw badRequest('A promotion uses either a percentage or a fixed discount, not both');
  if (percent < 0 || percent > 100) throw badRequest('discountPercent must be between 0 and 100');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO restaurant.promotions
       (tenant_id, promo_code, promo_name, promotion_type, discount_percent, fixed_discount, minimum_subtotal, starts_at, ends_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft') RETURNING id`,
    [ctx.tenantId, input.promoCode, input.promoName, input.promotionType ?? (percent > 0 ? 'percentage_discount' : 'fixed_discount'), money(percent), money(fixed), money(input.minimumSubtotal ?? 0), input.startsAt, input.endsAt],
  );
  await auditAction(db, ctx, 'restaurant.promotion_created', 'promotion', rows[0]!.id);
  return { id: rows[0]!.id, promoCode: input.promoCode };
}

export async function updatePromotionStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM restaurant.promotions WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Promotion not found');
  const allowed: Record<string, string[]> = {
    draft: ['active', 'inactive'],
    active: ['inactive', 'expired'],
    inactive: ['active', 'expired'],
    expired: [],
  };
  if (!(allowed[rows[0].status] ?? []).includes(status)) {
    throw conflict('PROMOTION_TRANSITION', `Promotion cannot move from ${rows[0].status} to ${status}`);
  }
  await db.query('UPDATE restaurant.promotions SET status = $2 WHERE id = $1', [id, status]);
  await auditAction(db, ctx, 'restaurant.promotion_status', 'promotion', id, { after: { status } });
  return { id, status };
}

/** Quotes a promotion discount for a subtotal without mutating an order. */
export async function quotePromotion(db: Queryable, promoCode: string, subtotal: number) {
  const { rows } = await db.query<{
    id: string;
    promo_name: string;
    discount_percent: string;
    fixed_discount: string;
    minimum_subtotal: string;
    status: string;
    starts_at: Date;
    ends_at: Date;
  }>(
    `SELECT id, promo_name, discount_percent, fixed_discount, minimum_subtotal, status, starts_at, ends_at
       FROM restaurant.promotions WHERE promo_code = $1`,
    [promoCode],
  );
  const promo = rows[0];
  if (!promo) throw notFound('Promotion not found');
  if (promo.status !== 'active') throw conflict('PROMOTION_INACTIVE', `Promotion ${promoCode} is ${promo.status}`);
  const now = Date.now();
  if (promo.starts_at.getTime() > now || promo.ends_at.getTime() < now) {
    throw conflict('PROMOTION_OUT_OF_WINDOW', `Promotion ${promoCode} is outside its validity window`);
  }
  if (subtotal < NUMERIC(promo.minimum_subtotal)) {
    throw conflict('PROMOTION_MINIMUM', `Promotion ${promoCode} needs a subtotal of at least ${NUMERIC(promo.minimum_subtotal)}`);
  }
  const amount = money(
    NUMERIC(promo.discount_percent) > 0
      ? (subtotal * NUMERIC(promo.discount_percent)) / 100
      : NUMERIC(promo.fixed_discount),
  );
  const discount = Math.min(amount, subtotal);
  return {
    promotionId: promo.id,
    promoCode,
    promoName: promo.promo_name,
    subtotal: money(subtotal),
    discount,
    netSubtotal: money(subtotal - discount),
  };
}

// ---------------------------------------------------------------------------
// Food cost and plate margins
// ---------------------------------------------------------------------------

export async function foodCostReport(db: Queryable, outletId?: string) {
  const { rows } = await db.query(
    `SELECT mi.id AS item_id, mi.sku, mi.item_name, mi.price, o.outlet_name,
            r.yield_quantity,
            COALESCE(SUM((ri.quantity * (1 + ri.wastage_percent / 100)) * ii.standard_cost / GREATEST(r.yield_quantity, 1)), 0) AS plate_cost
       FROM restaurant.menu_items mi
       JOIN restaurant.menus m ON m.id = mi.menu_id
       JOIN restaurant.outlets o ON o.id = m.outlet_id
       LEFT JOIN restaurant.recipes r ON r.item_id = mi.id
       LEFT JOIN restaurant.recipe_ingredients ri ON ri.recipe_id = r.id
       LEFT JOIN inventory.items ii ON ii.sku = ri.item_sku
      WHERE ($1::uuid IS NULL OR m.outlet_id = $1)
      GROUP BY mi.id, o.outlet_name, r.yield_quantity
      ORDER BY o.outlet_name, mi.item_name`,
    [outletId ?? null],
  );
  const items = rows.map((r) => {
    const price = NUMERIC(r.price);
    const plateCost = money(NUMERIC(r.plate_cost));
    const margin = money(price - plateCost);
    return {
      ...r,
      price,
      plate_cost: plateCost,
      margin,
      margin_percent: price === 0 ? 0 : Math.round((margin / price) * 10000) / 100,
      costed: plateCost > 0,
    };
  });
  const costed = items.filter((i) => i.costed);
  return {
    items,
    totals: {
      itemCount: items.length,
      costedItemCount: costed.length,
      averageMarginPercent: costed.length
        ? Math.round((costed.reduce((s, i) => s + i.margin_percent, 0) / costed.length) * 100) / 100
        : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Bar events and ticket bookings
// ---------------------------------------------------------------------------

export async function listBarEvents(db: Queryable, barId?: string) {
  const { rows } = await db.query(
    `SELECT e.*, o.bar_name,
            COALESCE(SUM(b.seats) FILTER (WHERE b.status = 'booked'), 0)::int AS booked_seats,
            COALESCE(SUM(b.amount) FILTER (WHERE b.status = 'booked'), 0) AS booked_amount
       FROM bar.events e
       JOIN bar.outlets o ON o.id = e.bar_id
       LEFT JOIN bar.event_bookings b ON b.event_id = e.id
      WHERE ($1::uuid IS NULL OR e.bar_id = $1)
      GROUP BY e.id, o.bar_name
      ORDER BY e.event_date DESC LIMIT 200`,
    [barId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    ticket_price: NUMERIC(r.ticket_price),
    booked_amount: NUMERIC(r.booked_amount),
  }));
}

export async function createBarEvent(
  db: Queryable,
  ctx: AuthContext,
  input: {
    barId: string;
    eventName: string;
    eventDate: string;
    startsAt?: string;
    capacity?: number;
    ticketPrice?: number;
    description?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO bar.events
       (tenant_id, bar_id, event_name, event_date, starts_at, capacity, ticket_price, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, input.barId, input.eventName, input.eventDate, input.startsAt ?? null, input.capacity ?? null, money(input.ticketPrice ?? 0), input.description ?? null],
  );
  await auditAction(db, ctx, 'bar.event_created', 'bar_event', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function updateBarEventStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM bar.events WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Bar event not found');
  const allowed: Record<string, string[]> = {
    planned: ['on_sale', 'cancelled'],
    on_sale: ['sold_out', 'completed', 'cancelled'],
    sold_out: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  if (!(allowed[rows[0].status] ?? []).includes(status)) {
    throw conflict('BAR_EVENT_TRANSITION', `Event cannot move from ${rows[0].status} to ${status}`);
  }
  await db.query('UPDATE bar.events SET status = $2 WHERE id = $1', [id, status]);
  await auditAction(db, ctx, 'bar.event_status', 'bar_event', id, { after: { status } });
  return { id, status };
}

export async function listBarEventBookings(db: Queryable, eventId?: string) {
  const { rows } = await db.query(
    `SELECT b.*, e.event_name, e.event_date
       FROM bar.event_bookings b
       JOIN bar.events e ON e.id = b.event_id
      WHERE ($1::uuid IS NULL OR b.event_id = $1)
      ORDER BY b.created_at DESC LIMIT 200`,
    [eventId ?? null],
  );
  return rows.map((r) => ({ ...r, ticket_price: NUMERIC(r.ticket_price), amount: NUMERIC(r.amount) }));
}

export async function createBarEventBooking(
  db: Queryable,
  ctx: AuthContext,
  eventId: string,
  input: { customerName: string; seats: number; ticketPrice?: number },
) {
  if (!Number.isInteger(input.seats) || input.seats <= 0) throw badRequest('seats must be a positive integer');
  const event = await db.query<{ capacity: number | null; ticket_price: string; status: string }>(
    'SELECT capacity, ticket_price, status FROM bar.events WHERE id = $1 FOR UPDATE',
    [eventId],
  );
  if (!event.rows[0]) throw notFound('Bar event not found');
  if (event.rows[0].status !== 'on_sale' && event.rows[0].status !== 'planned') {
    throw conflict('BAR_EVENT_CLOSED', `Bookings are not open for a ${event.rows[0].status} event`);
  }
  if (event.rows[0].capacity !== null) {
    const booked = await db.query<{ seats: string }>(
      "SELECT COALESCE(SUM(seats), 0) AS seats FROM bar.event_bookings WHERE event_id = $1 AND status = 'booked'",
      [eventId],
    );
    if (NUMERIC(booked.rows[0]!.seats) + input.seats > event.rows[0].capacity) {
      throw conflict('BAR_EVENT_FULL', `Only ${event.rows[0].capacity - NUMERIC(booked.rows[0]!.seats)} seats remain`);
    }
  }
  const ticketPrice = money(input.ticketPrice ?? NUMERIC(event.rows[0].ticket_price));
  const amount = money(input.seats * ticketPrice);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO bar.event_bookings (tenant_id, event_id, customer_name, seats, ticket_price, amount)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, eventId, input.customerName, input.seats, ticketPrice, amount],
  );
  await auditAction(db, ctx, 'bar.event_booking_created', 'bar_event_booking', rows[0]!.id, {
    after: { seats: input.seats, amount },
  });
  return { id: rows[0]!.id, seats: input.seats, amount };
}

export async function cancelBarEventBooking(db: Queryable, ctx: AuthContext, id: string) {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM bar.event_bookings WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Event booking not found');
  if (rows[0].status !== 'booked') throw conflict('BOOKING_ALREADY_CANCELLED', 'This event booking is already cancelled');
  await db.query("UPDATE bar.event_bookings SET status = 'cancelled' WHERE id = $1", [id]);
  await auditAction(db, ctx, 'bar.event_booking_cancelled', 'bar_event_booking', id);
  return { id, status: 'cancelled' };
}
