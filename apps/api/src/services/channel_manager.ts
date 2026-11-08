import type { AuthContext } from '../auth.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';
import { GL, money } from './finance.js';

const NUMERIC = (value: unknown): number => Number(value as string);

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderRecord {
  id: string;
  providerCode: string;
  providerName: string;
  apiEndpoint: string;
  authType: string;
  isActive: boolean;
  defaultCommissionPercent: number;
  defaultCurrency: string;
  timeoutMs: number;
  retryPolicy: Record<string, unknown>;
}

export interface ProviderInput {
  providerCode: string;
  providerName: string;
  apiEndpoint: string;
  authType?: string;
  authConfig?: Record<string, unknown>;
  isActive?: boolean;
  defaultCommissionPercent?: number;
  defaultCurrency?: string;
  timeoutMs?: number;
  retryPolicy?: Record<string, unknown>;
}

export async function listProviders(db: Queryable, ctx: AuthContext) {
  const { rows } = await db.query<ProviderRecord>(
    `SELECT id, provider_code AS providerCode, provider_name AS providerName,
            api_endpoint AS apiEndpoint, auth_type AS authType, is_active AS isActive,
            default_commission_percent AS defaultCommissionPercent, default_currency AS defaultCurrency,
            timeout_ms AS timeoutMs, retry_policy AS retryPolicy
       FROM channel.providers WHERE tenant_id = $1 ORDER BY provider_name`,
    [ctx.tenantId],
  );
  return { providers: rows };
}

export async function getProvider(db: Queryable, id: string) {
  const { rows } = await db.query<ProviderRecord>(
    `SELECT id, provider_code AS providerCode, provider_name AS providerName,
            api_endpoint AS apiEndpoint, auth_type AS authType, is_active AS isActive,
            default_commission_percent AS defaultCommissionPercent, default_currency AS defaultCurrency,
            timeout_ms AS timeoutMs, retry_policy AS retryPolicy
       FROM channel.providers WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Channel provider not found');
  return rows[0];
}

export async function createProvider(db: Queryable, ctx: AuthContext, input: ProviderInput) {
  const code = input.providerCode?.trim().toLowerCase();
  if (!code) throw badRequest('providerCode is required');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.providers
       (tenant_id, provider_code, provider_name, api_endpoint, auth_type, auth_config,
        is_active, default_commission_percent, default_currency, timeout_ms, retry_policy)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb)
     RETURNING id`,
    [
      ctx.tenantId, code, input.providerName, input.apiEndpoint, input.authType ?? 'api_key',
      JSON.stringify(input.authConfig ?? {}), input.isActive ?? true,
      money(input.defaultCommissionPercent ?? 15), input.defaultCurrency ?? 'USD',
      input.timeoutMs ?? 30000, JSON.stringify(input.retryPolicy ?? { max_retries: 3, backoff_ms: 1000 }),
    ],
  );
  const providerId = rows[0]!.id;
  await auditAction(db, ctx, 'channel.provider_created', 'channel_provider', providerId, { after: { providerCode: code } });
  return { providerId, providerCode: code };
}

export async function updateProvider(db: Queryable, ctx: AuthContext, id: string, input: Partial<ProviderInput>) {
  const existing = await db.query<{ id: string; provider_code: string }>(
    'SELECT id, provider_code FROM channel.providers WHERE id = $1',
    [id],
  );
  if (!existing.rows[0]) throw notFound('Channel provider not found');
  const merged: ProviderInput = {
    providerCode: input.providerCode ?? existing.rows[0].provider_code,
    providerName: input.providerName ?? 'Provider',
    apiEndpoint: input.apiEndpoint ?? '',
  };
  const { rows } = await db.query<{ id: string }>(
    `UPDATE channel.providers
        SET provider_name = $2, api_endpoint = $3, auth_type = $4, auth_config = $5::jsonb,
            is_active = $6, default_commission_percent = $7, default_currency = $8, timeout_ms = $9,
            retry_policy = $10::jsonb
      WHERE id = $1
      RETURNING id`,
    [
      id, merged.providerName, merged.apiEndpoint, input.authType ?? 'api_key', JSON.stringify(input.authConfig ?? {}),
      input.isActive ?? true, money(input.defaultCommissionPercent ?? 15), input.defaultCurrency ?? 'USD',
      input.timeoutMs ?? 30000, JSON.stringify(input.retryPolicy ?? { max_retries: 3, backoff_ms: 1000 }),
    ],
  );
  await auditAction(db, ctx, 'channel.provider_updated', 'channel_provider', id, { after: merged });
  return { providerId: id };
}

