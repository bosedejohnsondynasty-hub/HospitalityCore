import type { AuthContext } from '../auth.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';

/**
 * Maintenance & Engineering depth services.
 *
 * The module is deliberately more than a ticket log: it owns trades, locations
 * (with Guest Rooms as a first-class category sourced from the room master), a
 * configurable checklist engine with recurrence and duplicate protection, fault
 * intake from housekeeping, SLA resolution and an authorised verification step
 * that gates room readiness.
 */

const NUMERIC = (value: unknown): number => Number(value as string);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** `pg` returns DATE columns as JS dates at local midnight; normalise to YYYY-MM-DD. */
function toDay(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

type Trade = 'electrical' | 'plumbing' | 'hvac' | 'general' | 'other';
type Priority = 'low' | 'normal' | 'high' | 'urgent';
type FaultCategory = 'electrical' | 'plumbing' | 'hvac' | 'general' | 'safety';

const TRADE_FOR_CATEGORY: Record<FaultCategory, Trade> = {
  electrical: 'electrical',
  plumbing: 'plumbing',
  hvac: 'hvac',
  general: 'general',
  safety: 'general',
};

export async function listTeams(db: Queryable, hotelId: string) {
  const { rows } = await db.query(
    `SELECT id, team_code, team_name, trade, description, is_active
       FROM maintenance.teams
      WHERE hotel_id = $1
      ORDER BY trade, team_name`,
    [hotelId],
  );
  return { teams: rows };
}

export async function createTeam(
  db: Queryable,
  ctx: AuthContext,
  input: { hotelId: string; teamCode: string; teamName: string; trade?: Trade; description?: string },
) {
  const code = input.teamCode?.trim().toUpperCase();
  if (!code) throw badRequest('teamCode is required');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maintenance.teams (tenant_id, hotel_id, team_code, team_name, trade, description)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, hotel_id, team_code) DO UPDATE
       SET team_name = EXCLUDED.team_name,
           trade = EXCLUDED.trade,
           description = EXCLUDED.description
     RETURNING id`,
    [ctx.tenantId, input.hotelId, code, input.teamName, input.trade ?? 'general', input.description ?? null],
  );
  await auditAction(db, ctx, 'maintenance.team_saved', 'maintenance_team', rows[0]!.id, {
    after: { teamCode: code },
  });
  return { teamId: rows[0]!.id };
}

export async function listLocations(db: Queryable, hotelId: string) {
  const { rows } = await db.query(
    `SELECT 'location' AS source, id, location_code, location_name, category, floor_label, is_active
       FROM maintenance.locations
      WHERE hotel_id = $1
     UNION ALL
     SELECT 'room' AS source, room_id AS id, location_code, location_name, category, floor_label,
            NOT is_out_of_order AS is_active
       FROM maintenance.guest_room_locations
      WHERE hotel_id = $1
      ORDER BY category, location_code`,
    [hotelId],
  );
  return { locations: rows };
}

export async function createLocation(
  db: Queryable,
  ctx: AuthContext,
  input: {
    hotelId: string;
    locationCode: string;
    locationName: string;
    category: 'public_area' | 'food_beverage' | 'back_of_house' | 'plant' | 'external';
    floorLabel?: string;
    parentLocationId?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maintenance.locations
       (tenant_id, hotel_id, location_code, location_name, category, floor_label, parent_location_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [
      ctx.tenantId,
      input.hotelId,
      input.locationCode,
      input.locationName,
      input.category,
      input.floorLabel ?? null,
      input.parentLocationId ?? null,
    ],
  );
  await auditAction(db, ctx, 'maintenance.location_created', 'maintenance_location', rows[0]!.id, {
    after: { code: input.locationCode, category: input.category },
  });
  return { locationId: rows[0]!.id };
}

export interface ChecklistItemInput {
  itemCode: string;
  prompt: string;
  inputType?: 'pass_fail' | 'yes_no' | 'numeric' | 'text';
  unit?: string;
  isMandatory?: boolean;
  faultCategory?: FaultCategory;
  instructions?: string;
}

export async function createChecklistTemplate(
  db: Queryable,
  ctx: AuthContext,
  input: {
    hotelId: string;
    templateCode: string;
    templateName: string;
    department?: 'housekeeping' | 'maintenance';
    teamId?: string;
    locationCategory?: 'guest_room' | 'public_area' | 'food_beverage' | 'back_of_house' | 'plant' | 'external';
    roomTypeId?: string;
    roomId?: string;
    locationId?: string;
    frequency:
      | 'daily'
      | 'selected_days'
      | 'weekly'
      | 'every_n_weeks'
      | 'monthly'
      | 'quarterly'
      | 'annually'
      | 'one_off';
    daysOfWeek?: number[];
    intervalWeeks?: number;
    dueTime?: string;
    graceHours?: number;
    effectiveFrom?: string;
    effectiveTo?: string;
    requiresVerification?: boolean;
    items: ChecklistItemInput[];
  },
) {
  const items = input.items ?? [];
  if (!items.length) throw badRequest('A checklist template needs at least one item');
  const codes = new Set(items.map((item) => item.itemCode));
  if (codes.size !== items.length) throw badRequest('Checklist item codes must be unique');
  if (['selected_days', 'weekly', 'every_n_weeks'].includes(input.frequency)) {
    const days = input.daysOfWeek ?? [];
    if (!days.length) throw badRequest('daysOfWeek is required for this frequency');
    if (days.some((day) => !WEEKDAYS.includes(day))) throw badRequest('daysOfWeek must be 0-6');
  }
  if (input.frequency === 'every_n_weeks' && !(input.intervalWeeks && input.intervalWeeks > 0)) {
    throw badRequest('intervalWeeks is required for every_n_weeks');
  }

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM maintenance.checklist_templates WHERE hotel_id = $1 AND template_code = $2',
    [input.hotelId, input.templateCode],
  );
  let templateId = existing.rows[0]?.id;
  if (templateId) {
    // Editing an existing template bumps the version; completed instances keep
    // the answers and version they were executed with.
    await db.query(
      `UPDATE maintenance.checklist_templates
          SET template_name = $2, department = $3, team_id = $4, location_category = $5,
              room_type_id = $6, room_id = $7, location_id = $8, frequency = $9,
              days_of_week = $10, interval_weeks = $11, due_time = $12, grace_hours = $13,
              effective_from = $14, effective_to = $15, requires_verification = $16,
              is_active = true, version = version + 1
        WHERE id = $1`,
      [
        templateId,
        input.templateName,
        input.department ?? 'maintenance',
        input.teamId ?? null,
        input.locationCategory ?? null,
        input.roomTypeId ?? null,
        input.roomId ?? null,
        input.locationId ?? null,
        input.frequency,
        input.daysOfWeek ?? null,
        input.intervalWeeks ?? null,
        input.dueTime ?? '09:00',
        input.graceHours ?? 4,
        input.effectiveFrom ?? new Date().toISOString().slice(0, 10),
        input.effectiveTo ?? null,
        input.requiresVerification ?? false,
      ],
    );
    await db.query('DELETE FROM maintenance.checklist_template_items WHERE template_id = $1', [templateId]);
  } else {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO maintenance.checklist_templates
         (tenant_id, hotel_id, template_code, template_name, department, team_id, location_category,
          room_type_id, room_id, location_id, frequency, days_of_week, interval_weeks, due_time,
          grace_hours, effective_from, effective_to, requires_verification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        ctx.tenantId,
        input.hotelId,
        input.templateCode,
        input.templateName,
        input.department ?? 'maintenance',
        input.teamId ?? null,
        input.locationCategory ?? null,
        input.roomTypeId ?? null,
        input.roomId ?? null,
        input.locationId ?? null,
        input.frequency,
        input.daysOfWeek ?? null,
        input.intervalWeeks ?? null,
        input.dueTime ?? '09:00',
        input.graceHours ?? 4,
        input.effectiveFrom ?? new Date().toISOString().slice(0, 10),
        input.effectiveTo ?? null,
        input.requiresVerification ?? false,
      ],
    );
    templateId = inserted.rows[0]!.id;
  }

  let position = 0;
  for (const item of items) {
    await db.query(
      `INSERT INTO maintenance.checklist_template_items
         (tenant_id, template_id, position, item_code, prompt, input_type, unit, is_mandatory,
          fault_category, instructions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ctx.tenantId,
        templateId,
        position++,
        item.itemCode,
        item.prompt,
        item.inputType ?? 'pass_fail',
        item.unit ?? null,
        item.isMandatory ?? true,
        item.faultCategory ?? null,
        item.instructions ?? null,
      ],
    );
  }
  await auditAction(db, ctx, 'maintenance.checklist_template_saved', 'checklist_template', templateId, {
    after: { templateCode: input.templateCode, frequency: input.frequency, items: items.length },
  });
  return { templateId };
}

