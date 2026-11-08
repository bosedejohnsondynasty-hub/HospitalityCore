import type { FastifyRequest } from 'fastify';
import { withScopedLookup, withTenant, type Queryable } from './db.js';
import { forbidden, moduleNotLicensed, unauthorized } from './errors.js';
import { sha256 } from './security.js';

export interface AuthContext {
  tenantId: string;
  tenantCode: string;
  userId: string;
  sessionId: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: Set<string>;
  branchIds: string[];
  mfaEnabled: boolean;
  request: FastifyRequest;
}

interface SessionRow {
  session_id: string;
  tenant_id: string;
  user_id: string;
  mfa_verified: boolean;
  issued_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

export function sessionTokenOf(req: FastifyRequest): string | undefined {
  return bearerToken(req);
}

/**
 * Resolves the caller from an opaque session token.
 *
 * Step 1 uses a narrowly scoped SECURITY DEFINER lookup because the tenant is
 * not known yet. Every subsequent query runs inside the tenant transaction so
 * RLS applies.
 */
export async function authenticate(req: FastifyRequest): Promise<AuthContext> {
  const token = bearerToken(req);
  if (!token) throw unauthorized();

  const session = await withScopedLookup(async (db) => {
    const { rows } = await db.query<SessionRow>('SELECT * FROM identity_session_lookup($1)', [
      sha256(token),
    ]);
    return rows[0];
  });

  if (!session) throw unauthorized('Invalid session');
  if (session.revoked_at) throw unauthorized('Session has been revoked');
  const now = Date.now();
  if (new Date(session.expires_at).getTime() <= now) throw unauthorized('Session expired');

  return withTenant(session.tenant_id, async (db) => {
    const idleMs = now - new Date(session.last_seen_at).getTime();
    const idleLimitMs = 1000 * 60 * 60;
    if (idleMs > idleLimitMs) {
      await db.query('UPDATE identity.sessions SET revoked_at = now() WHERE id = $1', [
        session.session_id,
      ]);
      throw unauthorized('Session timed out through inactivity');
    }

    const user = await db.query<{
      id: string;
      email: string;
      full_name: string;
      mfa_enabled: boolean;
      status: string;
      tenant_code: string;
    }>(
      `SELECT u.id, u.email, u.full_name, u.mfa_enabled, u.status, t.tenant_code
         FROM identity.users u
         JOIN platform.tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [session.user_id],
    );
    const u = user.rows[0];
    if (!u) throw unauthorized('User no longer exists');
    if (u.status !== 'active') throw forbidden('User account is not active');

    const perms = await db.query<{ permission_code: string }>(
      `SELECT DISTINCT p.permission_code
         FROM access.user_role_assignments ura
         JOIN access.role_permissions rp ON rp.role_id = ura.role_id AND rp.tenant_id = ura.tenant_id
         JOIN access.permissions p ON p.id = rp.permission_id
        WHERE ura.user_id = $1
          AND (ura.valid_from IS NULL OR ura.valid_from <= now())
          AND (ura.valid_until IS NULL OR ura.valid_until > now())`,
      [session.user_id],
    );

    const roles = await db.query<{ role_code: string }>(
      `SELECT DISTINCT r.role_code
         FROM access.user_role_assignments ura
         JOIN access.roles r ON r.id = ura.role_id
        WHERE ura.user_id = $1`,
      [session.user_id],
    );

    const branches = await db.query<{ branch_id: string }>(
      'SELECT branch_id FROM access.user_branch_access WHERE user_id = $1',
      [session.user_id],
    );

    await db.query('UPDATE identity.sessions SET last_seen_at = now() WHERE id = $1', [
      session.session_id,
    ]);

    return {
      tenantId: session.tenant_id,
      tenantCode: u.tenant_code,
      userId: u.id,
      sessionId: session.session_id,
      email: u.email,
      fullName: u.full_name,
      roles: roles.rows.map((r) => r.role_code),
      permissions: new Set(perms.rows.map((p) => p.permission_code)),
      branchIds: branches.rows.map((b) => b.branch_id),
      mfaEnabled: u.mfa_enabled,
      request: req,
    };
  });
}

/** Permission assertion. Hiding a button is not access control; this is. */
export function requirePermission(ctx: AuthContext, ...codes: string[]): void {
  const allowed = codes.some((code) => ctx.permissions.has(code));
  if (!allowed) {
    throw forbidden(`Missing permission: ${codes.join(' or ')}`);
  }
}

export function hasPermission(ctx: AuthContext, code: string): boolean {
  return ctx.permissions.has(code);
}

/**
 * Product module gate: unlicensed modules are refused server side.
 *
 * When `productCode` is given, the module copy owned by that product must be
 * licensed (3-arg function). Shared capability codes such as `pos`, `recipes`
 * and `reservations` exist per product, so deactivating one product's copy
 * must not unlock or lock another product's routes. When omitted, any
 * licensed product copy satisfies the gate — correct for cross-product
 * capabilities such as inventory and procurement.
 */
export async function requireModule(
  ctx: AuthContext,
  db: Queryable,
  moduleCode: string,
  productCode?: string,
): Promise<void> {
  const { rows } = await db.query<{ licensed: boolean }>(
    'SELECT licensing_is_module_licensed($1::uuid, $2::text, $3::text) AS licensed',
    [ctx.tenantId, moduleCode, productCode ?? null],
  );
  if (!rows[0]?.licensed) throw moduleNotLicensed(moduleCode);
}

/** Separation of duties: a user may never approve their own financial request. */
export function assertSegregationOfDuties(actorId: string, requesterId: string, action: string): void {
  if (actorId === requesterId) {
    throw forbidden(`${action} requires a different approver (separation of duties)`);
  }
}
