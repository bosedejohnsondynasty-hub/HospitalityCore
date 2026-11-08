import type { AuthContext } from '../auth.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';
import { GL, money, postJournal } from './finance.js';

const NUMERIC = (value: unknown): number => Number(value as string);

async function nextCode(db: Queryable, ctx: AuthContext, key: string, prefix: string): Promise<string> {
  const { rows } = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, $2, $3) AS number",
    [ctx.tenantId, key, prefix],
  );
  return rows[0]!.number;
}

async function transition(
  db: Queryable,
  table: string,
  id: string,
  from: string[],
  to: string,
  action: string,
  errorCode: string,
): Promise<void> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw notFound('Record not found');
  if (!from.includes(rows[0].status)) throw conflict(errorCode, `${action} is not allowed from ${rows[0].status}`);
  await db.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [id, to]);
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw badRequest(`${field} must be zero or greater`);
  return money(value);
}

// ---------------------------------------------------------------------------
// Banquet and events
// ---------------------------------------------------------------------------

export async function listBanquets(db: Queryable) {
  const { rows } = await db.query(
    `SELECT e.*, COALESCE(SUM(c.amount), 0) AS charges_total, COUNT(c.id)::int AS charge_count
       FROM guestops.banquet_events e
       LEFT JOIN guestops.banquet_charges c ON c.event_id = e.id
      GROUP BY e.id ORDER BY e.event_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({
    ...r,
    estimated_revenue: NUMERIC(r.estimated_revenue),
    charges_total: NUMERIC(r.charges_total),
  }));
}

export async function createBanquet(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    hotelId?: string;
    eventCode?: string;
    eventName: string;
    clientName: string;
    eventAt: string;
    expectedPax?: number;
    estimatedRevenue?: number;
    functionSheet?: string;
  },
) {
  const code = input.eventCode ?? (await nextCode(db, ctx, 'banquet_event', 'BEO-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.banquet_events
       (tenant_id, branch_id, hotel_id, event_code, event_name, client_name, event_at, expected_pax, estimated_revenue, function_sheet)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, input.hotelId ?? null, code, input.eventName, input.clientName, input.eventAt, input.expectedPax ?? 0, money(input.estimatedRevenue ?? 0), input.functionSheet ?? null],
  );
  await auditAction(db, ctx, 'guestops.banquet_event_created', 'banquet_event', rows[0]!.id);
  return { id: rows[0]!.id, eventCode: code };
}

export async function updateBanquetStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'guestops.banquet_events', id, ['enquiry', 'booked', 'confirmed', 'delivered'], status, 'Banquet event', 'BANQUET_TRANSITION');
  await auditAction(db, ctx, 'guestops.banquet_event_status', 'banquet_event', id, { after: { status } });
  if (status === 'completed') {
    await emitEvent(db, ctx.tenantId, 'banquet.completed', 'banquet_event', id, {});
  }
  return { id, status };
}

export async function addBanquetCharge(
  db: Queryable,
  ctx: AuthContext,
  eventId: string,
  input: { chargeType: string; description: string; quantity: number; unitPrice: number },
) {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM guestops.banquet_events WHERE id = $1 FOR UPDATE', [eventId]);
  if (!rows[0]) throw notFound('Banquet event not found');
  if (rows[0].status === 'completed' || rows[0].status === 'cancelled') {
    throw conflict('BANQUET_CLOSED', 'Charges cannot be added to a completed or cancelled event');
  }
  if (!(input.quantity > 0)) throw badRequest('quantity must be greater than zero');
  const amount = money(input.quantity * positive(input.unitPrice, 'unitPrice'));
  const { rows: inserted } = await db.query<{ id: string }>(
    `INSERT INTO guestops.banquet_charges
       (tenant_id, event_id, charge_type, description, quantity, unit_price, amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, eventId, input.chargeType, input.description, input.quantity, money(input.unitPrice), amount],
  );
  await auditAction(db, ctx, 'guestops.banquet_charge_added', 'banquet_event', eventId, {
    after: { amount, description: input.description },
  });
  return { id: inserted[0]!.id, amount };
}

export async function listBanquetCharges(db: Queryable, eventId: string) {
  const { rows } = await db.query(
    'SELECT * FROM guestops.banquet_charges WHERE event_id = $1 ORDER BY id',
    [eventId],
  );
  return rows.map((r) => ({
    ...r,
    quantity: NUMERIC(r.quantity),
    unit_price: NUMERIC(r.unit_price),
    amount: NUMERIC(r.amount),
  }));
}

// ---------------------------------------------------------------------------
// Sales and marketing
// ---------------------------------------------------------------------------