export async function listChecklistTemplates(db: Queryable, hotelId: string) {
  const { rows } = await db.query(
    `SELECT t.id, t.template_code, t.template_name, t.department, t.frequency, t.days_of_week,
            t.interval_weeks, t.due_time, t.location_category, t.requires_verification, t.is_active,
            t.version, tm.team_name, tm.trade,
            (SELECT count(*) FROM maintenance.checklist_template_items i WHERE i.template_id = t.id) AS item_count
       FROM maintenance.checklist_templates t
       LEFT JOIN maintenance.teams tm ON tm.id = t.team_id
      WHERE t.hotel_id = $1
      ORDER BY t.department, t.template_name`,
    [hotelId],
  );
  return { templates: rows };
}

export async function getChecklistTemplate(db: Queryable, templateId: string) {
  const header = await db.query(
    `SELECT id, template_code, template_name, department, frequency, days_of_week, interval_weeks,
            due_time, grace_hours, effective_from, effective_to, requires_verification, version, is_active
       FROM maintenance.checklist_templates WHERE id = $1`,
    [templateId],
  );
  if (!header.rows[0]) throw notFound('Checklist template not found');
  const items = await db.query(
    `SELECT id, item_code, position, prompt, input_type, unit, is_mandatory, fault_category, instructions
       FROM maintenance.checklist_template_items WHERE template_id = $1 ORDER BY position, item_code`,
    [templateId],
  );
  return { template: header.rows[0], items: items.rows };
}

