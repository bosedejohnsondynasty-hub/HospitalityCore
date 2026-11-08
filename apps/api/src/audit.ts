import type { Queryable } from './db.js';
import type { AuthContext } from './auth.js';

export interface AuditInput {
  tenantId: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/** Writes an audit record inside the caller's transaction. */
export async function audit(db: Queryable, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit.events
       (tenant_id, actor_user_id, actor_label, correlation_id, action, entity_type, entity_id,
        branch_id, before_data, after_data, metadata, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.tenantId,
      input.actorUserId ?? null,
      input.actorLabel ?? null,
      input.correlationId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.branchId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      JSON.stringify(input.metadata ?? {}),
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
}

export async function auditAction(
  db: Queryable,
  ctx: AuthContext,
  action: string,
  entityType: string,
  entityId?: string,
  options: { before?: unknown; after?: unknown; branchId?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  await audit(db, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorLabel: ctx.email,
    action,
    entityType,
    entityId,
    branchId: options.branchId ?? null,
    before: options.before,
    after: options.after,
    metadata: options.metadata,
    ip: ctx.request.ip,
    userAgent: ctx.request.headers['user-agent'] ?? null,
  });
}

/** Emits a domain event to the transactional outbox. */
export async function emitEvent(
  db: Queryable,
  tenantId: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query('SELECT app_emit_event($1,$2,$3,$4,$5::jsonb)', [
    tenantId,
    eventType,
    aggregateType,
    aggregateId,
    JSON.stringify(payload),
  ]);
}

/** Idempotent write helper: replays return the first stored response. */
export async function withIdempotency<T>(
  db: Queryable,
  tenantId: string,
  scope: string,
  key: string,
  requestHash: string,
  execute: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const existing = await db.query<{ request_hash: string; response_status: number; response_body: T }>(
    `SELECT request_hash, response_status, response_body
       FROM integration.idempotency_keys
      WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3`,
    [tenantId, scope, key],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw Object.assign(new Error('Idempotency key reused with a different payload'), {
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    return { status: prior.response_status, body: prior.response_body, replayed: true };
  }

  const result = await execute();
  await db.query(
    `INSERT INTO integration.idempotency_keys
       (tenant_id, scope, idempotency_key, request_hash, response_status, response_body)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [tenantId, scope, key, requestHash, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