export async function listSalesCampaigns(db: Queryable) {
  const { rows } = await db.query(
    `SELECT c.*, COUNT(o.id)::int AS opportunity_count,
            COALESCE(SUM(o.estimated_value), 0) AS pipeline_value
       FROM guestops.sales_campaigns c
       LEFT JOIN guestops.sales_opportunities o ON o.campaign_id = c.id
      GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({
    ...r,
    budget_amount: NUMERIC(r.budget_amount),
    expected_revenue: NUMERIC(r.expected_revenue),
    pipeline_value: NUMERIC(r.pipeline_value),
  }));
}

export async function createSalesCampaign(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    campaignCode?: string;
    campaignName: string;
    channel?: string;
    budgetAmount?: number;
    expectedRevenue?: number;
    startsOn?: string;
    endsOn?: string;
  },
) {
  const code = input.campaignCode ?? (await nextCode(db, ctx, 'sales_campaign', 'CMP-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.sales_campaigns
       (tenant_id, branch_id, campaign_code, campaign_name, channel, budget_amount, expected_revenue, starts_on, ends_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.campaignName, input.channel ?? 'email', money(input.budgetAmount ?? 0), money(input.expectedRevenue ?? 0), input.startsOn ?? null, input.endsOn ?? null],
  );
  await auditAction(db, ctx, 'guestops.sales_campaign_created', 'sales_campaign', rows[0]!.id);
  return { id: rows[0]!.id, campaignCode: code };
}

export async function updateSalesCampaignStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'guestops.sales_campaigns', id, ['draft', 'active'], status, 'Sales campaign', 'CAMPAIGN_TRANSITION');
  await auditAction(db, ctx, 'guestops.sales_campaign_status', 'sales_campaign', id, { after: { status } });
  return { id, status };
}

export async function listSalesOpportunities(db: Queryable, campaignId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM guestops.sales_opportunities WHERE ($1::uuid IS NULL OR campaign_id = $1) ORDER BY stage, expected_close_date NULLS LAST LIMIT 200',
    [campaignId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    estimated_value: NUMERIC(r.estimated_value),
    probability_percent: NUMERIC(r.probability_percent),
    weighted_value: money((NUMERIC(r.estimated_value) * NUMERIC(r.probability_percent)) / 100),
  }));
}

export async function createSalesOpportunity(
  db: Queryable,
  ctx: AuthContext,
  input: {
    campaignId?: string;
    prospectName: string;
    contactEmail?: string;
    estimatedValue?: number;
    probabilityPercent?: number;
    expectedCloseDate?: string;
    notes?: string;
  },
) {
  if (input.probabilityPercent !== undefined && !(input.probabilityPercent >= 0 && input.probabilityPercent <= 100)) {
    throw badRequest('probabilityPercent must be between 0 and 100');
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.sales_opportunities
       (tenant_id, campaign_id, prospect_name, contact_email, estimated_value, probability_percent, expected_close_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, input.campaignId ?? null, input.prospectName, input.contactEmail ?? null, money(input.estimatedValue ?? 0), input.probabilityPercent ?? 50, input.expectedCloseDate ?? null, input.notes ?? null],
  );
  await auditAction(db, ctx, 'guestops.sales_opportunity_created', 'sales_opportunity', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function updateSalesOpportunityStage(db: Queryable, ctx: AuthContext, id: string, stage: string) {
  const { rows } = await db.query<{ stage: string }>(
    'SELECT stage FROM guestops.sales_opportunities WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw notFound('Sales opportunity not found');
  const order = ['new', 'qualified', 'proposal', 'negotiating', 'won', 'lost'];
  const from = order.indexOf(rows[0].stage);
  const to = order.indexOf(stage);
  const terminal = rows[0].stage === 'won' || rows[0].stage === 'lost';
  if (terminal || to <= from) {
    throw conflict('OPPORTUNITY_TRANSITION', `Opportunity cannot move from ${rows[0].stage} to ${stage}`);
  }
  await db.query('UPDATE guestops.sales_opportunities SET stage = $2 WHERE id = $1', [id, stage]);
  await auditAction(db, ctx, 'guestops.sales_opportunity_stage', 'sales_opportunity', id, {
    before: { stage: rows[0].stage },
    after: { stage },
  });
  return { id, stage };
}

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

export async function listCrmSegments(db: Queryable) {
  const { rows } = await db.query(
    `SELECT s.*, COUNT(i.id)::int AS interaction_count
       FROM guestops.crm_segments s
       LEFT JOIN guestops.crm_interactions i ON i.segment_id = s.id
      GROUP BY s.id ORDER BY s.segment_name`,
  );
  return rows;
}

export async function createCrmSegment(
  db: Queryable,
  ctx: AuthContext,
  input: { segmentCode?: string; segmentName: string; criteria?: Record<string, unknown> },
) {
  const code = input.segmentCode ?? (await nextCode(db, ctx, 'crm_segment', 'SEG-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.crm_segments (tenant_id, segment_code, segment_name, criteria)
     VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
    [ctx.tenantId, code, input.segmentName, JSON.stringify(input.criteria ?? {})],
  );
  await auditAction(db, ctx, 'guestops.crm_segment_created', 'crm_segment', rows[0]!.id);
  return { id: rows[0]!.id, segmentCode: code };
}

export async function listCrmInteractions(db: Queryable, guestId?: string) {
  const { rows } = await db.query(
    `SELECT i.*, s.segment_name
       FROM guestops.crm_interactions i
       LEFT JOIN guestops.crm_segments s ON s.id = i.segment_id
      WHERE ($1::uuid IS NULL OR i.guest_id = $1)
      ORDER BY i.occurred_at DESC LIMIT 200`,
    [guestId ?? null],
  );
  return rows;
}

export async function createCrmInteraction(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    guestId?: string;
    segmentId?: string;
    customerName?: string;
    interactionType: string;
    summary: string;
    satisfactionScore?: number;
    followUpDue?: string;
  },
) {
  if (input.satisfactionScore !== undefined && !(input.satisfactionScore >= 1 && input.satisfactionScore <= 5)) {
    throw badRequest('satisfactionScore must be between 1 and 5');
  }
  if (!input.guestId && !input.customerName) throw badRequest('guestId or customerName is required');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.crm_interactions
       (tenant_id, branch_id, guest_id, segment_id, customer_name, interaction_type, summary, satisfaction_score, follow_up_due)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, input.guestId ?? null, input.segmentId ?? null, input.customerName ?? null, input.interactionType, input.summary, input.satisfactionScore ?? null, input.followUpDue ?? null],
  );
  await auditAction(db, ctx, 'guestops.crm_interaction_created', 'crm_interaction', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function completeCrmInteraction(db: Queryable, ctx: AuthContext, id: string) {
  await transition(db, 'guestops.crm_interactions', id, ['open'], 'completed', 'CRM interaction', 'CRM_TRANSITION');
  await auditAction(db, ctx, 'guestops.crm_interaction_completed', 'crm_interaction', id);
  return { id, status: 'completed' };
}

// ---------------------------------------------------------------------------
// Channel / revenue management
// ---------------------------------------------------------------------------

export async function listChannelInventory(db: Queryable, hotelId?: string) {
  const { rows } = await db.query(
    `SELECT c.*, rt.room_type_code, rt.room_type_name
       FROM guestops.channel_inventory c
       JOIN hotel.room_types rt ON rt.id = c.room_type_id AND rt.hotel_id = c.hotel_id
      WHERE ($1::uuid IS NULL OR c.hotel_id = $1)
      ORDER BY c.allocation_date DESC, c.channel_name LIMIT 200`,
    [hotelId ?? null],
  );
  return rows.map((r) => ({ ...r, net_rate: NUMERIC(r.net_rate) }));
}

export async function createChannelInventory(
  db: Queryable,
  ctx: AuthContext,
  input: {
    hotelId: string;
    roomTypeId: string;
    channelName: string;
    allocationDate: string;
    allocatedUnits: number;
    netRate?: number;
  },
) {
  if (!Number.isInteger(input.allocatedUnits) || input.allocatedUnits <= 0) throw badRequest('allocatedUnits must be positive');
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO guestops.channel_inventory
         (tenant_id, hotel_id, room_type_id, channel_name, allocation_date, allocated_units, net_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.tenantId, input.hotelId, input.roomTypeId, input.channelName, input.allocationDate, input.allocatedUnits, money(input.netRate ?? 0)],
    );
    await auditAction(db, ctx, 'guestops.channel_inventory_created', 'channel_inventory', rows[0]!.id);
    return { id: rows[0]!.id };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('CHANNEL_ALLOCATION_EXISTS', 'That channel already has allocation for the room type and date');
    throw err;
  }
}

export async function updateChannelInventorySold(
  db: Queryable,
  ctx: AuthContext,
  id: string,
  input: { soldUnits?: number; netRate?: number; parityStatus?: string },
) {
  const { rows } = await db.query<{ allocated_units: number; sold_units: number }>(
    'SELECT allocated_units, sold_units FROM guestops.channel_inventory WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw notFound('Channel inventory record not found');
  const sold = input.soldUnits ?? rows[0].sold_units;
  if (sold < 0 || sold > rows[0].allocated_units) throw badRequest('soldUnits cannot exceed allocatedUnits');
  await db.query(
    `UPDATE guestops.channel_inventory
        SET sold_units = $2, net_rate = COALESCE($3, net_rate), parity_status = COALESCE($4, parity_status)
      WHERE id = $1`,
    [id, sold, input.netRate === undefined ? null : money(input.netRate), input.parityStatus ?? null],
  );
  await auditAction(db, ctx, 'guestops.channel_inventory_updated', 'channel_inventory', id, { after: input });
  return { id, soldUnits: sold };
}

export async function listRevenueForecasts(db: Queryable, hotelId?: string) {
  const { rows } = await db.query(
    `SELECT * FROM guestops.revenue_forecasts
      WHERE ($1::uuid IS NULL OR hotel_id = $1) ORDER BY forecast_date DESC LIMIT 200`,
    [hotelId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    occupancy_percent: NUMERIC(r.occupancy_percent),
    adr: NUMERIC(r.adr),
    forecast_revenue: NUMERIC(r.forecast_revenue),
  }));
}

export async function createRevenueForecast(
  db: Queryable,
  ctx: AuthContext,
  input: {
    hotelId: string;
    forecastDate: string;
    occupancyPercent: number;
    adr: number;
    forecastRevenue: number;
    strategy?: string;
  },
) {
  if (!(input.occupancyPercent >= 0 && input.occupancyPercent <= 100)) throw badRequest('occupancyPercent must be between 0 and 100');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.revenue_forecasts
       (tenant_id, hotel_id, forecast_date, occupancy_percent, adr, forecast_revenue, strategy)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.hotelId, input.forecastDate, input.occupancyPercent, money(input.adr), money(input.forecastRevenue), input.strategy ?? null],
  );
  await auditAction(db, ctx, 'guestops.revenue_forecast_created', 'revenue_forecast', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function approveRevenueForecast(db: Queryable, ctx: AuthContext, id: string) {
  await transition(db, 'guestops.revenue_forecasts', id, ['draft'], 'approved', 'Revenue forecast', 'FORECAST_TRANSITION');
  await auditAction(db, ctx, 'guestops.revenue_forecast_approved', 'revenue_forecast', id);
  return { id, status: 'approved' };
}

export async function revenueSummary(db: Queryable) {
  const { rows } = await db.query(
    `SELECT h.hotel_code, h.hotel_name,
            COUNT(f.id)::int AS forecast_days,
            COALESCE(AVG(f.occupancy_percent), 0) AS avg_occupancy_percent,
            COALESCE(AVG(NULLIF(f.adr, 0)), 0) AS weighted_adr,
            COALESCE(SUM(f.forecast_revenue), 0) AS forecast_revenue
       FROM hotel.hotels h
       LEFT JOIN guestops.revenue_forecasts f ON f.hotel_id = h.id
      GROUP BY h.id, h.hotel_code, h.hotel_name`,
  );
  return rows.map((r) => ({
    ...r,
    avg_occupancy_percent: NUMERIC(r.avg_occupancy_percent),
    weighted_adr: NUMERIC(r.weighted_adr),
    forecast_revenue: NUMERIC(r.forecast_revenue),
  }));
}

// ---------------------------------------------------------------------------
// Spa, tours, call centre
// ---------------------------------------------------------------------------

export async function listSpaResources(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM guestops.spa_resources ORDER BY resource_code');
  return rows;
}

export async function createSpaResource(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; hotelId?: string; resourceCode?: string; resourceName: string; resourceType?: string; capacity?: number },
) {
  const code = input.resourceCode ?? (await nextCode(db, ctx, 'spa_resource', 'SPA-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.spa_resources
       (tenant_id, branch_id, hotel_id, resource_code, resource_name, resource_type, capacity)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, input.hotelId ?? null, code, input.resourceName, input.resourceType ?? 'treatment_room', input.capacity ?? 1],
  );
  await auditAction(db, ctx, 'guestops.spa_resource_created', 'spa_resource', rows[0]!.id);
  return { id: rows[0]!.id, resourceCode: code };
}

export async function listSpaBookings(db: Queryable, hotelId?: string) {
  const { rows } = await db.query(
    `SELECT b.*, r.resource_code, r.resource_name
       FROM guestops.spa_bookings b
       JOIN guestops.spa_resources r ON r.id = b.resource_id
      WHERE ($1::uuid IS NULL OR b.hotel_id = $1)
      ORDER BY b.starts_at DESC LIMIT 200`,
    [hotelId ?? null],
  );
  return rows.map((r) => ({ ...r, price: NUMERIC(r.price) }));
}

export async function createSpaBooking(
  db: Queryable,
  ctx: AuthContext,
  input: {
    hotelId?: string;
    guestId?: string;
    resourceId: string;
    serviceName: string;
    startsAt: string;
    durationMinutes?: number;
    price?: number;
    notes?: string;
  },
) {
  const duration = input.durationMinutes ?? 60;
  if (!Number.isInteger(duration) || duration <= 0) throw badRequest('durationMinutes must be positive');
  const overlap = await db.query(
    `SELECT 1 FROM guestops.spa_bookings
      WHERE resource_id = $1 AND status IN ('booked', 'completed')
        AND tstzrange(starts_at, starts_at + (duration_minutes * interval '1 minute')) &&
            tstzrange($2::timestamptz, $2::timestamptz + ($3 * interval '1 minute'))
      LIMIT 1`,
    [input.resourceId, input.startsAt, duration],
  );
  if (overlap.rowCount) throw conflict('SPA_RESOURCE_UNAVAILABLE', 'That spa resource is already booked at the requested time');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.spa_bookings
       (tenant_id, hotel_id, guest_id, resource_id, service_name, starts_at, duration_minutes, price, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.tenantId, input.hotelId ?? null, input.guestId ?? null, input.resourceId, input.serviceName, input.startsAt, duration, money(input.price ?? 0), input.notes ?? null],
  );
  await auditAction(db, ctx, 'guestops.spa_booking_created', 'spa_booking', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function cancelSpaBooking(db: Queryable, ctx: AuthContext, id: string) {
  await transition(db, 'guestops.spa_bookings', id, ['booked'], 'cancelled', 'Spa booking', 'SPA_TRANSITION');
  await auditAction(db, ctx, 'guestops.spa_booking_cancelled', 'spa_booking', id);
  return { id, status: 'cancelled' };
}

export async function listTourPackages(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM guestops.tour_packages ORDER BY tour_name');
  return rows.map((r) => ({ ...r, price_per_person: NUMERIC(r.price_per_person) }));
}

export async function createTourPackage(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; tourCode?: string; tourName: string; destination?: string; capacity: number; pricePerPerson?: number },
) {
  const code = input.tourCode ?? (await nextCode(db, ctx, 'tour_package', 'TOUR-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.tour_packages
       (tenant_id, branch_id, tour_code, tour_name, destination, capacity, price_per_person)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.tourName, input.destination ?? null, input.capacity, money(input.pricePerPerson ?? 0)],
  );
  await auditAction(db, ctx, 'guestops.tour_package_created', 'tour_package', rows[0]!.id);
  return { id: rows[0]!.id, tourCode: code };
}

export async function listTourBookings(db: Queryable, packageId?: string) {
  const { rows } = await db.query(
    `SELECT b.*, p.tour_code, p.tour_name
       FROM guestops.tour_bookings b
       JOIN guestops.tour_packages p ON p.id = b.package_id
      WHERE ($1::uuid IS NULL OR b.package_id = $1)
      ORDER BY b.departure_at DESC LIMIT 200`,
    [packageId ?? null],
  );
  return rows.map((r) => ({ ...r, amount: NUMERIC(r.amount) }));
}

export async function createTourBooking(
  db: Queryable,
  ctx: AuthContext,
  input: { packageId: string; departureAt: string; groupName: string; pax: number },
) {
  const pkg = await db.query<{ capacity: number; price_per_person: string }>(
    'SELECT capacity, price_per_person FROM guestops.tour_packages WHERE id = $1',
    [input.packageId],
  );
  if (!pkg.rows[0]) throw notFound('Tour package not found');
  if (input.pax <= 0 || input.pax > pkg.rows[0].capacity) throw badRequest('pax must be within the package capacity');
  const amount = money(input.pax * NUMERIC(pkg.rows[0].price_per_person));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.tour_bookings (tenant_id, package_id, departure_at, group_name, pax, amount)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, input.packageId, input.departureAt, input.groupName, input.pax, amount],
  );
  await auditAction(db, ctx, 'guestops.tour_booking_created', 'tour_booking', rows[0]!.id, {
    after: { amount },
  });
  return { id: rows[0]!.id, amount };
}

export async function cancelTourBooking(db: Queryable, ctx: AuthContext, id: string) {
  await transition(db, 'guestops.tour_bookings', id, ['booked'], 'cancelled', 'Tour booking', 'TOUR_TRANSITION');
  await auditAction(db, ctx, 'guestops.tour_booking_cancelled', 'tour_booking', id);
  return { id, status: 'cancelled' };
}

export async function listCallLogs(db: Queryable, hotelId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM guestops.call_logs WHERE ($1::uuid IS NULL OR hotel_id = $1) ORDER BY call_at DESC LIMIT 200',
    [hotelId ?? null],
  );
  return rows.map((r) => ({ ...r, duration_minutes: NUMERIC(r.duration_minutes) }));
}

export async function createCallLog(
  db: Queryable,
  ctx: AuthContext,
  input: { hotelId?: string; callerName?: string; callerPhone?: string; callType?: string; callAt?: string; durationMinutes?: number; outcome: string; resolution?: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.call_logs
       (tenant_id, hotel_id, caller_name, caller_phone, call_type, call_at, duration_minutes, outcome, resolution)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.tenantId, input.hotelId ?? null, input.callerName ?? null, input.callerPhone ?? null, input.callType ?? 'reservation', input.callAt ?? new Date().toISOString(), input.durationMinutes ?? 0, input.outcome, input.resolution ?? null],
  );
  await auditAction(db, ctx, 'guestops.call_log_created', 'call_log', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function listCentralReservations(db: Queryable, hotelId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM guestops.central_reservations WHERE ($1::uuid IS NULL OR hotel_id = $1) ORDER BY arrival_date DESC LIMIT 200',
    [hotelId ?? null],
  );
  return rows.map((r) => ({ ...r, amount: NUMERIC(r.amount) }));
}

export async function createCentralReservation(
  db: Queryable,
  ctx: AuthContext,
  input: {
    hotelId: string;
    bookingReference?: string;
    guestId?: string;
    channel?: string;
    arrivalDate: string;
    departureDate: string;
    amount?: number;
  },
) {
  if (input.departureDate <= input.arrivalDate) throw badRequest('departureDate must be after arrivalDate');
  const reference = input.bookingReference ?? (await nextCode(db, ctx, 'central_reservation', 'CTR-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.central_reservations
       (tenant_id, hotel_id, booking_reference, guest_id, channel, arrival_date, departure_date, amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, input.hotelId, reference, input.guestId ?? null, input.channel ?? 'call_centre', input.arrivalDate, input.departureDate, money(input.amount ?? 0)],
  );
  await auditAction(db, ctx, 'guestops.central_reservation_created', 'central_reservation', rows[0]!.id);
  return { id: rows[0]!.id, bookingReference: reference };
}

export async function updateCentralReservationStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'guestops.central_reservations', id, ['held', 'confirmed'], status, 'Central reservation', 'CENTRAL_RES_TRANSITION');
  await auditAction(db, ctx, 'guestops.central_reservation_status', 'central_reservation', id, { after: { status } });
  return { id, status };
}

// ---------------------------------------------------------------------------
// Food safety
// ---------------------------------------------------------------------------

export async function listFoodSafetyChecks(db: Queryable) {
  const { rows } = await db.query(
    `SELECT c.*, COUNT(l.id)::int AS log_count,
            COUNT(l.id) FILTER (WHERE l.status = 'fail')::int AS failed_readings
       FROM guestops.food_safety_checks c
       LEFT JOIN guestops.food_safety_logs l ON l.check_id = c.id
      GROUP BY c.id ORDER BY c.scheduled_at DESC LIMIT 200`,
  );
  return rows;
}

export async function createFoodSafetyCheck(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; areaName: string; checkType: string; scheduledAt: string; correctiveAction?: string },
) {
  const code = await nextCode(db, ctx, 'food_safety_check', 'FS-');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.food_safety_checks
       (tenant_id, branch_id, check_code, area_name, check_type, scheduled_at, corrective_action)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.areaName, input.checkType, input.scheduledAt, input.correctiveAction ?? null],
  );
  await auditAction(db, ctx, 'guestops.food_safety_check_created', 'food_safety_check', rows[0]!.id);
  return { id: rows[0]!.id, checkCode: code };
}

export async function completeFoodSafetyCheck(
  db: Queryable,
  ctx: AuthContext,
  id: string,
  input: { result: 'pass' | 'fail'; correctiveAction?: string },
) {
  await transition(db, 'guestops.food_safety_checks', id, ['scheduled', 'in_progress'], 'completed', 'Food safety check', 'FOOD_TRANSITION');
  await db.query(
    'UPDATE guestops.food_safety_checks SET result = $2, corrective_action = COALESCE($3, corrective_action), completed_at = now() WHERE id = $1',
    [id, input.result, input.correctiveAction ?? null],
  );
  await auditAction(db, ctx, 'guestops.food_safety_check_completed', 'food_safety_check', id, { after: input });
  return { id, status: 'completed', result: input.result };
}

export async function listFoodSafetyLogs(db: Queryable, checkId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM guestops.food_safety_logs WHERE ($1::uuid IS NULL OR check_id = $1) ORDER BY recorded_at DESC LIMIT 200',
    [checkId ?? null],
  );
  return rows.map((r) => ({ ...r, reading: r.reading === null ? null : NUMERIC(r.reading) }));
}

export async function createFoodSafetyLog(
  db: Queryable,
  ctx: AuthContext,
  input: { checkId: string; logType: string; reading?: number; unit?: string; status?: 'pass' | 'fail'; notes?: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.food_safety_logs
       (tenant_id, check_id, log_type, reading, unit, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.checkId, input.logType, input.reading ?? null, input.unit ?? 'degC', input.status ?? 'pass', input.notes ?? null],
  );
  await auditAction(db, ctx, 'guestops.food_safety_log_created', 'food_safety_log', rows[0]!.id);
  return { id: rows[0]!.id };
}

// ---------------------------------------------------------------------------
// Guest credit and corporate billing
// ---------------------------------------------------------------------------

export async function listCorporateAccounts(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM guestops.corporate_accounts ORDER BY account_name LIMIT 200');
  return rows.map((r) => ({
    ...r,
    credit_limit: NUMERIC(r.credit_limit),
    current_balance: NUMERIC(r.current_balance),
    available_credit: money(NUMERIC(r.credit_limit) - NUMERIC(r.current_balance)),
  }));
}

export async function createCorporateAccount(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; accountCode?: string; accountName: string; billingEmail?: string; creditLimit?: number; priority?: 'standard' | 'premium' },
) {
  const code = input.accountCode ?? (await nextCode(db, ctx, 'corporate_account', 'CORP-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.corporate_accounts
       (tenant_id, branch_id, account_code, account_name, billing_email, credit_limit, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.accountName, input.billingEmail ?? null, money(input.creditLimit ?? 0), input.priority ?? 'standard'],
  );
  await auditAction(db, ctx, 'guestops.corporate_account_created', 'corporate_account', rows[0]!.id);
  return { id: rows[0]!.id, accountCode: code };
}

export async function updateCorporateAccountStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'guestops.corporate_accounts', id, ['active', 'suspended'], status, 'Corporate account', 'CORPORATE_ACCT_TRANSITION');
  await auditAction(db, ctx, 'guestops.corporate_account_status', 'corporate_account', id, { after: { status } });
  return { id, status };
}

export async function listCorporateInvoices(db: Queryable, accountId?: string) {
  const { rows } = await db.query(
    `SELECT i.*, a.account_name
       FROM guestops.corporate_invoices i
       JOIN guestops.corporate_accounts a ON a.id = i.corporate_account_id
      WHERE ($1::uuid IS NULL OR i.corporate_account_id = $1)
      ORDER BY i.issue_date DESC LIMIT 200`,
    [accountId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    amount: NUMERIC(r.amount),
    paid_amount: NUMERIC(r.paid_amount),
    balance: money(NUMERIC(r.amount) - NUMERIC(r.paid_amount)),
  }));
}

/**
 * Issues a corporate invoice and posts it once: Dr Guest Ledger, Cr Other Revenue.
 * Payment settlement is a separate, also-once posting (Dr Bank, Cr Guest Ledger).
 */
export async function createCorporateInvoice(
  db: Queryable,
  ctx: AuthContext,
  input: { corporateAccountId: string; invoiceNumber?: string; issueDate: string; dueDate: string; amount: number },
) {
  const account = await db.query<{ status: string; credit_limit: string; current_balance: string; branch_id: string | null }>(
    'SELECT status, credit_limit, current_balance, branch_id FROM guestops.corporate_accounts WHERE id = $1 FOR UPDATE',
    [input.corporateAccountId],
  );
  if (!account.rows[0]) throw notFound('Corporate account not found');
  if (account.rows[0].status !== 'active') throw conflict('CORPORATE_ACCOUNT_SUSPENDED', 'Suspended or closed corporate accounts cannot receive invoices');
  const value = money(input.amount);
  if (value <= 0) throw badRequest('amount must be greater than zero');
  if (NUMERIC(account.rows[0].current_balance) + value > NUMERIC(account.rows[0].credit_limit)) {
    throw conflict('CREDIT_LIMIT_EXCEEDED', 'This invoice would exceed the corporate credit limit');
  }
  const number = input.invoiceNumber ?? (await nextCode(db, ctx, 'corporate_invoice', 'CINV-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.corporate_invoices
       (tenant_id, corporate_account_id, invoice_number, issue_date, due_date, amount)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, input.corporateAccountId, number, input.issueDate, input.dueDate, value],
  );
  const invoiceId = rows[0]!.id;
  const journalEntryId = await postJournal(db, {
    tenantId: ctx.tenantId,
    branchId: account.rows[0].branch_id,
    entryDate: input.issueDate,
    description: `Corporate invoice ${number}`,
    sourceType: 'corporate_invoice',
    sourceId: invoiceId,
    purpose: 'invoice',
    postedBy: ctx.userId,
    lines: [
      { accountCode: GL.guestReceivable, debit: value, description: 'Corporate receivable' },
      { accountCode: GL.otherRevenue, credit: value, description: 'Corporate billed revenue' },
    ],
  });
  await db.query(
    'UPDATE guestops.corporate_invoices SET journal_entry_id = $2 WHERE id = $1',
    [invoiceId, journalEntryId],
  );
  await db.query(
    'UPDATE guestops.corporate_accounts SET current_balance = current_balance + $2, updated_at = now() WHERE id = $1',
    [input.corporateAccountId, value],
  );
  await auditAction(db, ctx, 'guestops.corporate_invoice_created', 'corporate_invoice', invoiceId, {
    after: { number, amount: value, journalEntryId },
  });
  return { id: invoiceId, invoiceNumber: number, journalEntryId };
}

export async function payCorporateInvoice(
  db: Queryable,
  ctx: AuthContext,
  id: string,
  input: { amount: number; paymentDate?: string },
) {
  const invoice = await db.query<{
    id: string;
    status: string;
    amount: string;
    paid_amount: string;
    invoice_number: string;
    corporate_account_id: string;
  }>(
    'SELECT id, status, amount, paid_amount, invoice_number, corporate_account_id FROM guestops.corporate_invoices WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!invoice.rows[0]) throw notFound('Corporate invoice not found');
  if (invoice.rows[0].status === 'paid') throw conflict('INVOICE_ALREADY_PAID', 'This invoice is already paid');
  if (invoice.rows[0].status === 'void') throw conflict('INVOICE_VOID', 'A void invoice cannot be paid');
  const amountPaid = money(input.amount);
  const balance = money(NUMERIC(invoice.rows[0].amount) - NUMERIC(invoice.rows[0].paid_amount));
  if (amountPaid <= 0 || amountPaid > balance) throw badRequest('amount must be no more than the outstanding balance');

  const account = await db.query<{ branch_id: string | null }>(
    'SELECT branch_id FROM guestops.corporate_accounts WHERE id = $1',
    [invoice.rows[0].corporate_account_id],
  );
  const paymentDate = input.paymentDate ?? new Date().toISOString().slice(0, 10);
  const journalEntryId = await postJournal(db, {
    tenantId: ctx.tenantId,
    branchId: account.rows[0]?.branch_id ?? null,
    entryDate: paymentDate,
    description: `Corporate invoice payment ${invoice.rows[0].invoice_number}`,
    sourceType: 'corporate_invoice',
    sourceId: id,
    purpose: 'payment',
    postedBy: ctx.userId,
    lines: [
      { accountCode: GL.bank, debit: amountPaid, description: 'Corporate payment received' },
      { accountCode: GL.guestReceivable, credit: amountPaid, description: 'Settle corporate receivable' },
    ],
  });
  const newPaid = money(NUMERIC(invoice.rows[0].paid_amount) + amountPaid);
  const status = newPaid >= NUMERIC(invoice.rows[0].amount) ? 'paid' : 'partial';
  await db.query(
    `UPDATE guestops.corporate_invoices
        SET paid_amount = $2, payment_journal_id = $3, status = $4 WHERE id = $1`,
    [id, newPaid, journalEntryId, status],
  );
  await db.query(
    'UPDATE guestops.corporate_accounts SET current_balance = GREATEST(current_balance - $2, 0), updated_at = now() WHERE id = $1',
    [invoice.rows[0].corporate_account_id, amountPaid],
  );
  await auditAction(db, ctx, 'guestops.corporate_invoice_paid', 'corporate_invoice', id, {
    after: { amount: amountPaid, status, journalEntryId },
  });
  return { id, status, journalEntryId };
}

// ---------------------------------------------------------------------------
// Franchise and brand standards
// ---------------------------------------------------------------------------

export async function listFranchiseStandards(db: Queryable) {
  const { rows } = await db.query(
    `SELECT s.*, COUNT(a.id)::int AS audit_count,
            COALESCE(AVG(a.score), 0) AS average_score
       FROM guestops.franchise_standards s
       LEFT JOIN guestops.franchise_audits a ON a.standard_id = s.id
      GROUP BY s.id ORDER BY s.standard_name`,
  );
  return rows.map((r) => ({ ...r, average_score: NUMERIC(r.average_score) }));
}

export async function createFranchiseStandard(
  db: Queryable,
  ctx: AuthContext,
  input: { standardCode?: string; standardName: string; category: string; description?: string; mandatory?: boolean },
) {
  const code = input.standardCode ?? (await nextCode(db, ctx, 'franchise_standard', 'BRD-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.franchise_standards
       (tenant_id, standard_code, standard_name, category, description, mandatory)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, code, input.standardName, input.category, input.description ?? null, input.mandatory ?? false],
  );
  await auditAction(db, ctx, 'guestops.franchise_standard_created', 'franchise_standard', rows[0]!.id);
  return { id: rows[0]!.id, standardCode: code };
}

export async function listFranchiseAudits(db: Queryable, standardId?: string) {
  const { rows } = await db.query(
    `SELECT a.*, s.standard_name, s.standard_code
       FROM guestops.franchise_audits a
       JOIN guestops.franchise_standards s ON s.id = a.standard_id
      WHERE ($1::uuid IS NULL OR a.standard_id = $1)
      ORDER BY a.audit_date DESC LIMIT 200`,
    [standardId ?? null],
  );
  return rows.map((r) => ({ ...r, score: r.score === null ? null : NUMERIC(r.score) }));
}

export async function createFranchiseAudit(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; standardId: string; auditDate: string; auditor?: string; findings?: string },
) {
  const code = await nextCode(db, ctx, 'franchise_audit', 'AUD-');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.franchise_audits
       (tenant_id, branch_id, standard_id, audit_code, audit_date, auditor, findings)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, input.standardId, code, input.auditDate, input.auditor ?? null, input.findings ?? null],
  );
  await auditAction(db, ctx, 'guestops.franchise_audit_created', 'franchise_audit', rows[0]!.id);
  return { id: rows[0]!.id, auditCode: code };
}

export async function completeFranchiseAudit(
  db: Queryable,
  ctx: AuthContext,
  id: string,
  input: { score: number; findings?: string },
) {
  if (!(input.score >= 0 && input.score <= 100)) throw badRequest('score must be between 0 and 100');
  await transition(db, 'guestops.franchise_audits', id, ['scheduled', 'in_progress'], 'completed', 'Franchise audit', 'FRANCHISE_TRANSITION');
  await db.query(
    'UPDATE guestops.franchise_audits SET score = $2, findings = COALESCE($3, findings) WHERE id = $1',
    [id, input.score, input.findings ?? null],
  );
  await auditAction(db, ctx, 'guestops.franchise_audit_completed', 'franchise_audit', id, { after: input });
  return { id, status: 'completed' };
}

export async function listFranchiseActions(db: Queryable, auditId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM guestops.franchise_actions WHERE ($1::uuid IS NULL OR audit_id = $1) ORDER BY due_date, created_at LIMIT 200',
    [auditId ?? null],
  );
  return rows.map((r) => ({ ...r, estimated_cost: NUMERIC(r.estimated_cost) }));
}

export async function createFranchiseAction(
  db: Queryable,
  ctx: AuthContext,
  input: { auditId: string; actionText: string; ownerName?: string; dueDate?: string; estimatedCost?: number },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guestops.franchise_actions
       (tenant_id, audit_id, action_text, owner_name, due_date, estimated_cost)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, input.auditId, input.actionText, input.ownerName ?? null, input.dueDate ?? null, money(input.estimatedCost ?? 0)],
  );
  await auditAction(db, ctx, 'guestops.franchise_action_created', 'franchise_action', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function updateFranchiseAction(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'guestops.franchise_actions', id, ['open', 'in_progress'], status, 'Franchise action', 'FRANCHISE_ACTION_TRANSITION');
  if (status === 'completed') await db.query('UPDATE guestops.franchise_actions SET completed_at = now() WHERE id = $1', [id]);
  await auditAction(db, ctx, 'guestops.franchise_action_status', 'franchise_action', id, { after: { status } });
  return { id, status };
}