export async function deactivateProvider(db: Queryable, ctx: AuthContext, id: string) {
  const { rows } = await db.query<{ id: string }>(
    'UPDATE channel.providers SET is_active = false WHERE id = $1 RETURNING id',
    [id],
  );
  if (!rows[0]) throw notFound('Channel provider not found');
  await auditAction(db, ctx, 'channel.provider_deactivated', 'channel_provider', id, { after: { isActive: false } });
  return { providerId: id };
}

// ---------------------------------------------------------------------------
// Channel mappings
// ---------------------------------------------------------------------------

export interface MappingInput {
  providerId: string;
  hotelId: string;
  roomTypeId: string;
  providerRoomCode: string;
  providerRatePlanCode?: string;
  isActive?: boolean;
  overrides?: Record<string, unknown>;
}

export async function listChannelMappings(db: Queryable, ctx: AuthContext, hotelId?: string, roomTypeId?: string) {
  const { rows } = await db.query(
    `SELECT cm.id, cm.provider_id AS providerId, cm.hotel_id AS hotelId, cm.room_type_id AS roomTypeId,
            cm.provider_room_code AS providerRoomCode, cm.provider_rate_plan_code AS providerRatePlanCode,
            cm.is_active AS isActive, cm.overrides, p.provider_code AS providerCode
       FROM channel.channel_mappings cm
       JOIN channel.providers p ON p.id = cm.provider_id
      WHERE cm.tenant_id = $1 AND ($2::uuid IS NULL OR cm.hotel_id = $2) AND ($3::uuid IS NULL OR cm.room_type_id = $3)
      ORDER BY cm.hotel_id, cm.room_type_id, cm.provider_id`,
    [ctx.tenantId, hotelId ?? null, roomTypeId ?? null],
  );
  return { mappings: rows };
}

export async function createChannelMapping(db: Queryable, ctx: AuthContext, input: MappingInput) {
  const provider = await db.query<{ id: string }>('SELECT id FROM channel.providers WHERE id = $1 AND tenant_id = $2', [
    input.providerId,
    ctx.tenantId,
  ]);
  if (!provider.rows[0]) throw notFound('Channel provider not found');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.channel_mappings
       (tenant_id, provider_id, hotel_id, room_type_id, provider_room_code, provider_rate_plan_code, is_active, overrides)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     RETURNING id`,
    [
      ctx.tenantId, input.providerId, input.hotelId, input.roomTypeId,
      input.providerRoomCode, input.providerRatePlanCode ?? null, input.isActive ?? true,
      JSON.stringify(input.overrides ?? {}),
    ],
  );
  const mappingId = rows[0]!.id;
  await auditAction(db, ctx, 'channel.mapping_created', 'channel_mapping', mappingId, {
    after: { providerId: input.providerId, roomTypeId: input.roomTypeId },
  });
  return { mappingId, providerId: input.providerId, roomTypeId: input.roomTypeId };
}

// ---------------------------------------------------------------------------
// ARI push queue
// ---------------------------------------------------------------------------

export interface AriQueueInput {
  providerId: string;
  hotelId: string;
  roomTypeId: string;
  startDate: string;
  endDate: string;
  operation?: 'availability' | 'rates' | 'restrictions' | 'all';
  payload?: Record<string, unknown>;
}

export async function listAriQueue(db: Queryable, ctx: AuthContext, filters: { status?: string; providerId?: string; hotelId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT id, provider_id AS providerId, hotel_id AS hotelId, room_type_id AS roomTypeId,
            start_date AS startDate, end_date AS endDate, operation, payload, status, attempts,
            max_attempts AS maxAttempts, last_error AS lastError, scheduled_for AS scheduledFor, processed_at AS processedAt
       FROM channel.ari_queue
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR provider_id = $2) AND ($3::uuid IS NULL OR hotel_id = $3)
      ORDER BY created_at DESC LIMIT 200`,
    [ctx.tenantId, filters.providerId ?? null, filters.hotelId ?? null],
  );
  return { items: rows.filter((r) => !filters.status || r.status === filters.status) };
}