function matchesFrequency(
  template: {
    frequency: string;
    days_of_week: number[] | null;
    interval_weeks: number | null;
    effective_from: string | Date;
  },
  date: Date,
): boolean {
  const weekday = date.getUTCDay();
  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  const effective = new Date(`${toDay(template.effective_from)}T00:00:00Z`);
  const days = template.days_of_week ?? [];
  switch (template.frequency) {
    case 'daily':
      return true;
    case 'selected_days':
    case 'weekly':
      return days.includes(weekday);
    case 'every_n_weeks': {
      if (!days.includes(weekday)) return false;
      const start = Date.UTC(effective.getUTCFullYear(), effective.getUTCMonth(), effective.getUTCDate());
      const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      const weeks = Math.floor((current - start) / (7 * 86_400_000));
      return weeks >= 0 && weeks % (template.interval_weeks ?? 1) === 0;
    }
    case 'monthly':
      return day === Math.min(effective.getUTCDate(), 28);
    case 'quarterly':
      return day === Math.min(effective.getUTCDate(), 28) && (month - effective.getUTCMonth() + 12) % 3 === 0;
    case 'annually':
      return day === effective.getUTCDate() && month === effective.getUTCMonth();
    case 'one_off':
      return (
        date.getUTCFullYear() === effective.getUTCFullYear() &&
        month === effective.getUTCMonth() &&
        day === effective.getUTCDate()
      );
    default:
      return false;
  }
}

/**
 * Generates the due checklist occurrences for one hotel and date.
 *
 * The unique (tenant, template, date, scope) key makes this safe to call
 * repeatedly: a retry or a second scheduler run cannot create duplicates.
 */
