import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction } from '../audit.js';
import { nightAudit } from './hotel.js';
import { deductIngredients } from './restaurant.js';

/**
 * Operational reporting.
 *
 * Every figure is aggregated from posted transactions; nothing is synthetic.
 */
export async function dashboard(db: Queryable, hotelId?: string) {
  const arrivals = await db.query<{ count: string }>(
    `SELECT count(*) FROM hotel.reservations
      WHERE ($1::uuid IS NULL OR hotel_id = $1) AND arrival_date = current_date
        AND status IN ('confirmed','held')`,
    [hotelId ?? null],
  );
  const inHouse = await db.query<{ count: string }>(
    `SELECT count(*) FROM hotel.stays WHERE ($1::uuid IS NULL OR hotel_id = $1) AND status = 'in_house'`,
    [hotelId ?? null],
  );
  const rooms = await db.query<{ total: string; occupied: string; dirty: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE occupancy_status = 'occupied') AS occupied,
            count(*) FILTER (WHERE housekeeping_status = 'dirty') AS dirty
       FROM hotel.rooms WHERE ($1::uuid IS NULL OR hotel_id = $1)`,
    [hotelId ?? null],
  );
  const openOrders = await db.query<{ count: string; value: string }>(
    `SELECT count(*) AS count, coalesce(sum(total_amount),0) AS value FROM restaurant.orders
      WHERE status NOT IN ('completed','cancelled')`,
  );
  const revenue = await db.query<{ source: string; amount: string }>(
    `SELECT e.source_type AS source, sum(l.credit - l.debit) AS amount
       FROM finance.journal_entries e
       JOIN finance.journal_lines l ON l.entry_id = e.id
       JOIN finance.accounts a ON a.id = l.account_id
      WHERE e.status = 'posted' AND a.account_class = 'revenue' AND e.entry_date = current_date
      GROUP BY e.source_type`,
  );
  const trial = await db.query<{ debit: string; credit: string }>(
    `SELECT coalesce(sum(total_debit),0) AS debit, coalesce(sum(total_credit),0) AS credit
       FROM finance.trial_balance`,
  );

  return {
    arrivalsToday: Number(arrivals.rows[0]!.count),
    inHouse: Number(inHouse.rows[0]!.count),
    rooms: {
      total: Number(rooms.rows[0]!.total),
      occupied: Number(rooms.rows[0]!.occupied),
      dirty: Number(rooms.rows[0]!.dirty),
      occupancyRate:
        Number(rooms.rows[0]!.total) > 0
          ? Number(rooms.rows[0]!.occupied) / Number(rooms.rows[0]!.total)
          : 0,
    },
    openRestaurantOrders: Number(openOrders.rows[0]!.count),
    openRestaurantValue: Number(openOrders.rows[0]!.value),
    revenueToday: revenue.rows.map((r) => ({
      source: r.source ?? 'other',
      amount: Number(r.amount),
    })),
    ledger: {
      totalDebit: Number(trial.rows[0]!.debit),
      totalCredit: Number(trial.rows[0]!.credit),
      balanced: Number(trial.rows[0]!.debit) === Number(trial.rows[0]!.credit),
    },
  };
}

export async function dailySales(db: Queryable, from: string, to: string) {
  const restaurant = await db.query(
    `SELECT date_trunc('day', o.placed_at)::date AS business_date, ol.outlet_name,
            count(*) AS orders, sum(o.subtotal) AS net_sales, sum(o.tax_total) AS tax,
            sum(o.service_charge_total) AS service_charge, sum(o.total_amount) AS total
       FROM restaurant.orders o
       JOIN restaurant.outlets ol ON ol.id = o.outlet_id
      WHERE o.payment_status = 'paid' AND o.placed_at::date BETWEEN $1 AND $2
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
    [from, to],
  );
  const bar = await db.query(
    `SELECT date_trunc('day', o.opened_at)::date AS business_date, b.bar_name,
            count(*) AS orders, sum(o.subtotal) AS net_sales, sum(o.tax_total) AS tax,
            sum(o.service_charge_total) AS service_charge, sum(o.total_amount) AS total
       FROM bar.orders o
       JOIN bar.outlets b ON b.id = o.bar_id
      WHERE o.payment_status = 'paid' AND o.opened_at::date BETWEEN $1 AND $2
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
    [from, to],
  );
  return {
    restaurant: restaurant.rows.map(numericise),
    bar: bar.rows.map(numericise),
  };
}

export async function occupancyReport(db: Queryable, hotelId: string, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT d.business_date,
            (SELECT count(*) FROM hotel.rooms r WHERE r.hotel_id = $1 AND NOT r.is_out_of_order) AS rooms_available,
            (SELECT count(*) FROM hotel.stays s
              WHERE s.hotel_id = $1 AND s.status = 'in_house'
                AND s.check_in_at::date <= d.business_date
                AND (s.check_out_at IS NULL OR s.check_out_at::date >= d.business_date)) AS rooms_occupied
       FROM hotel.business_dates d
      WHERE d.hotel_id = $1 AND d.business_date BETWEEN $2 AND $3
      ORDER BY d.business_date`,
    [hotelId, from, to],
  );
  return rows.map((r) => ({
    business_date: r.business_date,
    rooms_available: Number(r.rooms_available),
    rooms_occupied: Number(r.rooms_occupied),
    occupancy_rate:
      Number(r.rooms_available) > 0 ? Number(r.rooms_occupied) / Number(r.rooms_available) : 0,
  }));
}