export async function enqueueAriPush(db: Queryable, ctx: AuthContext, input: AriQueueInput) {
  const provider = await db.query<{ id: string }>('SELECT id FROM channel.providers WHERE id = $1 AND tenant_id = $2', [
    input.providerId,
    ctx.tenantId,
  ]);
  if (!provider.rows[0]) throw notFound('Channel provider not found');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.ari_queue
       (tenant_id, provider_id, hotel_id, room_type_id, start_date, end_date, operation, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     RETURNING id`,
    [
      ctx.tenantId, input.providerId, input.hotelId, input.roomTypeId,
      input.startDate, input.endDate, input.operation ?? 'all', JSON.stringify(input.payload ?? {}),
    ],
  );
  const queueId = rows[0]!.id;
  await auditAction(db, ctx, 'channel.ari_enqueued', 'ari_queue', queueId, {
    after: { providerId: input.providerId, roomTypeId: input.roomTypeId, startDate: input.startDate, endDate: input.endDate },
  });
  return { queueId, status: 'pending' };
}

export async function processAriQueue(db: Queryable, ctx: AuthContext, queueId: string) {
  const { rows } = await db.query<{
    id: string; status: string; attempts: number; max_attempts: number;
    provider_id: string; hotel_id: string; room_type_id: string; operation: string; payload: Record<string, unknown>;
  }>('SELECT id, status, attempts, max_attempts, provider_id, hotel_id, room_type_id, operation, payload FROM channel.ari_queue WHERE id = $1 FOR UPDATE', [
    queueId,
  ]);
  const item = rows[0];
  if (!item) throw notFound('ARI queue item not found');
  if (item.status !== 'pending' && item.status !== 'failed') {
    throw conflict('ARI_ITEM_NOT_REQUEUEABLE', `ARI item is ${item.status} and cannot be reprocessed`);
  }
  const newAttempts = item.attempts + 1;
  const newStatus = newAttempts >= item.max_attempts ? 'failed' : 'completed';
  const { rows: updated } = await db.query<{ id: string }>(
    'UPDATE channel.ari_queue SET status = $2, attempts = $3, processed_at = now(), last_error = NULL WHERE id = $1 RETURNING id',
    [queueId, newStatus, newAttempts],
  );
  await db.query(
    `INSERT INTO channel.sync_log
       (tenant_id, provider_id, operation, entity_type, entity_id, status, records_processed, records_failed, duration_ms, error_summary)
     VALUES ($1,$2,$3,'ari_queue',$4,$5,$6,$7,$8,null)`,
    [ctx.tenantId, item.provider_id, 'ari_push', queueId, newStatus, newStatus === 'completed' ? 1 : 0, newStatus === 'failed' ? 1 : 0, 1],
  ).catch(() => {});
  return { queueId, status: newStatus };
}

// ---------------------------------------------------------------------------
// Reservation imports
// ---------------------------------------------------------------------------

export interface ReservationImportInput {
  providerId: string;
  hotelId: string;
  externalReservationId: string;
  externalConfirmationCode?: string;
  status?: 'imported' | 'mapped' | 'created' | 'failed' | 'duplicate';
  rawPayload?: Record<string, unknown>;
  mappedData?: Record<string, unknown>;
  localReservationId?: string;
  errorMessage?: string;
}

export async function listReservationImports(db: Queryable, ctx: AuthContext, filters: { status?: string; providerId?: string; hotelId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT id, provider_id AS providerId, hotel_id AS hotelId, external_reservation_id AS externalReservationId,
            external_confirmation_code AS externalConfirmationCode, status, mapped_data AS mappedData,
            local_reservation_id AS localReservationId, error_message AS errorMessage, imported_at AS importedAt
       FROM channel.reservation_imports
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR provider_id = $2) AND ($3::uuid IS NULL OR hotel_id = $3)
      ORDER BY imported_at DESC LIMIT 200`,
    [ctx.tenantId, filters.providerId ?? null, filters.hotelId ?? null],
  );
  return { imports: rows.filter((r) => !filters.status || r.status === filters.status) };
}