export async function generateChecklists(db: Queryable, ctx: AuthContext, hotelId: string, dateStr?: string) {
  const dateValue = dateStr ?? new Date().toISOString().slice(0, 10);
  const date = new Date(`${dateValue}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw badRequest('date must be an ISO date');

  const templates = await db.query<{
    id: string;
    version: number;
    frequency: string;
    days_of_week: number[] | null;
    interval_weeks: number | null;
    effective_from: string | Date;
    effective_to: string | Date | null;
    due_time: string;
    room_id: string | null;
    location_id: string | null;
    location_category: string | null;
    room_type_id: string | null;
    team_id: string | null;
  }>(
    `SELECT id, version, frequency, days_of_week, interval_weeks, effective_from, effective_to,
            due_time::text AS due_time, room_id, location_id, location_category, room_type_id, team_id
       FROM maintenance.checklist_templates
      WHERE hotel_id = $1 AND is_active
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [hotelId, dateValue],
  );

  let created = 0;
  const instanceIds: string[] = [];
  for (const template of templates.rows) {
    if (!matchesFrequency(template, date)) continue;

    const targets: Array<{ scopeKey: string; roomId: string | null; locationId: string | null }> = [];
    if (template.room_id) {
      targets.push({ scopeKey: `room:${template.room_id}`, roomId: template.room_id, locationId: null });
    } else if (template.location_id) {
      targets.push({ scopeKey: `location:${template.location_id}`, roomId: null, locationId: template.location_id });
    } else if (template.location_category === 'guest_room') {
      const rooms = await db.query<{ id: string }>(
        `SELECT id FROM hotel.rooms
          WHERE hotel_id = $1 AND ($2::uuid IS NULL OR room_type_id = $2)
          ORDER BY room_number`,
        [hotelId, template.room_type_id],
      );
      for (const room of rooms.rows) {
        targets.push({ scopeKey: `room:${room.id}`, roomId: room.id, locationId: null });
      }
    } else {
      targets.push({ scopeKey: 'hotel', roomId: null, locationId: null });
    }

    for (const target of targets) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO maintenance.checklist_instances
           (tenant_id, hotel_id, template_id, template_version, scope_key, room_id, location_id,
            scheduled_for, due_at, assigned_team_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date, ($8::date + $9::time) AT TIME ZONE 'UTC', $10)
         ON CONFLICT (tenant_id, template_id, scheduled_for, scope_key) DO NOTHING
         RETURNING id`,
        [
          ctx.tenantId,
          hotelId,
          template.id,
          template.version,
          target.scopeKey,
          target.roomId,
          target.locationId,
          dateValue,
          template.due_time,
          template.team_id,
        ],
      );
      if (rows[0]) {
        created += 1;
        instanceIds.push(rows[0].id);
      }
    }
  }

  // Anything still pending past its due time plus grace is overdue.
  await db.query(
    `UPDATE maintenance.checklist_instances
        SET status = 'missed'
      WHERE hotel_id = $1 AND status = 'pending'
        AND due_at + interval '4 hours' < now()`,
    [hotelId],
  );

  if (created) {
    await emitEvent(db, ctx.tenantId, 'maintenance.checklists_generated', 'checklist_schedule', hotelId, {
      hotelId,
      date: dateValue,
      created,
    });
  }
  return { date: dateValue, created, instanceIds };
}

export async function listChecklistInstances(db: Queryable, hotelId: string, status?: string) {
  const { rows } = await db.query(
    `SELECT ci.id, ci.scheduled_for, ci.due_at, ci.status, ci.scope_key, ci.template_version,
            t.template_name, t.department, t.requires_verification,
            r.room_number, tm.team_name
       FROM maintenance.checklist_instances ci
       JOIN maintenance.checklist_templates t ON t.id = ci.template_id
       LEFT JOIN hotel.rooms r ON r.id = ci.room_id
       LEFT JOIN maintenance.teams tm ON tm.id = ci.assigned_team_id
      WHERE ci.hotel_id = $1 AND ($2::text IS NULL OR ci.status = $2)
      ORDER BY ci.due_at DESC
      LIMIT 200`,
    [hotelId, status ?? null],
  );
  return { instances: rows };
}

export async function getChecklistInstance(db: Queryable, instanceId: string) {
  const header = await db.query(
    `SELECT ci.id, ci.hotel_id, ci.template_id, ci.template_version, ci.scheduled_for, ci.due_at,
            ci.status, ci.completed_at, ci.completion_note, t.template_name, t.department,
            t.requires_verification, r.room_number, l.location_name
       FROM maintenance.checklist_instances ci
       JOIN maintenance.checklist_templates t ON t.id = ci.template_id
       LEFT JOIN hotel.rooms r ON r.id = ci.room_id
       LEFT JOIN maintenance.locations l ON l.id = ci.location_id
      WHERE ci.id = $1`,
    [instanceId],
  );
  const instance = header.rows[0] as { template_id: string; template_version: number } | undefined;
  if (!instance) throw notFound('Checklist instance not found');

  const items = await db.query(
    `SELECT i.id, i.item_code, i.position, i.prompt, i.input_type, i.unit, i.is_mandatory,
            i.fault_category, i.instructions,
            res.result, res.numeric_value, res.remark, res.fault_request_id, res.recorded_at
       FROM maintenance.checklist_template_items i
       LEFT JOIN maintenance.checklist_results res
         ON res.template_item_id = i.id AND res.instance_id = $2
      WHERE i.template_id = $1
      ORDER BY i.position, i.item_code`,
    [instance.template_id, instanceId],
  );
  return { instance: header.rows[0], items: items.rows };
}

interface FaultInput {
  hotelId: string;
  roomId?: string;
  locationId?: string;
  category?: FaultCategory;
  priority?: Priority;
  description: string;
  source?: 'manual' | 'housekeeping' | 'front_office' | 'guest' | 'inspection' | 'preventive' | 'emergency';
  affectsRoomReadiness?: boolean;
  housekeepingTaskId?: string;
  assetId?: string;
}

async function insertFault(db: Queryable, ctx: AuthContext, input: FaultInput) {
  const hotel = await db.query<{ branch_id: string }>(
    'SELECT branch_id FROM hotel.hotels WHERE id = $1',
    [input.hotelId],
  );
  const branchId = hotel.rows[0]?.branch_id;
  if (!branchId) throw notFound('Hotel not found');

  const category: FaultCategory = input.category ?? 'general';
  const trade = TRADE_FOR_CATEGORY[category];
  const priority: Priority =
    category === 'safety' || input.source === 'emergency' ? 'urgent' : (input.priority ?? 'normal');

  const team = await db.query<{ id: string }>(
    `SELECT id FROM maintenance.teams
      WHERE hotel_id = $1 AND trade = $2 AND is_active
      ORDER BY team_code LIMIT 1`,
    [input.hotelId, trade],
  );

  const sla = await db.query<{ resolve_hours: number }>(
    `SELECT resolve_hours FROM maintenance.sla_policies
      WHERE tenant_id = $1 AND priority = $2 AND (hotel_id = $3 OR hotel_id IS NULL)
      ORDER BY hotel_id NULLS LAST LIMIT 1`,
    [ctx.tenantId, priority, input.hotelId],
  );
  const resolveHours = sla.rows[0]?.resolve_hours ?? 24;

  const { rows } = await db.query<{ id: string; created_at: string }>(
    `INSERT INTO maintenance.requests
       (tenant_id, branch_id, room_id, asset_id, location_id, team_id, category, source, severity,
        affects_room_readiness, description, priority, requested_by, sla_due_at, housekeeping_task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + ($14 || ' hours')::interval, $15)
     RETURNING id, created_at`,
    [
      ctx.tenantId,
      branchId,
      input.roomId ?? null,
      input.assetId ?? null,
      input.locationId ?? null,
      team.rows[0]?.id ?? null,
      category,
      input.source ?? 'manual',
      category === 'safety' ? 'safety' : null,
      input.affectsRoomReadiness ?? false,
      input.description,
      priority,
      ctx.userId,
      String(resolveHours),
      input.housekeepingTaskId ?? null,
    ],
  );
  const requestId = rows[0]!.id;

  await emitEvent(db, ctx.tenantId, 'maintenance.fault_reported', 'maintenance_request', requestId, {
    hotelId: input.hotelId,
    roomId: input.roomId ?? null,
    category,
    priority,
    trade,
    affectsRoomReadiness: input.affectsRoomReadiness ?? false,
  });
  await auditAction(db, ctx, 'maintenance.fault_reported', 'maintenance_request', requestId, {
    after: { category, priority, source: input.source ?? 'manual' },
    branchId,
  });
  return { requestId, priority, category, teamId: team.rows[0]?.id ?? null, slaDueHours: resolveHours };
}

export async function reportFault(db: Queryable, ctx: AuthContext, input: FaultInput) {
  if (!input.description?.trim()) throw badRequest('A fault description is required');
  return insertFault(db, ctx, input);
}

export async function rejectRequest(db: Queryable, ctx: AuthContext, requestId: string, reason: string) {
  const trimmed = reason?.trim();
  if (!trimmed) throw badRequest('A rejection reason is required');
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM maintenance.requests WHERE id = $1 FOR UPDATE',
    [requestId],
  );
  const row = rows[0];
  if (!row) throw notFound('Maintenance request not found');
  if (row.status !== 'open' && row.status !== 'approved') {
    throw conflict('REQUEST_NOT_REJECTABLE', `A ${row.status} request cannot be rejected`);
  }
  await db.query(
    "UPDATE maintenance.requests SET status = 'rejected', rejection_reason = $2 WHERE id = $1",
    [requestId, trimmed],
  );
  await auditAction(db, ctx, 'maintenance.request_rejected', 'maintenance_request', requestId, {
    after: { reason: trimmed },
  });
  return { requestId, status: 'rejected', reason: trimmed };
}

export async function completeChecklistInstance(
  db: Queryable,
  ctx: AuthContext,
  instanceId: string,
  input: {
    results: Array<{
      itemId: string;
      result: 'pass' | 'fail' | 'na' | 'unable';
      numericValue?: number;
      remark?: string;
    }>;
    note?: string;
  },
) {
  const header = await db.query<{
    id: string;
    hotel_id: string;
    template_id: string;
    status: string;
    room_id: string | null;
    location_id: string | null;
    location_category: string | null;
    requires_verification: boolean;
  }>(
    `SELECT ci.id, ci.hotel_id, ci.template_id, ci.status, ci.room_id, ci.location_id,
            t.location_category, t.requires_verification
       FROM maintenance.checklist_instances ci
       JOIN maintenance.checklist_templates t ON t.id = ci.template_id
      WHERE ci.id = $1 FOR UPDATE OF ci`,
    [instanceId],
  );
  const instance = header.rows[0];
  if (!instance) throw notFound('Checklist instance not found');
  if (instance.status === 'completed') throw conflict('CHECKLIST_ALREADY_COMPLETED', 'Checklist already completed');
  if (instance.status === 'missed' || instance.status === 'skipped') {
    throw conflict('CHECKLIST_NOT_EXECUTABLE', `Checklist is ${instance.status}`);
  }

  const items = await db.query<{
    id: string;
    item_code: string;
    prompt: string;
    input_type: string;
    is_mandatory: boolean;
    fault_category: FaultCategory | null;
  }>(
    `SELECT id, item_code, prompt, input_type, is_mandatory, fault_category
       FROM maintenance.checklist_template_items WHERE template_id = $1`,
    [instance.template_id],
  );
  const byId = new Map(items.rows.map((item) => [item.id, item]));
  const answered = new Map(input.results.map((entry) => [entry.itemId, entry]));

  for (const item of items.rows) {
    const entry = answered.get(item.id);
    if (!entry) {
      if (item.is_mandatory) throw badRequest(`Item ${item.item_code} is mandatory and has no result`);
      continue;
    }
    if (!['pass', 'fail', 'na', 'unable'].includes(entry.result)) {
      throw badRequest(`Invalid result for ${item.item_code}`);
    }
    if ((entry.result === 'na' || entry.result === 'unable') && !entry.remark?.trim()) {
      throw badRequest(`Item ${item.item_code} needs a reason for result ${entry.result}`);
    }
    if (item.input_type === 'numeric' && entry.result !== 'na' && entry.result !== 'unable') {
      if (entry.numericValue === undefined) throw badRequest(`Item ${item.item_code} needs a numeric value`);
    }
  }
  for (const entry of input.results) {
    if (!byId.has(entry.itemId)) throw badRequest('Result refers to an item outside this checklist template');
  }

  let faults = 0;
  for (const entry of input.results) {
    const item = byId.get(entry.itemId)!;
    let faultRequestId: string | null = null;
    if (entry.result === 'fail') {
      const fault = await insertFault(db, ctx, {
        hotelId: instance.hotel_id,
        roomId: instance.room_id ?? undefined,
        locationId: instance.location_id ?? undefined,
        category: item.fault_category ?? 'general',
        priority: 'normal',
        description: `${item.prompt}: ${entry.remark?.trim() || 'failed inspection'}`,
        source: 'inspection',
        affectsRoomReadiness: !!instance.room_id && instance.location_category === 'guest_room',
      });
      faultRequestId = fault.requestId;
      faults += 1;
    }
    await db.query(
      `INSERT INTO maintenance.checklist_results
         (tenant_id, instance_id, template_item_id, result, numeric_value, remark, fault_request_id, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, instance_id, template_item_id) DO UPDATE
         SET result = EXCLUDED.result,
             numeric_value = EXCLUDED.numeric_value,
             remark = EXCLUDED.remark,
             fault_request_id = EXCLUDED.fault_request_id,
             recorded_by = EXCLUDED.recorded_by`,
      [
        ctx.tenantId,
        instanceId,
        item.id,
        entry.result,
        entry.numericValue ?? null,
        entry.remark ?? null,
        faultRequestId,
        ctx.userId,
      ],
    );
  }

  await db.query(
    `UPDATE maintenance.checklist_instances
        SET status = 'completed', completed_at = now(), completed_by = $2, completion_note = $3
      WHERE id = $1`,
    [instanceId, ctx.userId, input.note ?? null],
  );
  await emitEvent(db, ctx.tenantId, 'maintenance.checklist_completed', 'checklist_instance', instanceId, {
    hotelId: instance.hotel_id,
    roomId: instance.room_id,
    faults,
  });
  await auditAction(db, ctx, 'maintenance.checklist_completed', 'checklist_instance', instanceId, {
    after: { results: input.results.length, faults },
  });
  return { instanceId, status: 'completed', faults };
}

const WORK_ORDER_TRANSITIONS: Record<string, string[]> = {
  created: ['assigned', 'in_progress', 'cancelled'],
  assigned: ['in_progress', 'on_hold', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  completed: ['verified', 'in_progress'],
  verified: [],
  cancelled: [],
};

/**
 * Moves a work order through its state machine.
 *
 * Verification is a separate, four-eyes step: the person who marked the job
 * complete cannot also sign it off, and reopening requires a reason.
 */
export async function transitionWorkOrder(
  db: Queryable,
  ctx: AuthContext,
  workOrderId: string,
  status: string,
  reason?: string,
) {
  const { rows } = await db.query<{
    id: string;
    status: string;
    completed_by: string | null;
    verification_required: boolean;
    affects_room_readiness: boolean;
    work_order_number: string;
  }>(
    `SELECT id, status, completed_by, verification_required, affects_room_readiness, work_order_number
       FROM maintenance.work_orders WHERE id = $1 FOR UPDATE`,
    [workOrderId],
  );
  const order = rows[0];
  if (!order) throw notFound('Work order not found');
  const allowed = WORK_ORDER_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(status)) {
    throw conflict(
      'WORK_ORDER_TRANSITION',
      `Work order cannot move from ${order.status} to ${status} (allowed: ${allowed.join(', ') || 'none'})`,
    );
  }
  const reopening = order.status === 'completed' && status === 'in_progress';
  if ((status === 'cancelled' || status === 'on_hold' || reopening) && !reason?.trim()) {
    throw badRequest(`A reason is required to move a work order to ${status}`);
  }
  if (status === 'verified') {
    if (!order.verification_required) {
      throw conflict('VERIFICATION_NOT_REQUIRED', 'This work order does not require verification');
    }
    if (order.completed_by && order.completed_by === ctx.userId) {
      throw forbidden('Verification must be performed by a different user');
    }
  }

  if (status === 'in_progress') {
    await db.query(
      `UPDATE maintenance.work_orders
          SET status = $2,
              started_at = coalesce(started_at, now()),
              completed_at = NULL,
              completed_by = NULL,
              verified_at = NULL,
              verified_by = NULL,
              status_reason = $3,
              reopened_count = reopened_count + CASE WHEN $4 THEN 1 ELSE 0 END
        WHERE id = $1`,
      [workOrderId, status, reason ?? null, reopening],
    );
  } else if (status === 'completed') {
    await db.query(
      `UPDATE maintenance.work_orders
          SET status = 'completed', completed_at = now(), completed_by = $2, status_reason = $3
        WHERE id = $1`,
      [workOrderId, ctx.userId, reason ?? null],
    );
  } else if (status === 'verified') {
    await db.query(
      `UPDATE maintenance.work_orders
          SET status = 'verified', verified_at = now(), verified_by = $2, verified_note = $3
        WHERE id = $1`,
      [workOrderId, ctx.userId, reason ?? null],
    );
  } else {
    await db.query(
      `UPDATE maintenance.work_orders SET status = $2, status_reason = $3 WHERE id = $1`,
      [workOrderId, status, reason ?? null],
    );
  }

  await emitEvent(db, ctx.tenantId, `maintenance.work_order_${status}`, 'work_order', workOrderId, {
    from: order.status,
    to: status,
    reason: reason ?? null,
  });
  await auditAction(db, ctx, `maintenance.work_order_${status}`, 'work_order', workOrderId, {
    before: { status: order.status },
    after: { status, reason: reason ?? null },
  });
  return { workOrderId, workOrderNumber: order.work_order_number, status };
}

/**
 * Returns the blocking maintenance record for a room, if any.
 *
 * A room cannot be marked ready while a room-affecting job is open, or while a
 * completed job still awaits the required verification.
 */
export async function roomMaintenanceHold(db: Queryable, roomId: string) {
  const { rows } = await db.query<{
    id: string;
    work_order_number: string;
    status: string;
    verification_required: boolean;
    verified_at: string | null;
  }>(
    `SELECT id, work_order_number, status, verification_required, verified_at
       FROM maintenance.work_orders
      WHERE room_id = $1
        AND affects_room_readiness
        AND (
          status IN ('created', 'assigned', 'in_progress', 'on_hold')
          OR (status = 'completed' AND verification_required AND verified_at IS NULL)
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [roomId],
  );
  return rows[0] ?? null;
}

export async function roomHistory(db: Queryable, roomId: string) {
  const faults = await db.query(
    `SELECT id, description, category, priority, status, source, created_at, sla_due_at
       FROM maintenance.requests WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [roomId],
  );
  const workOrders = await db.query(
    `SELECT id, work_order_number, description, status, priority, team_id, created_at, completed_at,
            verified_at, reopened_count
       FROM maintenance.work_orders WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [roomId],
  );
  const inspections = await db.query(
    `SELECT i.id, i.result, i.score, i.inspected_at
       FROM housekeeping.inspections i WHERE i.room_id = $1 ORDER BY i.inspected_at DESC LIMIT 50`,
    [roomId],
  );
  const checklists = await db.query(
    `SELECT ci.id, ci.scheduled_for, ci.status, t.template_name
       FROM maintenance.checklist_instances ci
       JOIN maintenance.checklist_templates t ON t.id = ci.template_id
      WHERE ci.room_id = $1 ORDER BY ci.scheduled_for DESC LIMIT 50`,
    [roomId],
  );
  return {
    roomId,
    faults: faults.rows,
    workOrders: workOrders.rows,
    inspections: inspections.rows,
    checklists: checklists.rows,
  };
}

export async function listSlaPolicies(db: Queryable, hotelId: string) {
  const { rows } = await db.query(
    `SELECT priority, acknowledge_hours, resolve_hours
       FROM maintenance.sla_policies
      WHERE hotel_id = $1 OR hotel_id IS NULL
      ORDER BY priority, hotel_id NULLS FIRST`,
    [hotelId],
  );
  // Defaults are read first, then hotel-specific rows overwrite them.
  const chosen = new Map<string, unknown>();
  for (const row of rows as Array<{ priority: string }>) chosen.set(row.priority, row);
  return { policies: [...chosen.values()] };
}

export async function setSlaPolicy(
  db: Queryable,
  ctx: AuthContext,
  input: { hotelId: string; priority: Priority; acknowledgeHours: number; resolveHours: number },
) {
  if (input.acknowledgeHours <= 0 || input.resolveHours < input.acknowledgeHours) {
    throw badRequest('acknowledgeHours must be positive and resolveHours must be at least acknowledgeHours');
  }
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM maintenance.sla_policies WHERE tenant_id = $1 AND hotel_id = $2 AND priority = $3',
    [ctx.tenantId, input.hotelId, input.priority],
  );
  if (existing.rows[0]) {
    await db.query(
      'UPDATE maintenance.sla_policies SET acknowledge_hours = $2, resolve_hours = $3 WHERE id = $1',
      [existing.rows[0].id, input.acknowledgeHours, input.resolveHours],
    );
  } else {
    await db.query(
      `INSERT INTO maintenance.sla_policies (tenant_id, hotel_id, priority, acknowledge_hours, resolve_hours)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.tenantId, input.hotelId, input.priority, input.acknowledgeHours, input.resolveHours],
    );
  }
  await auditAction(db, ctx, 'maintenance.sla_policy_saved', 'maintenance_sla', input.hotelId, {
    after: input,
  });
  return input;
}