export async function revenueBySource(db: Queryable, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT e.entry_date, coalesce(e.source_type, 'manual') AS source,
            sum(l.credit - l.debit) AS amount
       FROM finance.journal_entries e
       JOIN finance.journal_lines l ON l.entry_id = e.id
       JOIN finance.accounts a ON a.id = l.account_id
      WHERE e.status = 'posted' AND a.account_class = 'revenue'
        AND e.entry_date BETWEEN $1 AND $2
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
    [from, to],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

function numericise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['net_sales', 'tax', 'service_charge', 'total', 'orders']) {
    if (out[key] !== null && out[key] !== undefined) out[key] = Number(out[key] as string);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Offline mobile synchronisation
// ---------------------------------------------------------------------------
export async function registerDevice(
  db: Queryable,
  ctx: AuthContext,
  input: { deviceId: string; platform: string; appVersion?: string; pushToken?: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO mobile.devices (tenant_id, user_id, device_id, platform, app_version, push_token)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, device_id) DO UPDATE
       SET last_seen_at = now(), app_version = EXCLUDED.app_version, push_token = EXCLUDED.push_token
     RETURNING id`,
    [ctx.tenantId, ctx.userId, input.deviceId, input.platform, input.appVersion ?? null, input.pushToken ?? null],
  );
  return rows[0]!;
}

/**
 * Handles an offline command exactly once.
 *
 * The command id is the idempotency key: replays return the stored result and do
 * not re-apply the effect. Conflicts are recorded rather than silently overwritten.
 */
export async function submitSyncCommand(
  db: Queryable,
  ctx: AuthContext,
  input: { deviceId: string; commandId: string; commandType: string; payload: Record<string, unknown> },
) {
  if (!input.commandId) throw badRequest('commandId is required');
  const device = await registerDevice(db, ctx, {
    deviceId: input.deviceId,
    platform: 'pwa',
    appVersion: String(input.payload.appVersion ?? 'web'),
  });

  const existing = await db.query<{ id: string; status: string; result: unknown; conflict_reason: string | null }>(
    'SELECT id, status, result, conflict_reason FROM mobile.sync_commands WHERE command_id = $1',
    [input.commandId],
  );
  if (existing.rows[0]) {
    return {
      commandId: input.commandId,
      status: 'duplicate',
      applied: false,
      result: existing.rows[0].result,
      conflictReason: existing.rows[0].conflict_reason,
    };
  }

  try {
    let result: Record<string, unknown> = {};
    if (input.commandType === 'housekeeping.task.complete') {
      const taskId = String(input.payload.taskId ?? '');
      const task = await db.query<{ id: string; status: string; hotel_id: string }>(
        'SELECT id, status, hotel_id FROM housekeeping.tasks WHERE id = $1',
        [taskId],
      );
      const row = task.rows[0];
      if (!row) throw notFound('Task not found');
      if (row.status === 'completed' || row.status === 'inspected') {
        await db.query(
          `INSERT INTO mobile.sync_commands
             (tenant_id, device_id, user_id, command_id, command_type, payload, status, conflict_reason, result)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,'conflict',$7,$8::jsonb)`,
          [
            ctx.tenantId,
            device.id,
            ctx.userId,
            input.commandId,
            input.commandType,
            JSON.stringify(input.payload),
            'Task was already completed on the server',
            JSON.stringify({ taskId, serverStatus: row.status }),
          ],
        );
        const conflict = await db.query<{ id: string }>(
          'SELECT id FROM mobile.sync_commands WHERE command_id = $1',
          [input.commandId],
        );
        await db.query(
          `INSERT INTO mobile.sync_conflicts
             (tenant_id, sync_command_id, entity_type, entity_id, server_state, client_state, resolution)
           VALUES ($1,$2,'housekeeping_task',$3,$4::jsonb,$5::jsonb,'pending')`,
          [
            ctx.tenantId,
            conflict.rows[0]!.id,
            taskId,
            JSON.stringify({ status: row.status }),
            JSON.stringify(input.payload),
          ],
        );
        return {
          commandId: input.commandId,
          status: 'conflict',
          applied: false,
          result: { taskId, serverStatus: row.status },
          conflictReason: 'Task was already completed on the server',
        };
      }
      await db.query(
        `UPDATE housekeeping.tasks
            SET status = 'completed', completed_at = now(), notes = coalesce($2, notes)
          WHERE id = $1`,
        [taskId, (input.payload.notes as string | undefined) ?? null],
      );
      const checklist = Array.isArray(input.payload.checklist) ? input.payload.checklist : [];
      for (const entry of checklist as Array<{ itemId?: string; done?: boolean }>) {
        if (!entry.itemId) continue;
        await db.query(
          `INSERT INTO housekeeping.task_checklist_results
             (tenant_id, task_id, template_item_id, is_done, recorded_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, task_id, template_item_id) DO UPDATE SET is_done = EXCLUDED.is_done`,
          [ctx.tenantId, taskId, entry.itemId, entry.done ?? true, ctx.userId],
        );
      }
      await db.query(
        "UPDATE hotel.rooms SET housekeeping_status = 'clean' WHERE id = (SELECT room_id FROM housekeeping.tasks WHERE id = $1)",
        [taskId],
      );
      result = { taskId, status: 'completed', checklistApplied: checklist.length };
      await auditAction(db, ctx, 'sync.housekeeping_completed', 'housekeeping_task', taskId, {
        metadata: { commandId: input.commandId, source: 'offline' },
      });
    } else if (input.commandType === 'maintenance.request.create') {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO maintenance.requests (tenant_id, branch_id, room_id, description, priority, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          ctx.tenantId,
          String(input.payload.branchId ?? ''),
          (input.payload.roomId as string | undefined) ?? null,
          String(input.payload.description ?? 'Maintenance request from mobile'),
          String(input.payload.priority ?? 'normal'),
          ctx.userId,
        ],
      );
      result = { requestId: rows[0]!.id };
      await auditAction(db, ctx, 'sync.maintenance_requested', 'maintenance_request', rows[0]!.id, {
        metadata: { commandId: input.commandId, source: 'offline' },
      });
    } else {
      throw badRequest(`Unsupported sync command type: ${input.commandType}`);
    }

    await db.query(
      `INSERT INTO mobile.sync_commands
         (tenant_id, device_id, user_id, command_id, command_type, payload, status, result, applied_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'applied',$7::jsonb, now())`,
      [
        ctx.tenantId,
        device.id,
        ctx.userId,
        input.commandId,
        input.commandType,
        JSON.stringify(input.payload),
        JSON.stringify(result),
      ],
    );
    return { commandId: input.commandId, status: 'applied', applied: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync command failed';
    await db.query(
      `INSERT INTO mobile.sync_commands
         (tenant_id, device_id, user_id, command_id, command_type, payload, status, conflict_reason)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'rejected',$7)
       ON CONFLICT (tenant_id, command_id) DO NOTHING`,
      [
        ctx.tenantId,
        device.id,
        ctx.userId,
        input.commandId,
        input.commandType,
        JSON.stringify(input.payload),
        message,
      ],
    );
    throw err;
  }
}

export async function listSyncConflicts(db: Queryable) {
  const { rows } = await db.query(
    `SELECT c.id, c.entity_type, c.entity_id, c.resolution, c.created_at, sc.command_type
       FROM mobile.sync_conflicts c
       JOIN mobile.sync_commands sc ON sc.id = c.sync_command_id
      ORDER BY c.created_at DESC LIMIT 100`,
  );
  return rows;
}

export async function resolveSyncConflict(
  db: Queryable,
  ctx: AuthContext,
  input: { conflictId: string; resolution: 'client_wins' | 'server_wins' | 'merged' | 'discarded'; note?: string },
) {
  const existing = await db.query<{ id: string; resolution: string }>(
    'SELECT id, resolution FROM mobile.sync_conflicts WHERE id = $1',
    [input.conflictId],
  );
  if (!existing.rows[0]) throw notFound('Conflict not found');
  if (existing.rows[0].resolution !== 'pending') {
    throw conflict('CONFLICT_ALREADY_RESOLVED', 'Conflict already resolved');
  }
  await db.query(
    'UPDATE mobile.sync_conflicts SET resolution = $2, resolved_by = $3, resolved_at = now(), note = $4 WHERE id = $1',
    [input.conflictId, input.resolution, ctx.userId, input.note ?? null],
  );
  await auditAction(db, ctx, 'sync.conflict_resolved', 'sync_conflict', input.conflictId, {
    after: { resolution: input.resolution },
  });
  return { conflictId: input.conflictId, resolution: input.resolution };
}

export { nightAudit, deductIngredients };