export async function createReservationImport(db: Queryable, ctx: AuthContext, input: ReservationImportInput) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.reservation_imports
       (tenant_id, provider_id, hotel_id, external_reservation_id, external_confirmation_code, status, raw_payload, mapped_data, local_reservation_id, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
     RETURNING id`,
    [
      ctx.tenantId, input.providerId, input.hotelId, input.externalReservationId,
      input.externalConfirmationCode ?? null, input.status ?? 'imported', JSON.stringify(input.rawPayload ?? {}),
      JSON.stringify(input.mappedData ?? null), input.localReservationId ?? null, input.errorMessage ?? null,
    ],
  );
  const importId = rows[0]!.id;
  await auditAction(db, ctx, 'channel.reservation_imported', 'reservation_import', importId, {
    after: { providerId: input.providerId, externalReservationId: input.externalReservationId },
  });
  return { importId, status: input.status ?? 'imported' };
}

// ---------------------------------------------------------------------------
// Rate parity monitoring
// ---------------------------------------------------------------------------

export interface RateParityCheckInput {
  providerId: string;
  hotelId: string;
  roomTypeId: string;
  checkDate: string;
  localRate: number;
  channelRate: number;
  currency?: string;
  parityStatus?: 'matched' | 'parity_failed' | 'alerted' | 'under_cut';
  variancePercent?: number;
}

export async function listRateParityChecks(db: Queryable, ctx: AuthContext, filters: { status?: string; providerId?: string; hotelId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT id, provider_id AS providerId, hotel_id AS hotelId, room_type_id AS roomTypeId,
            check_date AS checkDate, local_rate AS localRate, channel_rate AS channelRate,
            currency, parity_status AS parityStatus, variance_percent AS variancePercent, checked_at AS checkedAt
       FROM channel.rate_parity_checks
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR provider_id = $2) AND ($3::uuid IS NULL OR hotel_id = $3)
      ORDER BY checked_at DESC LIMIT 200`,
    [ctx.tenantId, filters.providerId ?? null, filters.hotelId ?? null],
  );
  return { checks: rows.filter((r) => !filters.status || r.parityStatus === filters.status) };
}

export async function runRateParityCheck(db: Queryable, ctx: AuthContext, input: RateParityCheckInput) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.rate_parity_checks
       (tenant_id, provider_id, hotel_id, room_type_id, check_date, local_rate, channel_rate, currency, parity_status, variance_percent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      ctx.tenantId, input.providerId, input.hotelId, input.roomTypeId, input.checkDate,
      money(input.localRate), money(input.channelRate), input.currency ?? 'USD',
      input.parityStatus ?? 'matched', input.variancePercent ?? 0,
    ],
  );
  const checkId = rows[0]!.id;
  await auditAction(db, ctx, 'channel.parity_check', 'rate_parity_check', checkId, { after: input });
  return { checkId, parityStatus: input.parityStatus ?? 'matched' };
}

// ---------------------------------------------------------------------------
// Commissions
// ---------------------------------------------------------------------------

export interface CommissionInput {
  providerId: string;
  hotelId: string;
  reservationId?: string;
  externalReservationId?: string;
  stayDate: string;
  roomNights: number;
  grossAmount: number;
  commissionPercent: number;
  netAmount: number;
  currency?: string;
  status?: 'accrued' | 'invoiced' | 'paid' | 'disputed';
  periodStart: string;
  periodEnd: string;
}

export async function listCommissions(db: Queryable, ctx: AuthContext, filters: { status?: string; providerId?: string; hotelId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT id, provider_id AS providerId, hotel_id AS hotelId, reservation_id AS reservationId,
            external_reservation_id AS externalReservationId, stay_date AS stayDate, room_nights AS roomNights,
            gross_amount AS grossAmount, commission_percent AS commissionPercent, commission_amount AS commissionAmount,
            net_amount AS netAmount, currency, status, period_start AS periodStart, period_end AS periodEnd
       FROM channel.commissions
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR provider_id = $2) AND ($3::uuid IS NULL OR hotel_id = $3)
      ORDER BY created_at DESC LIMIT 200`,
    [ctx.tenantId, filters.providerId ?? null, filters.hotelId ?? null],
  );
  return { commissions: rows.filter((r) => !filters.status || r.status === filters.status) };
}

export async function createCommission(db: Queryable, ctx: AuthContext, input: CommissionInput) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.commissions
       (tenant_id, provider_id, hotel_id, reservation_id, external_reservation_id, stay_date, room_nights,
        gross_amount, commission_percent, commission_amount, net_amount, currency, status, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      ctx.tenantId, input.providerId, input.hotelId, input.reservationId ?? null, input.externalReservationId ?? null,
      input.stayDate, input.roomNights, money(input.grossAmount), money(input.commissionPercent),
      money(input.commissionPercent * input.grossAmount) / 100, money(input.netAmount),
      input.currency ?? 'USD', input.status ?? 'accrued', input.periodStart, input.periodEnd,
    ],
  );
  const commissionId = rows[0]!.id;
  await auditAction(db, ctx, 'channel.commission_accrued', 'commission', commissionId, {
    after: { providerId: input.providerId, grossAmount: input.grossAmount },
  });
  return { commissionId, status: input.status ?? 'accrued' };
}

// ---------------------------------------------------------------------------
// Provider health and sync log
// ---------------------------------------------------------------------------

export interface ProviderHealthInput {
  providerId: string;
  checkType: 'connectivity' | 'auth' | 'ari_push' | 'reservation_pull' | 'rate_parity';
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  responseTimeMs?: number;
  errorMessage?: string;
  details?: Record<string, unknown>;
}

export async function listProviderHealth(db: Queryable, ctx: AuthContext) {
  const { rows } = await db.query(
    `SELECT id, provider_id AS providerId, check_type AS checkType, status, response_time_ms AS responseTimeMs,
            error_message AS errorMessage, details, checked_at AS checkedAt
       FROM channel.provider_health
      WHERE tenant_id = $1
      ORDER BY checked_at DESC LIMIT 200`,
    [ctx.tenantId],
  );
  return { checks: rows };
}

export async function recordProviderHealth(db: Queryable, ctx: AuthContext, input: ProviderHealthInput) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.provider_health
       (tenant_id, provider_id, check_type, status, response_time_ms, error_message, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id`,
    [
      ctx.tenantId, input.providerId, input.checkType, input.status, input.responseTimeMs ?? null,
      input.errorMessage ?? null, JSON.stringify(input.details ?? {}),
    ],
  );
  const healthId = rows[0]!.id;
  await auditAction(db, ctx, 'channel.provider_health_recorded', 'provider_health', healthId, { after: input });
  return { healthId, status: input.status };
}

export interface SyncLogInput {
  providerId: string;
  operation: 'ari_push' | 'reservation_pull' | 'rate_parity_check' | 'commission_calc';
  entityType: string;
  entityId?: string;
  status: 'started' | 'completed' | 'failed';
  recordsProcessed?: number;
  recordsFailed?: number;
  durationMs?: number;
  errorSummary?: string;
}

export async function listSyncLog(db: Queryable, ctx: AuthContext, filters: { status?: string; operation?: string } = {}) {
  const { rows } = await db.query(
    `SELECT id, provider_id AS providerId, operation, entity_type AS entityType, entity_id AS entityId,
            status, records_processed AS recordsProcessed, records_failed AS recordsFailed, duration_ms AS durationMs,
            error_summary AS errorSummary, started_at AS startedAt, completed_at AS completedAt
       FROM channel.sync_log
      WHERE tenant_id = $1 AND ($2::text IS NULL OR operation = $2)
      ORDER BY started_at DESC LIMIT 200`,
    [ctx.tenantId, filters.operation ?? null],
  );
  return { events: rows.filter((r) => !filters.status || r.status === filters.status) };
}

export async function logSyncEvent(db: Queryable, ctx: AuthContext, input: SyncLogInput) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO channel.sync_log
       (tenant_id, provider_id, operation, entity_type, entity_id, status, records_processed, records_failed, duration_ms, error_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      ctx.tenantId, input.providerId, input.operation, input.entityType, input.entityId ?? null,
      input.status, input.recordsProcessed ?? 0, input.recordsFailed ?? 0,
      input.durationMs ?? 0, input.errorSummary ?? null,
    ],
  );
  const syncId = rows[0]!.id;
  return { syncId };
}

// ---------------------------------------------------------------------------
// Full sync orchestration: process due ARI queue items
// ---------------------------------------------------------------------------

export async function runAriSyncSweep(db: Queryable, ctx: AuthContext, input: { providerId?: string; hotelId?: string }) {
  const { rows } = await db.query(
    `SELECT id, provider_id AS providerId, hotel_id AS hotelId, room_type_id AS roomTypeId, start_date AS startDate, end_date AS endDate
       FROM channel.ari_queue
      WHERE tenant_id = $1 AND status = 'pending' AND scheduled_for <= now()
        AND ($2::uuid IS NULL OR provider_id = $2) AND ($3::uuid IS NULL OR hotel_id = $3)
      ORDER BY scheduled_for LIMIT 50`,
    [ctx.tenantId, input.providerId ?? null, input.hotelId ?? null],
  );
  const processed: string[] = [];
  for (const row of rows) {
    const result = await processAriQueue(db, ctx, row.id);
    processed.push(row.id);
    if (result.status === 'failed') break;
  }
  await emitEvent(db, ctx.tenantId, 'channel.ari_sync_sweep', 'ari_queue', ctx.tenantId, {
    processed: processed.length,
    ids: processed,
  });
  return { processed: processed.length, ids: processed };
}
