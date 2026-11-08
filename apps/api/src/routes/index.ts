import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { authenticate, requirePermission, requireModule, type AuthContext } from '../auth.js';
import { getAdminPool, pool, withScopedLookup, withTenant, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, forbidden, moduleNotLicensed, notFound, unauthorized } from '../errors.js';
import { audit, auditAction } from '../audit.js';
import {
  hashPassword,
  newSessionToken,
  sha256,
  verifyPassword,
  verifyTotp,
  generateTotpSecret,
  totpUri,
} from '../security.js';
import { bootstrapTenant, type BootstrapInput } from '../services/onboarding.js';
import * as hotel from '../services/hotel.js';
import * as restaurant from '../services/restaurant.js';
import * as bar from '../services/bar.js';
import * as finance from '../services/finance.js';
import * as inventory from '../services/inventory.js';
import * as payments from '../services/payments.js';
import * as reports from '../services/reports.js';
import * as workforce from '../services/workforce.js';
import * as assetRegister from '../services/assets.js';
import * as notif from '../services/notifications.js';
import * as backoffice from '../services/backoffice.js';
import * as guestops from '../services/guestops.js';
import * as productops from '../services/productops.js';
import * as maintenance from '../services/maintenance.js';
import * as channelManager from '../services/channel_manager.js';

const need = <T>(value: T | undefined | null, field: string): T => {
  if (value === undefined || value === null || value === '') throw badRequest(`${field} is required`);
  return value;
};

const asNumber = (value: unknown, field: string): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
};

const todayIso = (): string => new Date().toISOString().slice(0, 10);

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  return authenticate(req);
}

async function tenantHandler<T>(
  req: FastifyRequest,
  fn: (ctx: AuthContext, db: Queryable) => Promise<T>,
): Promise<T> {
  const ctx = await requireAuth(req);
  return withTenant(ctx.tenantId, (db) => fn(ctx, db));
}

/**
 * The product whose module copy gates a route is the one named by the route
 * prefix (`/hotel/*` → hotel, `/restaurant/*` → restaurant, `/bar/*` → bar).
 * Cross-product capabilities (`/inventory/*`, `/procurement/*`) are gated on
 * any licensed copy, matching the licensing model's shared-capability rule.
 */
function productForPath(url: string): string | undefined {
  if (url.startsWith('/api/v1/hotel/')) return 'hotel';
  if (url.startsWith('/api/v1/restaurant/')) return 'restaurant';
  if (url.startsWith('/api/v1/bar/')) return 'bar';
  if (url.startsWith('/api/v1/workforce/') || url.startsWith('/api/v1/assets') || url.startsWith('/api/v1/notifications/')) return 'hotel';
  if (url.startsWith('/api/v1/public/qr/')) return 'restaurant';
  return undefined;
}

async function moduleHandler<T>(
  req: FastifyRequest,
  moduleCode: string,
  permission: string,
  fn: (ctx: AuthContext, db: Queryable) => Promise<T>,
): Promise<T> {
  return tenantHandler(req, async (ctx, db) => {
    requirePermission(ctx, permission);
    await requireModule(ctx, db, moduleCode, productForPath(req.url));
    return fn(ctx, db);
  });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok', service: 'hospitality-core-api' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready', database: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable', database: 'error' });
    }
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------
  app.post('/api/v1/auth/login', async (req) => {
    const body = (req.body ?? {}) as {
      email?: string;
      password?: string;
      tenantCode?: string;
      mfaCode?: string;
    };
    const email = need(body.email, 'email').toLowerCase();
    const password = need(body.password, 'password');

    const candidates = await withScopedLookup(async (db) => {
      const { rows } = await db.query<{
        user_id: string;
        tenant_id: string;
        tenant_code: string;
        email: string;
        password_hash: string;
        status: string;
        mfa_enabled: boolean;
        mfa_secret: string | null;
        failed_login_attempts: number;
        locked_until: string | null;
        tenant_status: string;
      }>('SELECT * FROM identity_auth_lookup($1)', [email]);
      return rows;
    });

    const filtered = body.tenantCode
      ? candidates.filter((c) => c.tenant_code === body.tenantCode)
      : candidates;
    if (filtered.length === 0) throw unauthorized('Invalid email or password');
    if (filtered.length > 1) {
      throw badRequest('Multiple accounts use this email. Provide tenantCode.', {
        tenants: filtered.map((c) => c.tenant_code),
      });
    }
    const user = filtered[0]!;
    if (user.tenant_status !== 'active') throw forbidden('Tenant is not active');
    if (user.status !== 'active') throw forbidden('User account is not active');
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw forbidden('Account temporarily locked after repeated failed sign-ins');
    }

    const passwordOk = verifyPassword(password, user.password_hash);
    if (!passwordOk) {
      await withTenant(user.tenant_id, async (db) => {
        await db.query(
          `UPDATE identity.users
              SET failed_login_attempts = failed_login_attempts + 1,
                  locked_until = CASE WHEN failed_login_attempts + 1 >= 8 THEN now() + interval '15 minutes' ELSE locked_until END
            WHERE id = $1`,
          [user.user_id],
        );
      });
      throw unauthorized('Invalid email or password');
    }

    if (user.mfa_enabled) {
      if (!body.mfaCode) {
        throw new AppError(401, 'MFA_REQUIRED', 'A multi-factor authentication code is required');
      }
      if (!user.mfa_secret || !verifyTotp(user.mfa_secret, body.mfaCode)) {
        throw unauthorized('Invalid multi-factor authentication code');
      }
    }

    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_MINUTES * 60_000);
    await withTenant(user.tenant_id, async (db) => {
      await db.query(
        `INSERT INTO identity.sessions
           (tenant_id, user_id, token_hash, mfa_verified, expires_at, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          user.tenant_id,
          user.user_id,
          sha256(token),
          user.mfa_enabled,
          expiresAt,
          req.ip,
          req.headers['user-agent'] ?? null,
        ],
      );
      await db.query(
        'UPDATE identity.users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
        [user.user_id],
      );
      await audit(db, {
        tenantId: user.tenant_id,
        actorUserId: user.user_id,
        actorLabel: user.email,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.user_id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
    });

    return { token, expiresAt: expiresAt.toISOString(), mustChangePassword: false };
  });

  app.post('/api/v1/auth/logout', async (req) => {
    const ctx = await requireAuth(req);
    await withTenant(ctx.tenantId, async (db) => {
      await db.query('UPDATE identity.sessions SET revoked_at = now() WHERE id = $1', [ctx.sessionId]);
      await auditAction(db, ctx, 'auth.logout', 'session', ctx.sessionId);
    });
    return { status: 'signed_out' };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const ctx = await requireAuth(req);
    return withTenant(ctx.tenantId, async (db) => {
      const tenant = await db.query('SELECT tenant_code, tenant_name, default_currency, timezone FROM platform.tenants WHERE id = $1', [
        ctx.tenantId,
      ]);
      const licensed = await db.query<{ module_code: string }>(
        `SELECT DISTINCT mc.module_code
           FROM licensing.module_activations ma
           JOIN licensing.module_catalogue mc ON mc.id = ma.module_id
          WHERE ma.status = 'active' AND licensing_is_module_licensed($1, mc.module_code)`,
        [ctx.tenantId],
      );
      const branches = await db.query(
        'SELECT id, branch_code, branch_name, branch_type FROM platform.branches WHERE status = $1 ORDER BY branch_name',
        ['active'],
      );
      return {
        user: {
          id: ctx.userId,
          email: ctx.email,
          fullName: ctx.fullName,
          roles: ctx.roles,
          mfaEnabled: ctx.mfaEnabled,
        },
        tenant: tenant.rows[0],
        permissions: [...ctx.permissions],
        licensedModules: licensed.rows.map((r) => r.module_code),
        branches: branches.rows,
        branchScope: ctx.branchIds,
      };
    });
  });

  app.post('/api/v1/auth/mfa/enroll', async (req) => {
    const ctx = await requireAuth(req);
    const secret = generateTotpSecret();
    await withTenant(ctx.tenantId, async (db) => {
      await db.query('UPDATE identity.users SET mfa_secret = $2, mfa_enabled = false WHERE id = $1', [
        ctx.userId,
        secret,
      ]);
      await auditAction(db, ctx, 'auth.mfa_enrolled', 'user', ctx.userId);
    });
    return { secret, otpauthUri: totpUri(secret, ctx.email) };
  });

  app.post('/api/v1/auth/mfa/activate', async (req) => {
    const ctx = await requireAuth(req);
    const body = (req.body ?? {}) as { code?: string };
    const code = need(body.code, 'code');
    return withTenant(ctx.tenantId, async (db) => {
      const { rows } = await db.query<{ mfa_secret: string | null }>(
        'SELECT mfa_secret FROM identity.users WHERE id = $1',
        [ctx.userId],
      );
      const secret = rows[0]?.mfa_secret;
      if (!secret) throw conflict('MFA_NOT_ENROLLED', 'Start MFA enrolment first');
      if (!verifyTotp(secret, code)) throw unauthorized('Invalid authentication code');
      await db.query('UPDATE identity.users SET mfa_enabled = true WHERE id = $1', [ctx.userId]);
      await auditAction(db, ctx, 'auth.mfa_activated', 'user', ctx.userId);
      return { mfaEnabled: true };
    });
  });

  app.post('/api/v1/auth/change-password', async (req) => {
    const ctx = await requireAuth(req);
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const current = need(body.currentPassword, 'currentPassword');
    const next = need(body.newPassword, 'newPassword');
    return withTenant(ctx.tenantId, async (db) => {
      const { rows } = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM identity.users WHERE id = $1',
        [ctx.userId],
      );
      if (!rows[0] || !verifyPassword(current, rows[0].password_hash)) {
        throw unauthorized('Current password is incorrect');
      }
      await db.query('UPDATE identity.users SET password_hash = $2, must_change_password = false WHERE id = $1', [
        ctx.userId,
        hashPassword(next),
      ]);
      await db.query('UPDATE identity.sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2', [
        ctx.userId,
        ctx.sessionId,
      ]);
      await auditAction(db, ctx, 'auth.password_changed', 'user', ctx.userId);
      return { status: 'changed' };
    });
  });

  // -------------------------------------------------------------------------
  // First-run setup
  // -------------------------------------------------------------------------
  app.get('/api/v1/setup/status', async () => {
    const admin = await getAdminPool().connect();
    try {
      const { rows } = await admin.query<{ count: string }>('SELECT count(*) FROM platform.tenants');
      return {
        provisioned: Number(rows[0]!.count) > 0,
        apiSetupEnabled: Boolean(config.ALLOW_API_SETUP && config.SETUP_TOKEN),
      };
    } finally {
      admin.release();
    }
  });

  app.post('/api/v1/setup/bootstrap', async (req) => {
    if (!config.ALLOW_API_SETUP) {
      throw forbidden('API setup is disabled. Use the provisioning CLI or enable ALLOW_API_SETUP.');
    }
    const supplied = req.headers['x-setup-token'];
    if (!config.SETUP_TOKEN || supplied !== config.SETUP_TOKEN) {
      throw unauthorized('Invalid setup token');
    }
    const body = req.body as BootstrapInput;
    if (!body || !body.tenantCode) throw badRequest('Invalid bootstrap payload');

    const admin = await getAdminPool().connect();
    try {
      await admin.query('BEGIN');
      const result = await bootstrapTenant(admin, body, 'setup:api');
      await admin.query('COMMIT');
      return result;
    } catch (err) {
      await admin.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      admin.release();
    }
  });

  // -------------------------------------------------------------------------
  // Licence centre
  // -------------------------------------------------------------------------
  app.get('/api/v1/licensing/catalogue', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.licensing.view', 'platform.licensing.manage');
      const { rows } = await db.query(
        `SELECT pc.product_code, pc.product_name, mc.module_code, mc.module_name, mc.module_category,
                mc.description, mc.is_core, mc.display_order,
                coalesce(ma.status, 'not_activated') AS activation_status,
                licensing_is_module_licensed($1, mc.module_code, pc.product_code) AS licensed
           FROM licensing.module_catalogue mc
           JOIN licensing.product_catalogue pc ON pc.id = mc.product_id
           LEFT JOIN licensing.module_activations ma ON ma.module_id = mc.id AND ma.tenant_id = $1
          ORDER BY pc.product_code, mc.display_order`,
        [ctx.tenantId],
      );
      const products = new Map<string, { code: string; name: string; modules: unknown[] }>();
      for (const row of rows as Array<Record<string, unknown>>) {
        const code = String(row.product_code);
        if (!products.has(code)) {
          products.set(code, { code, name: String(row.product_name), modules: [] });
        }
        products.get(code)!.modules.push({
          code: row.module_code,
          name: row.module_name,
          category: row.module_category,
          description: row.description,
          isCore: row.is_core,
          activationStatus: row.activation_status,
          licensed: row.licensed,
        });
      }
      return { products: [...products.values()] };
    }),
  );

  app.post('/api/v1/licensing/modules/:moduleCode/:action', async (req) => {
    const { moduleCode, action } = req.params as { moduleCode: string; action: string };
    if (!['activate', 'deactivate'].includes(action)) throw badRequest('action must be activate or deactivate');
    const body = (req.body ?? {}) as { product?: string };
    const productCode = body.product ?? undefined;
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.licensing.manage');
      const module = await db.query<{ id: string; product_id: string; module_name: string; product_code: string }>(
        `SELECT mc.id, mc.product_id, mc.module_name, pc.product_code
           FROM licensing.module_catalogue mc
           JOIN licensing.product_catalogue pc ON pc.id = mc.product_id
          WHERE mc.module_code = $1 AND ($2::text IS NULL OR pc.product_code = $2)`,
        [moduleCode, productCode ?? null],
      );
      const row = module.rows[0];
      if (!row) {
        if (productCode) {
          const any = await db.query(
            'SELECT 1 FROM licensing.module_catalogue WHERE module_code = $1',
            [moduleCode],
          );
          if (any.rows.length > 0) {
            throw badRequest('module does not belong to the requested product');
          }
        }
        throw notFound('Module not found in catalogue');
      }
      if (!productCode) {
        throw badRequest('product is required for shared modules');
      }
      const instance = await db.query<{ id: string }>(
        `SELECT id FROM licensing.product_instances
         WHERE product_id = $1 AND tenant_id = $2 AND status <> $3 LIMIT 1`,
        [row.product_id, ctx.tenantId, 'deactivated'],
      );
      if (!instance.rows[0]) {
        throw conflict('PRODUCT_NOT_LICENSED', 'This product is not licensed for the tenant');
      }
      const status = action === 'activate' ? 'active' : 'deactivated';
      await db.query(
        `INSERT INTO licensing.module_activations
           (tenant_id, product_instance_id, product_id, module_id, status, activated_by, deactivated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, product_instance_id, module_id)
         DO UPDATE SET status = EXCLUDED.status,
                       deactivated_at = EXCLUDED.deactivated_at,
                       activated_by = EXCLUDED.activated_by`,
        [
          ctx.tenantId,
          instance.rows[0].id,
          row.product_id,
          row.id,
          status,
          ctx.userId,
          action === 'deactivate' ? new Date() : null,
        ],
      );
      await db.query(
        `INSERT INTO licensing.license_events
           (tenant_id, product_instance_id, module_id, event_type, actor_user_id, reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6, jsonb_build_object('product_code', $7::text, 'module_code', $8::text))`,
        [
          ctx.tenantId,
          instance.rows[0].id,
          row.id,
          action === 'activate' ? 'activated' : 'deactivated',
          ctx.userId,
          'licence centre',
          row.product_code,
          moduleCode,
        ],
      );
      await auditAction(db, ctx, `licensing.${action}d`, 'module', row.id, {
        metadata: { moduleCode },
      });
      return { moduleCode, status };
    });
  });

  app.get('/api/v1/platform/branches', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.branches.view', 'hotel.hotels.view', 'restaurant.outlets.view', 'bar.outlets.view');
      const { rows } = await db.query(
        `SELECT b.id, b.branch_code, b.branch_name, b.branch_type, b.currency_code, b.timezone, b.status,
                le.entity_name
           FROM platform.branches b
           JOIN platform.legal_entities le ON le.id = b.legal_entity_id
          ORDER BY b.branch_name`,
      );
      return { branches: rows };
    }),
  );

  app.get('/api/v1/platform/users', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.users.view', 'platform.users.manage');
      const { rows } = await db.query(
        `SELECT u.id, u.email, u.full_name, u.status, u.mfa_enabled, u.last_login_at,
                coalesce(array_agg(DISTINCT r.role_code) FILTER (WHERE r.role_code IS NOT NULL), '{}') AS roles
           FROM identity.users u
           LEFT JOIN access.user_role_assignments ura ON ura.user_id = u.id
           LEFT JOIN access.roles r ON r.id = ura.role_id
          GROUP BY u.id ORDER BY u.full_name`,
      );
      return { users: rows };
    }),
  );

  app.post('/api/v1/platform/users', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.users.manage');
      const body = (req.body ?? {}) as {
        email?: string;
        fullName?: string;
        password?: string;
        roles?: string[];
        branchIds?: string[];
      };
      const email = need(body.email, 'email').toLowerCase();
      const fullName = need(body.fullName, 'fullName');
      const password = need(body.password, 'password');
      const roleCodes = body.roles?.length ? body.roles : ['front_desk'];
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO identity.users (tenant_id, email, password_hash, full_name, must_change_password)
         VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [ctx.tenantId, email, hashPassword(password), fullName],
      );
      const userId = rows[0]!.id;
      for (const code of roleCodes) {
        const role = await db.query<{ id: string }>('SELECT id FROM access.roles WHERE role_code = $1', [code]);
        if (!role.rows[0]) throw badRequest(`Unknown role: ${code}`);
        await db.query(
          'INSERT INTO access.user_role_assignments (tenant_id, user_id, role_id) VALUES ($1,$2,$3)',
          [ctx.tenantId, userId, role.rows[0].id],
        );
      }
      for (const branchId of body.branchIds ?? []) {
        await db.query(
          'INSERT INTO access.user_branch_access (tenant_id, user_id, branch_id) VALUES ($1,$2,$3)',
          [ctx.tenantId, userId, branchId],
        );
      }
      await auditAction(db, ctx, 'platform.user_created', 'user', userId, {
        after: { email, roles: roleCodes },
      });
      return { userId, email, roles: roleCodes };
    }),
  );

  app.get('/api/v1/platform/roles', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.users.view', 'platform.roles.manage');
      const { rows } = await db.query(
        `SELECT r.id, r.role_code, r.role_name, r.description,
                count(rp.permission_id) AS permission_count
           FROM access.roles r
           LEFT JOIN access.role_permissions rp ON rp.role_id = r.id
          GROUP BY r.id ORDER BY r.role_name`,
      );
      return { roles: rows };
    }),
  );

  app.get('/api/v1/platform/audit', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.audit.view');
      const query = req.query as { limit?: string };
      const limit = Math.min(Number(query.limit ?? 100), 500);
      const { rows } = await db.query(
        `SELECT id, actor_label, action, entity_type, entity_id, metadata, created_at
           FROM audit.events ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return { events: rows };
    }),
  );

  // -------------------------------------------------------------------------
  // Hotel
  // -------------------------------------------------------------------------
  app.get('/api/v1/hotel/hotels', async (req) =>
    moduleHandler(req, 'front_office', 'hotel.hotels.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT h.id, h.hotel_code, h.hotel_name, h.star_rating, h.check_in_time, h.check_out_time,
                h.tax_rate, h.service_charge_rate, h.default_currency, b.branch_name,
                (SELECT count(*) FROM hotel.rooms r WHERE r.hotel_id = h.id) AS room_count
           FROM hotel.hotels h JOIN platform.branches b ON b.id = h.branch_id
          ORDER BY h.hotel_name`,
      );
      return { hotels: rows };
    }),
  );

  app.get('/api/v1/hotel/room-types', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'front_office', 'hotel.hotels.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT id, hotel_id, room_type_code, room_type_name, base_rate, max_occupancy
           FROM hotel.room_types
          WHERE ($1::uuid IS NULL OR hotel_id = $1)
          ORDER BY room_type_code`,
        [query.hotelId ?? null],
      );
      return { roomTypes: rows };
    });
  });

  app.get('/api/v1/hotel/rooms', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'front_office', 'hotel.rooms.view', async (_ctx, db) =>
      ({ rooms: await hotel.listRooms(db, need(query.hotelId, 'hotelId')) }),
    );
  });

  app.get('/api/v1/hotel/guests', async (req) => {
    const query = req.query as { search?: string };
    return moduleHandler(req, 'guest_management', 'hotel.guests.view', async (_ctx, db) =>
      ({ guests: await hotel.listGuests(db, query.search) }),
    );
  });

  app.post('/api/v1/hotel/guests', async (req) =>
    moduleHandler(req, 'guest_management', 'hotel.guests.manage', async (ctx, db) =>
      hotel.createGuest(db, ctx, req.body as Parameters<typeof hotel.createGuest>[2]),
    ),
  );

  app.get('/api/v1/hotel/availability', async (req) => {
    const query = req.query as { hotelId?: string; from?: string; to?: string };
    return moduleHandler(req, 'reservations', 'hotel.reservations.view', async (_ctx, db) =>
      ({
        rooms: await hotel.checkAvailability(
          db,
          need(query.hotelId, 'hotelId'),
          need(query.from, 'from'),
          need(query.to, 'to'),
        ),
      }),
    );
  });

  app.get('/api/v1/hotel/reservations', async (req) => {
    const query = req.query as { hotelId?: string; status?: string };
    return moduleHandler(req, 'reservations', 'hotel.reservations.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.reservation_number, r.arrival_date, r.departure_date, r.status, r.adults, r.children,
                r.room_rate, r.total_amount, g.first_name, g.last_name, rt.room_type_name,
                (SELECT string_agg(rm.room_number, ',') FROM hotel.room_allocations ra
                   JOIN hotel.rooms rm ON rm.id = ra.room_id
                  WHERE ra.reservation_id = r.id AND ra.status = 'active') AS rooms
           FROM hotel.reservations r
           JOIN hotel.guests g ON g.id = r.primary_guest_id
           JOIN hotel.room_types rt ON rt.id = r.room_type_id
          WHERE ($1::uuid IS NULL OR r.hotel_id = $1) AND ($2::text IS NULL OR r.status = $2)
          ORDER BY r.arrival_date DESC LIMIT 100`,
        [query.hotelId ?? null, query.status ?? null],
      );
      return { reservations: rows };
    });
  });

  app.post('/api/v1/hotel/reservations', async (req) =>
    moduleHandler(req, 'reservations', 'hotel.reservations.create', async (ctx, db) => {
      const body = req.body as {
        hotelId: string;
        guestId: string;
        roomTypeId: string;
        arrivalDate: string;
        departureDate: string;
        adults?: number;
        children?: number;
        source?: string;
        roomRate?: number;
        specialRequests?: string;
      };
      const reservation = await hotel.createReservation(db, ctx, {
        ...body,
        roomRate: body.roomRate === undefined ? undefined : asNumber(body.roomRate, 'roomRate'),
      });
      return reservation;
    }),
  );

  app.patch('/api/v1/hotel/reservations/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      arrivalDate?: string;
      departureDate?: string;
      adults?: number;
      children?: number;
      roomTypeId?: string;
      roomRate?: number;
      specialRequests?: string;
    };
    return moduleHandler(req, 'reservations', 'hotel.reservations.create', async (ctx, db) =>
      hotel.amendReservation(db, ctx, id, {
        ...body,
        adults: body.adults === undefined ? undefined : asNumber(body.adults, 'adults'),
        children: body.children === undefined ? undefined : asNumber(body.children, 'children'),
        roomRate: body.roomRate === undefined ? undefined : asNumber(body.roomRate, 'roomRate'),
      }),
    );
  });

  app.post('/api/v1/hotel/reservations/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    return moduleHandler(req, 'reservations', 'hotel.reservations.cancel', async (ctx, db) =>
      hotel.cancelReservation(db, ctx, id, need(body.reason, 'reason')),
    );
  });

  app.post('/api/v1/hotel/reservations/:id/no-show', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'reservations', 'hotel.reservations.cancel', async (ctx, db) =>
      hotel.markNoShow(db, ctx, id),
    );
  });

  app.post('/api/v1/hotel/reservations/:id/allocate', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { roomId?: string; auto?: boolean };
    return moduleHandler(req, 'reservations', 'hotel.reservations.create', async (ctx, db) =>
      body.auto
        ? hotel.allocateBestAvailable(db, ctx, id)
        : hotel.allocateRoom(db, ctx, id, need(body.roomId, 'roomId')),
    );
  });

  app.post('/api/v1/hotel/reservations/:id/checkin', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { roomId?: string };
    return moduleHandler(req, 'front_office', 'hotel.frontdesk.checkin', async (ctx, db) =>
      hotel.checkIn(db, ctx, { reservationId: id, roomId: body.roomId }),
    );
  });

  app.post('/api/v1/hotel/stays/:id/checkout', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { allowOutstandingBalance?: boolean };
    return moduleHandler(req, 'front_office', 'hotel.frontdesk.checkout', async (ctx, db) =>
      hotel.checkOut(db, ctx, { stayId: id, allowOutstandingBalance: body.allowOutstandingBalance }),
    );
  });

  app.get('/api/v1/hotel/folios/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'front_office', 'hotel.folios.view', async (_ctx, db) =>
      hotel.getFolio(db, id),
    );
  });

  app.post('/api/v1/hotel/folios/:id/charges', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      entryType?: string;
      description?: string;
      amount?: number | string;
      taxAmount?: number | string;
    };
    return moduleHandler(req, 'front_office', 'hotel.folios.post', async (ctx, db) =>
      hotel.postFolioCharge(db, ctx, {
        folioId: id,
        entryType: body.entryType ?? 'room_charge',
        description: need(body.description, 'description'),
        amount: asNumber(need(body.amount, 'amount'), 'amount'),
        taxAmount: body.taxAmount === undefined ? 0 : asNumber(body.taxAmount, 'taxAmount'),
      }),
    );
  });

  app.post('/api/v1/hotel/folios/:id/settle', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { amount?: number | string; method?: string; reference?: string };
    return moduleHandler(req, 'cashiering', 'hotel.folios.settle', async (ctx, db) =>
      hotel.settleFolio(db, ctx, {
        folioId: id,
        amount: asNumber(need(body.amount, 'amount'), 'amount'),
        method: (body.method ?? 'cash') as 'cash' | 'bank_transfer' | 'pos_terminal',
        reference: body.reference,
      }),
    );
  });

  app.post('/api/v1/hotel/folio-entries/:id/reverse', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    return moduleHandler(req, 'cashiering', 'hotel.folios.reverse', async (ctx, db) =>
      hotel.reverseFolioEntry(db, ctx, { entryId: id, reason: need(body.reason, 'reason') }),
    );
  });

  app.get('/api/v1/hotel/business-date', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'night_audit', 'hotel.reports.view', async (_ctx, db) =>
      ({ businessDate: await hotel.businessDate(db, need(query.hotelId, 'hotelId')) }),
    );
  });

  app.post('/api/v1/hotel/night-audit', async (req) => {
    const body = (req.body ?? {}) as { hotelId?: string; overrideReason?: string };
    return moduleHandler(req, 'night_audit', 'hotel.nightaudit.run', async (ctx, db) => {
      if (body.overrideReason) requirePermission(ctx, 'hotel.nightaudit.override');
      return hotel.nightAudit(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        overrideReason: body.overrideReason,
      });
    });
  });

  // Housekeeping
  app.get('/api/v1/hotel/housekeeping/tasks', async (req) => {
    const query = req.query as { hotelId?: string; status?: string };
    return moduleHandler(req, 'housekeeping', 'hotel.housekeeping.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT t.id, t.status, t.priority, t.scheduled_for, t.assigned_to, t.completed_at,
                r.room_number, r.housekeeping_status, tt.task_name, tt.task_code,
                u.full_name AS assignee
           FROM housekeeping.tasks t
           JOIN hotel.rooms r ON r.id = t.room_id
           JOIN housekeeping.task_types tt ON tt.id = t.task_type_id
           LEFT JOIN identity.users u ON u.id = t.assigned_to
          WHERE ($1::uuid IS NULL OR t.hotel_id = $1) AND ($2::text IS NULL OR t.status = $2)
          ORDER BY t.scheduled_for DESC, r.room_number LIMIT 200`,
        [query.hotelId ?? null, query.status ?? null],
      );
      return { tasks: rows };
    });
  });

  app.get('/api/v1/hotel/housekeeping/checklist', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'housekeeping', 'hotel.housekeeping.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT cti.id, cti.item_text, cti.display_order, cti.requires_photo, ct.template_name
           FROM housekeeping.checklist_template_items cti
           JOIN housekeeping.checklist_templates ct ON ct.id = cti.template_id
          WHERE ct.hotel_id = $1 ORDER BY cti.display_order`,
        [need(query.hotelId, 'hotelId')],
      );
      return { items: rows };
    });
  });

  app.post('/api/v1/hotel/housekeeping/tasks', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      roomId?: string;
      taskCode?: string;
      assignedTo?: string;
      priority?: string;
      scheduledFor?: string;
    };
    return moduleHandler(req, 'housekeeping', 'hotel.housekeeping.assign', async (ctx, db) => {
      const hotelId = need(body.hotelId, 'hotelId');
      const taskType = body.taskCode
        ? await db.query<{ id: string }>(
            'SELECT id FROM housekeeping.task_types WHERE hotel_id = $1 AND task_code = $2',
            [hotelId, body.taskCode],
          )
        : await db.query<{ id: string }>(
            'SELECT id FROM housekeeping.task_types WHERE hotel_id = $1 ORDER BY default_minutes LIMIT 1',
            [hotelId],
          );
      if (!taskType.rows[0]) throw conflict('NO_TASK_TYPES', 'Configure housekeeping task types first');
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO housekeeping.tasks
           (tenant_id, hotel_id, room_id, task_type_id, assigned_to, status, priority, scheduled_for, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          ctx.tenantId,
          hotelId,
          need(body.roomId, 'roomId'),
          taskType.rows[0].id,
          body.assignedTo ?? null,
          body.assignedTo ? 'assigned' : 'pending',
          body.priority ?? 'normal',
          body.scheduledFor ?? todayIso(),
          ctx.userId,
        ],
      );
      await db.query(
        "UPDATE hotel.rooms SET housekeeping_status = 'in_progress' WHERE id = $1 AND housekeeping_status <> 'dirty'",
        [body.roomId],
      );
      await auditAction(db, ctx, 'housekeeping.task_assigned', 'housekeeping_task', rows[0]!.id, {
        after: { hotelId, roomId: body.roomId, assignedTo: body.assignedTo ?? null },
      });
      return { taskId: rows[0]!.id };
    });
  });

  app.post('/api/v1/hotel/housekeeping/tasks/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { checklist?: Array<{ itemId?: string; done?: boolean }>; notes?: string };
    return moduleHandler(req, 'housekeeping', 'hotel.housekeeping.complete', async (ctx, db) => {
      const { rows } = await db.query<{ status: string; room_id: string }>(
        'SELECT status, room_id FROM housekeeping.tasks WHERE id = $1 FOR UPDATE',
        [id],
      );
      const task = rows[0];
      if (!task) throw notFound('Task not found');
      if (task.status === 'inspected') throw conflict('TASK_ALREADY_INSPECTED', 'Task is already inspected');
      await db.query(
        "UPDATE housekeeping.tasks SET status = 'completed', completed_at = now(), notes = coalesce($2, notes) WHERE id = $1",
        [id, body.notes ?? null],
      );
      for (const entry of body.checklist ?? []) {
        if (!entry.itemId) continue;
        await db.query(
          `INSERT INTO housekeeping.task_checklist_results
             (tenant_id, task_id, template_item_id, is_done, recorded_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, task_id, template_item_id)
           DO UPDATE SET is_done = EXCLUDED.is_done`,
          [ctx.tenantId, id, entry.itemId, entry.done ?? true, ctx.userId],
        );
      }
      await db.query("UPDATE hotel.rooms SET housekeeping_status = 'clean' WHERE id = $1", [task.room_id]);
      await db.query(
        `INSERT INTO housekeeping.room_status_log (tenant_id, room_id, previous_status, new_status, source, changed_by)
         VALUES ($1,$2,'in_progress','clean','housekeeping',$3)`,
        [ctx.tenantId, task.room_id, ctx.userId],
      );
      await auditAction(db, ctx, 'housekeeping.task_completed', 'housekeeping_task', id, {
        metadata: { checklist: body.checklist?.length ?? 0 },
      });
      return { taskId: id, status: 'completed' };
    });
  });

  app.post('/api/v1/hotel/housekeeping/tasks/:id/inspect', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { result?: 'passed' | 'failed' | 'rework'; score?: number; notes?: string };
    return moduleHandler(req, 'housekeeping', 'hotel.housekeeping.inspect', async (ctx, db) => {
      const { rows } = await db.query<{ room_id: string; hotel_id: string; status: string }>(
        'SELECT room_id, hotel_id, status FROM housekeeping.tasks WHERE id = $1',
        [id],
      );
      const task = rows[0];
      if (!task) throw notFound('Task not found');
      if (task.status !== 'completed') {
        throw conflict('TASK_NOT_COMPLETED', 'Only completed tasks can be inspected');
      }
      const result = body.result ?? 'passed';
      if (result === 'passed') {
        // Room readiness is gated by maintenance, not by housekeeping alone.
        const hold = await maintenance.roomMaintenanceHold(db, task.room_id);
        if (hold) {
          throw conflict(
            'ROOM_MAINTENANCE_HOLD',
            `Room has open maintenance ${hold.work_order_number} (${hold.status}); it cannot be released as ready yet`,
            { workOrderId: hold.id, status: hold.status },
          );
        }
      }
      await db.query(
        `INSERT INTO housekeeping.inspections (tenant_id, task_id, room_id, inspected_by, result, score, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.tenantId, id, task.room_id, ctx.userId, result, body.score ?? null, body.notes ?? null],
      );
      await db.query(
        result === 'passed'
          ? "UPDATE housekeeping.tasks SET status = 'inspected' WHERE id = $1"
          : "UPDATE housekeeping.tasks SET status = 'rejected' WHERE id = $1",
        [id],
      );
      await db.query(
        result === 'passed'
          ? "UPDATE hotel.rooms SET housekeeping_status = 'inspected' WHERE id = $1"
          : "UPDATE hotel.rooms SET housekeeping_status = 'dirty' WHERE id = $1",
        [task.room_id],
      );
      await auditAction(db, ctx, 'housekeeping.task_inspected', 'housekeeping_task', id, {
        after: { result, score: body.score ?? null },
      });
      return { taskId: id, result, roomReadiness: result === 'passed' ? 'inspected' : 'dirty' };
    });
  });

  // Maintenance
  app.get('/api/v1/hotel/maintenance/requests', async (req) =>
    moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.description, r.priority, r.status, r.created_at, rm.room_number
           FROM maintenance.requests r
           LEFT JOIN hotel.rooms rm ON rm.id = r.room_id
          ORDER BY r.created_at DESC LIMIT 100`,
      );
      return { requests: rows };
    }),
  );

  app.post('/api/v1/hotel/maintenance/requests', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      roomId?: string;
      assetId?: string;
      description?: string;
      priority?: string;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.request', async (ctx, db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO maintenance.requests (tenant_id, branch_id, room_id, asset_id, description, priority, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          ctx.tenantId,
          need(body.branchId, 'branchId'),
          body.roomId ?? null,
          body.assetId ?? null,
          need(body.description, 'description'),
          body.priority ?? 'normal',
          ctx.userId,
        ],
      );
      await auditAction(db, ctx, 'maintenance.request_created', 'maintenance_request', rows[0]!.id, {
        after: { description: body.description, priority: body.priority ?? 'normal' },
      });
      return { requestId: rows[0]!.id, status: 'open' };
    });
  });

  app.post('/api/v1/hotel/maintenance/requests/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.approve', async (ctx, db) => {
      const { rows } = await db.query<{ status: string; requested_by: string | null }>(
        'SELECT status, requested_by FROM maintenance.requests WHERE id = $1 FOR UPDATE',
        [id],
      );
      const request = rows[0];
      if (!request) throw notFound('Maintenance request not found');
      if (request.status !== 'open') throw conflict('REQUEST_NOT_OPEN', `Request is ${request.status}`);
      if (request.requested_by === ctx.userId) {
        throw forbidden('A maintenance request must be approved by a different user');
      }
      await db.query(
        "UPDATE maintenance.requests SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
        [id, ctx.userId],
      );
      await auditAction(db, ctx, 'maintenance.request_approved', 'maintenance_request', id);
      return { requestId: id, status: 'approved' };
    });
  });

  app.get('/api/v1/hotel/maintenance/work-orders', async (req) =>
    moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT w.id, w.work_order_number, w.description, w.priority, w.status, w.assigned_to,
                w.completed_at, u.full_name AS assignee
           FROM maintenance.work_orders w
           LEFT JOIN identity.users u ON u.id = w.assigned_to
          ORDER BY w.created_at DESC LIMIT 100`,
      );
      return { workOrders: rows };
    }),
  );

  app.post('/api/v1/hotel/maintenance/work-orders', async (req) => {
    const body = (req.body ?? {}) as {
      requestId?: string;
      branchId?: string;
      assetId?: string;
      roomId?: string;
      description?: string;
      priority?: string;
      assignedTo?: string;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.approve', async (ctx, db) => {
      let branchId = body.branchId;
      let description = body.description;
      // Fault intake owns the room, location, trade and room-readiness impact;
      // the work order inherits them so the room gate cannot be bypassed.
      let roomId = body.roomId ?? null;
      let assetId = body.assetId ?? null;
      let locationId: string | null = null;
      let teamId: string | null = null;
      let affectsRoomReadiness = false;
      let slaDueAt: string | null = null;
      if (body.requestId) {
        const { rows } = await db.query<{
          branch_id: string;
          description: string;
          status: string;
          room_id: string | null;
          asset_id: string | null;
          location_id: string | null;
          team_id: string | null;
          affects_room_readiness: boolean;
          sla_due_at: string | null;
        }>(
          `SELECT branch_id, description, status, room_id, asset_id, location_id, team_id,
                  affects_room_readiness, sla_due_at
             FROM maintenance.requests WHERE id = $1`,
          [body.requestId],
        );
        const request = rows[0];
        if (!request) throw notFound('Maintenance request not found');
        if (request.status !== 'approved') {
          throw conflict('REQUEST_NOT_APPROVED', 'Only approved requests can become work orders');
        }
        branchId = request.branch_id;
        description = description ?? request.description;
        roomId = roomId ?? request.room_id;
        assetId = assetId ?? request.asset_id;
        locationId = request.location_id;
        teamId = request.team_id;
        affectsRoomReadiness = request.affects_room_readiness;
        slaDueAt = request.sla_due_at;
      }
      const number = await db.query<{ number: string }>(
        "SELECT app_next_document_number($1, 'work_order', 'WO-') AS number",
        [ctx.tenantId],
      );
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO maintenance.work_orders
           (tenant_id, branch_id, request_id, asset_id, room_id, location_id, team_id,
            work_order_number, description, priority, status, assigned_to, sla_due_at,
            affects_room_readiness, verification_required)
         VALUES ($1,$2,$3,$4,$5,$11,$12,$6,$7,$8,$9,$10,
                 coalesce($13::timestamptz, now() + interval '24 hours'), $14, $14) RETURNING id`,
        [
          ctx.tenantId,
          need(branchId, 'branchId'),
          body.requestId ?? null,
          assetId,
          roomId,
          number.rows[0]!.number,
          need(description, 'description'),
          body.priority ?? 'normal',
          body.assignedTo ? 'assigned' : 'created',
          body.assignedTo ?? null,
          locationId,
          teamId,
          slaDueAt,
          affectsRoomReadiness,
        ],
      );
      if (body.requestId) {
        await db.query("UPDATE maintenance.requests SET status = 'converted' WHERE id = $1", [body.requestId]);
      }
      await auditAction(db, ctx, 'maintenance.work_order_created', 'work_order', rows[0]!.id, {
        after: { workOrderNumber: number.rows[0]!.number },
      });
      return { workOrderId: rows[0]!.id, workOrderNumber: number.rows[0]!.number };
    });
  });

  app.post('/api/v1/hotel/maintenance/work-orders/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      resolutionNote?: string;
      parts?: Array<{ itemId: string; quantity: number; unitCost?: number }>;
      labourCost?: number;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.complete', async (ctx, db) => {
      const { rows } = await db.query<{ branch_id: string; work_order_number: string; status: string }>(
        'SELECT branch_id, work_order_number, status FROM maintenance.work_orders WHERE id = $1 FOR UPDATE',
        [id],
      );
      const wo = rows[0];
      if (!wo) throw notFound('Work order not found');
      if (wo.status === 'completed' || wo.status === 'verified') {
        throw conflict('WORK_ORDER_ALREADY_COMPLETE', 'Work order already completed');
      }
      let partsValue = 0;
      for (const part of body.parts ?? []) {
        const cost = part.unitCost ?? 0;
        await db.query(
          `INSERT INTO maintenance.work_order_parts (tenant_id, work_order_id, item_code, quantity, unit_cost, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ctx.tenantId, id, part.itemId, part.quantity, cost, ctx.userId],
        );
        const item = await db.query<{ id: string; standard_cost: string }>(
          'SELECT id, standard_cost FROM inventory.items WHERE id = $1 OR sku = $2 LIMIT 1',
          [part.itemId, part.itemId],
        );
        if (item.rows[0]) {
          const store = await db.query<{ id: string }>(
            "SELECT id FROM inventory.stores WHERE branch_id = $1 ORDER BY store_type LIMIT 1",
            [wo.branch_id],
          );
          if (store.rows[0]) {
            await db.query(
              `INSERT INTO inventory.movements
                 (tenant_id, branch_id, store_id, item_id, movement_type, quantity, unit_cost, total_cost,
                  reference_type, reference_id, notes, performed_by)
               VALUES ($1,$2,$3,$4,'issue',$5,$6,$7,'work_order',$8,$9,$10)`,
              [
                ctx.tenantId,
                wo.branch_id,
                store.rows[0].id,
                item.rows[0].id,
                -part.quantity,
                cost || Number(item.rows[0].standard_cost),
                (cost || Number(item.rows[0].standard_cost)) * part.quantity,
                id,
                `Work order ${wo.work_order_number} parts`,
                ctx.userId,
              ],
            );
          }
        }
        partsValue += part.quantity * cost;
      }
      await db.query(
        `UPDATE maintenance.work_orders
            SET status = 'completed', completed_at = now(), completed_by = $2,
                resolution_note = $3, labour_cost = coalesce($4, labour_cost)
          WHERE id = $1`,
        [id, ctx.userId, body.resolutionNote ?? null, body.labourCost ?? null],
      );
      await auditAction(db, ctx, 'maintenance.work_order_completed', 'work_order', id, {
        after: { partsValue, labourCost: body.labourCost ?? 0 },
      });
      return { workOrderId: id, status: 'completed', partsValue };
    });
  });

  // -------------------------------------------------------------------------
  // Maintenance & Engineering depth: trades, locations, checklists, handoff
  // -------------------------------------------------------------------------
  app.get('/api/v1/hotel/maintenance/teams', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.listTeams(db, need(query.hotelId, 'hotelId')),
    );
  });

  app.post('/api/v1/hotel/maintenance/teams', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      teamCode?: string;
      teamName?: string;
      trade?: 'electrical' | 'plumbing' | 'hvac' | 'general' | 'other';
      description?: string;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.config', async (ctx, db) =>
      maintenance.createTeam(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        teamCode: need(body.teamCode, 'teamCode'),
        teamName: need(body.teamName, 'teamName'),
        trade: body.trade,
        description: body.description,
      }),
    );
  });

  app.get('/api/v1/hotel/maintenance/locations', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.listLocations(db, need(query.hotelId, 'hotelId')),
    );
  });

  app.post('/api/v1/hotel/maintenance/locations', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      locationCode?: string;
      locationName?: string;
      category?: 'public_area' | 'food_beverage' | 'back_of_house' | 'plant' | 'external';
      floorLabel?: string;
      parentLocationId?: string;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.config', async (ctx, db) =>
      maintenance.createLocation(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        locationCode: need(body.locationCode, 'locationCode'),
        locationName: need(body.locationName, 'locationName'),
        category: body.category ?? 'back_of_house',
        floorLabel: body.floorLabel,
        parentLocationId: body.parentLocationId,
      }),
    );
  });

  app.get('/api/v1/hotel/maintenance/checklists', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.listChecklistTemplates(db, need(query.hotelId, 'hotelId')),
    );
  });

  app.post('/api/v1/hotel/maintenance/checklists', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown> & { items?: unknown };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.config', async (ctx, db) =>
      maintenance.createChecklistTemplate(db, ctx, body as never),
    );
  });

  app.post('/api/v1/hotel/maintenance/checklists/generate', async (req) => {
    const body = (req.body ?? {}) as { hotelId?: string; date?: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.config', async (ctx, db) =>
      maintenance.generateChecklists(db, ctx, need(body.hotelId, 'hotelId'), body.date),
    );
  });

  app.get('/api/v1/hotel/maintenance/checklists/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.getChecklistTemplate(db, id),
    );
  });

  app.get('/api/v1/hotel/maintenance/checklist-instances', async (req) => {
    const query = req.query as { hotelId?: string; status?: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.listChecklistInstances(db, need(query.hotelId, 'hotelId'), query.status),
    );
  });

  app.get('/api/v1/hotel/maintenance/checklist-instances/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.getChecklistInstance(db, id),
    );
  });

  app.post('/api/v1/hotel/maintenance/checklist-instances/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      results?: Array<{
        itemId: string;
        result: 'pass' | 'fail' | 'na' | 'unable';
        numericValue?: number | string;
        remark?: string;
      }>;
      note?: string;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.complete', async (ctx, db) =>
      maintenance.completeChecklistInstance(db, ctx, id, {
        note: body.note,
        results: (body.results ?? []).map((entry) => ({
          itemId: entry.itemId,
          result: entry.result,
          remark: entry.remark,
          numericValue:
            entry.numericValue === undefined ? undefined : asNumber(entry.numericValue, 'numericValue'),
        })),
      }),
    );
  });

  app.post('/api/v1/hotel/maintenance/faults', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      roomId?: string;
      locationId?: string;
      category?: 'electrical' | 'plumbing' | 'hvac' | 'general' | 'safety';
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      description?: string;
      source?: 'manual' | 'housekeeping' | 'front_office' | 'guest' | 'inspection' | 'preventive' | 'emergency';
      affectsRoomReadiness?: boolean;
      housekeepingTaskId?: string;
      assetId?: string;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.request', async (ctx, db) =>
      maintenance.reportFault(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        roomId: body.roomId,
        locationId: body.locationId,
        category: body.category,
        priority: body.priority,
        description: need(body.description, 'description'),
        source: body.source ?? 'housekeeping',
        affectsRoomReadiness: body.affectsRoomReadiness,
        housekeepingTaskId: body.housekeepingTaskId,
        assetId: body.assetId,
      }),
    );
  });

  app.post('/api/v1/hotel/maintenance/requests/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.approve', async (ctx, db) =>
      maintenance.rejectRequest(db, ctx, id, need(body.reason, 'reason')),
    );
  });

  app.post('/api/v1/hotel/maintenance/work-orders/:id/transition', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string; reason?: string };
    const target = need(body.status, 'status');
    const permission =
      target === 'verified' ? 'hotel.maintenance.verify' : 'hotel.maintenance.complete';
    return moduleHandler(req, 'maintenance', permission, async (ctx, db) =>
      maintenance.transitionWorkOrder(db, ctx, id, target, body.reason),
    );
  });

  app.get('/api/v1/hotel/maintenance/rooms/:roomId/history', async (req) => {
    const { roomId } = req.params as { roomId: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.roomHistory(db, roomId),
    );
  });

  app.get('/api/v1/hotel/maintenance/sla-policies', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.view', async (_ctx, db) =>
      maintenance.listSlaPolicies(db, need(query.hotelId, 'hotelId')),
    );
  });

  app.patch('/api/v1/hotel/maintenance/sla-policies', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      acknowledgeHours?: number | string;
      resolveHours?: number | string;
    };
    return moduleHandler(req, 'maintenance', 'hotel.maintenance.config', async (ctx, db) =>
      maintenance.setSlaPolicy(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        priority: body.priority ?? 'normal',
        acknowledgeHours: asNumber(need(body.acknowledgeHours, 'acknowledgeHours'), 'acknowledgeHours'),
        resolveHours: asNumber(need(body.resolveHours, 'resolveHours'), 'resolveHours'),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Restaurant
  // -------------------------------------------------------------------------
  app.get('/api/v1/restaurant/outlets', async (req) =>
    moduleHandler(req, 'core', 'restaurant.outlets.view', async (_ctx, db) => ({
      outlets: await restaurant.listOutlets(db),
    })),
  );

  app.get('/api/v1/restaurant/outlets/:id/menu', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'menu_qr', 'restaurant.menu.view', async (_ctx, db) => ({
      ...(await restaurant.getMenu(db, id)),
      outlet: await restaurant.getOutlet(db, id),
    }));
  });

  app.post('/api/v1/restaurant/menus/:menuId/categories', async (req) => {
    const { menuId } = req.params as { menuId: string };
    const body = (req.body ?? {}) as { name?: string; displayOrder?: number };
    return moduleHandler(req, 'menu_qr', 'restaurant.menu.manage', async (ctx, db) =>
      restaurant.createMenuCategory(db, ctx, {
        menuId,
        name: need(body.name, 'name'),
        displayOrder: body.displayOrder,
      }),
    );
  });

  app.post('/api/v1/restaurant/menus/:menuId/items', async (req) => {
    const { menuId } = req.params as { menuId: string };
    const body = (req.body ?? {}) as {
      categoryId?: string;
      sku?: string;
      name?: string;
      description?: string;
      price?: number | string;
      taxRate?: number | string;
      kitchenStationId?: string;
      prepMinutes?: number;
      isAlcoholic?: boolean;
      allergens?: string[];
    };
    return moduleHandler(req, 'menu_qr', 'restaurant.menu.manage', async (ctx, db) =>
      restaurant.createMenuItem(db, ctx, {
        menuId,
        categoryId: body.categoryId,
        sku: need(body.sku, 'sku'),
        name: need(body.name, 'name'),
        description: body.description,
        price: asNumber(need(body.price, 'price'), 'price'),
        taxRate: body.taxRate === undefined ? undefined : asNumber(body.taxRate, 'taxRate'),
        kitchenStationId: body.kitchenStationId,
        prepMinutes: body.prepMinutes,
        isAlcoholic: body.isAlcoholic,
        allergens: body.allergens,
      }),
    );
  });

  app.get('/api/v1/restaurant/outlets/:id/qr', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'menu_qr', 'restaurant.menu.view', async (_ctx, db) => ({
      tokens: await restaurant.listQrTokens(db, id),
    }));
  });

  app.post('/api/v1/restaurant/outlets/:id/qr', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { tableId?: string; label?: string };
    return moduleHandler(req, 'menu_qr', 'restaurant.menu.manage', async (ctx, db) => {
      const token = await restaurant.createQrToken(db, ctx, {
        outletId: id,
        tableId: body.tableId,
        label: body.label,
      });
      return { ...token, menuUrl: `/qr/${token.token}` };
    });
  });

  app.get('/api/v1/restaurant/outlets/:id/tables', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'tables', 'restaurant.orders.view', async (_ctx, db) => ({
      tables: await restaurant.listTables(db, id),
    }));
  });

  app.post('/api/v1/restaurant/menu-items/:id/recipe', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      yieldQuantity?: number;
      yieldUnit?: string;
      instructions?: string;
      ingredients?: Array<{ itemSku: string; quantity: number; unit?: string; wastagePercent?: number }>;
    };
    return moduleHandler(req, 'recipes', 'restaurant.menu.manage', async (ctx, db) =>
      restaurant.createRecipe(db, ctx, {
        itemId: id,
        yieldQuantity: body.yieldQuantity,
        yieldUnit: body.yieldUnit,
        instructions: body.instructions,
        ingredients: body.ingredients ?? [],
      }),
    );
  });

  app.get('/api/v1/restaurant/outlets/:id/stations', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'core', 'restaurant.outlets.view', async (_ctx, db) => {
      const { rows } = await db.query(
        'SELECT id, station_code, station_name FROM restaurant.kitchen_stations WHERE outlet_id = $1 ORDER BY station_name',
        [id],
      );
      return { stations: rows };
    });
  });

  app.get('/api/v1/restaurant/orders', async (req) => {
    const query = req.query as { outletId?: string; status?: string };
    return moduleHandler(req, 'ordering', 'restaurant.orders.view', async (_ctx, db) => ({
      orders: await restaurant.listOrders(db, query.outletId, query.status),
    }));
  });

  app.get('/api/v1/restaurant/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'ordering', 'restaurant.orders.view', async (_ctx, db) =>
      restaurant.getOrder(db, id),
    );
  });

  app.post('/api/v1/restaurant/orders', async (req) => {
    const body = req.body as restaurant.CreateOrderInput;
    return moduleHandler(req, 'ordering', 'restaurant.orders.create', async (ctx, db) =>
      restaurant.createOrder(db, ctx.tenantId, body, ctx.userId),
    );
  });

  app.post('/api/v1/restaurant/orders/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: restaurant.OrderStatus };
    return moduleHandler(req, 'ordering', 'restaurant.orders.update', async (ctx, db) =>
      restaurant.advanceOrder(db, ctx, id, need(body.status, 'status')),
    );
  });

  app.post('/api/v1/restaurant/orders/:id/void', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    return moduleHandler(req, 'ordering', 'restaurant.orders.void', async (ctx, db) =>
      restaurant.voidOrder(db, ctx, id, need(body.reason, 'reason')),
    );
  });

  app.post('/api/v1/restaurant/orders/:id/charge-to-folio', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { folioId?: string };
    return moduleHandler(req, 'ordering', 'restaurant.orders.update', async (ctx, db) =>
      restaurant.chargeOrderToFolio(db, ctx, { orderId: id, folioId: need(body.folioId, 'folioId') }),
    );
  });

  app.get('/api/v1/restaurant/kitchen', async (req) => {
    const query = req.query as { outletId?: string };
    return moduleHandler(req, 'kitchen', 'restaurant.kitchen.view', async (_ctx, db) => {
      const { rows } = await db.query(
        `SELECT t.id, t.ticket_number, t.status, t.item_summary, t.created_at, t.started_at,
                o.order_number, o.channel, tb.table_code
           FROM restaurant.kitchen_tickets t
           JOIN restaurant.orders o ON o.id = t.order_id
           LEFT JOIN restaurant.tables tb ON tb.id = o.table_id
          WHERE ($1::uuid IS NULL OR t.outlet_id = $1)
            AND t.status IN ('queued','in_progress','ready')
          ORDER BY t.created_at`,
        [query.outletId ?? null],
      );
      return { tickets: rows };
    });
  });

  // -------------------------------------------------------------------------
  // Bar
  // -------------------------------------------------------------------------
  app.get('/api/v1/bar/outlets', async (req) =>
    moduleHandler(req, 'core', 'bar.outlets.view', async (_ctx, db) => ({ outlets: await bar.listOutlets(db) })),
  );

  app.get('/api/v1/bar/outlets/:id/beverages', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'beverages', 'bar.beverages.view', async (_ctx, db) => ({
      beverages: await bar.listBeverages(db, id),
    }));
  });

  app.post('/api/v1/bar/beverages', async (req) => {
    const body = (req.body ?? {}) as {
      barId?: string;
      sku?: string;
      name?: string;
      category?: string;
      salePrice?: number | string;
      costPrice?: number | string;
      servingSizeMl?: number;
      isAlcoholic?: boolean;
      inventorySku?: string;
    };
    return moduleHandler(req, 'beverages', 'bar.beverages.manage', async (ctx, db) =>
      bar.createBeverage(db, ctx, {
        barId: need(body.barId, 'barId'),
        sku: need(body.sku, 'sku'),
        name: need(body.name, 'name'),
        category: body.category ?? 'beer',
        salePrice: asNumber(need(body.salePrice, 'salePrice'), 'salePrice'),
        costPrice: body.costPrice === undefined ? 0 : asNumber(body.costPrice, 'costPrice'),
        servingSizeMl: body.servingSizeMl,
        isAlcoholic: body.isAlcoholic,
        inventorySku: body.inventorySku,
      }),
    );
  });

  app.post('/api/v1/bar/beverages/:id/recipe', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      yieldServings?: number;
      preparation?: string;
      ingredients?: Array<{ itemSku: string; quantity: number; unit: string }>;
    };
    return moduleHandler(req, 'recipes', 'bar.beverages.manage', async (ctx, db) =>
      bar.createCocktailRecipe(db, ctx, {
        beverageId: id,
        yieldServings: body.yieldServings,
        preparation: body.preparation,
        ingredients: body.ingredients ?? [],
      }),
    );
  });

  app.get('/api/v1/bar/orders', async (req) => {
    const query = req.query as { barId?: string };
    return moduleHandler(req, 'orders', 'bar.orders.view', async (_ctx, db) => ({
      orders: await bar.listOrders(db, query.barId),
    }));
  });

  app.post('/api/v1/bar/orders', async (req) => {
    const body = req.body as bar.BarOrderInput;
    return moduleHandler(req, 'orders', 'bar.orders.create', async (ctx, db) =>
      bar.createOrder(db, ctx, body),
    );
  });

  app.get('/api/v1/bar/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'orders', 'bar.orders.view', async (_ctx, db) => bar.getOrder(db, id));
  });

  app.post('/api/v1/bar/orders/:id/charge-to-folio', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { folioId?: string };
    return moduleHandler(req, 'orders', 'bar.orders.create', async (ctx, db) =>
      bar.chargeOrderToFolio(db, ctx, { orderId: id, folioId: need(body.folioId, 'folioId') }),
    );
  });

  // -------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------
  app.post('/api/v1/payments/intents', async (req) => {
    const body = (req.body ?? {}) as {
      relatedType?: 'restaurant_order' | 'bar_order' | 'hotel_folio';
      relatedId?: string;
      provider?: 'paystack' | 'flutterwave' | 'cash' | 'bank_transfer' | 'pos_terminal';
      customerEmail?: string;
      customerPhone?: string;
    };
    const relatedType = need(body.relatedType, 'relatedType');
    const relatedId = need(body.relatedId, 'relatedId');
    const permission =
      relatedType === 'hotel_folio' ? 'hotel.folios.settle' : relatedType === 'bar_order' ? 'bar.payments.initiate' : 'restaurant.payments.initiate';
    const { moduleCode, productCode } =
      relatedType === 'hotel_folio'
        ? { moduleCode: 'cashiering', productCode: 'hotel' }
        : relatedType === 'bar_order'
          ? { moduleCode: 'pos', productCode: 'bar' }
          : { moduleCode: 'pos', productCode: 'restaurant' };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, permission);
      await requireModule(ctx, db, moduleCode, productCode);
      return payments.createIntent(db, ctx, {
        relatedType,
        relatedId,
        provider: need(body.provider, 'provider'),
        customerEmail: body.customerEmail,
        customerPhone: body.customerPhone,
      });
    });
  });

  app.get('/api/v1/payments/intents/:id', async (req) => {
    const { id } = req.params as { id: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'hotel.folios.view', 'restaurant.orders.view', 'bar.orders.view');
      return payments.verifyIntent(db, id);
    });
  });

  app.post('/api/v1/payments/refunds', async (req) => {
    const body = (req.body ?? {}) as { intentId?: string; amount?: number | string; reason?: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'restaurant.payments.refund', 'bar.payments.refund', 'hotel.folios.reverse');
      return payments.requestRefund(db, ctx, {
        intentId: need(body.intentId, 'intentId'),
        amount: asNumber(need(body.amount, 'amount'), 'amount'),
        reason: need(body.reason, 'reason'),
      });
    });
  });

  app.post('/api/v1/payments/refunds/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approve?: boolean; note?: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'restaurant.payments.refund', 'bar.payments.refund', 'hotel.folios.reverse');
      return payments.approveRefund(db, ctx, { refundId: id, approve: body.approve !== false, note: body.note });
    });
  });

  // -------------------------------------------------------------------------
  // Finance
  // -------------------------------------------------------------------------
  app.get('/api/v1/finance/accounts', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'finance.accounts.view', 'finance.reports.view');
      const { rows } = await db.query(
        'SELECT id, account_code, account_name, account_class, normal_balance FROM finance.accounts ORDER BY account_code',
      );
      return { accounts: rows };
    }),
  );

  app.get('/api/v1/finance/trial-balance', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'finance.reports.view', 'finance.journals.view');
      const rows = await finance.trialBalance(db);
      const totalDebit = rows.reduce((s, r) => s + r.total_debit, 0);
      const totalCredit = rows.reduce((s, r) => s + r.total_credit, 0);
      return { accounts: rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.0001 };
    }),
  );

  app.get('/api/v1/finance/journals', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'finance.journals.view');
      const { rows } = await db.query(
        `SELECT e.id, e.entry_number, e.entry_date, e.description, e.status, e.source_type,
                e.source_id, sum(l.debit) AS total
           FROM finance.journal_entries e
           JOIN finance.journal_lines l ON l.entry_id = e.id
          GROUP BY e.id ORDER BY e.entry_date DESC, e.entry_number DESC LIMIT 200`,
      );
      return { journals: rows.map((r) => ({ ...r, total: Number(r.total) })) };
    }),
  );

  app.post('/api/v1/finance/journals', async (req) => {
    const body = (req.body ?? {}) as {
      entryDate?: string;
      description?: string;
      lines?: Array<{ accountCode?: string; debit?: number; credit?: number; description?: string }>;
    };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'finance.journals.post');
      const entryId = await finance.postJournal(db, {
        tenantId: ctx.tenantId,
        entryDate: need(body.entryDate, 'entryDate'),
        description: need(body.description, 'description'),
        lines: (body.lines ?? []).map((l) => ({
          accountCode: l.accountCode,
          debit: asNumber(l.debit ?? 0, 'debit'),
          credit: asNumber(l.credit ?? 0, 'credit'),
          description: l.description,
        })),
        postedBy: ctx.userId,
      });
      await auditAction(db, ctx, 'finance.journal_posted', 'journal_entry', entryId, {
        after: { description: body.description },
      });
      return { journalEntryId: entryId };
    });
  });

  app.get('/api/v1/finance/reports/revenue', async (req) => {
    const query = req.query as { from?: string; to?: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'finance.reports.view', 'hotel.reports.view');
      return {
        rows: await reports.revenueBySource(db, query.from ?? todayIso(), query.to ?? todayIso()),
      };
    });
  });

  // -------------------------------------------------------------------------
  // Inventory and procurement
  // -------------------------------------------------------------------------
  app.get('/api/v1/inventory/items', async (req) =>
    moduleHandler(req, 'inventory', 'inventory.items.view', async (_ctx, db) => ({
      items: await inventory.listItems(db),
    })),
  );

  app.post('/api/v1/inventory/items', async (req) => {
    const body = (req.body ?? {}) as {
      sku?: string;
      name?: string;
      category?: string;
      baseUnit?: string;
      standardCost?: number | string;
      reorderLevel?: number | string;
      isBatchTracked?: boolean;
    };
    return moduleHandler(req, 'inventory', 'inventory.items.manage', async (ctx, db) =>
      inventory.createItem(db, ctx, {
        sku: need(body.sku, 'sku'),
        name: need(body.name, 'name'),
        category: body.category ?? 'food',
        baseUnit: body.baseUnit,
        standardCost: body.standardCost === undefined ? 0 : asNumber(body.standardCost, 'standardCost'),
        reorderLevel: body.reorderLevel === undefined ? 0 : asNumber(body.reorderLevel, 'reorderLevel'),
        isBatchTracked: body.isBatchTracked,
      }),
    );
  });

  app.get('/api/v1/inventory/stores', async (req) =>
    moduleHandler(req, 'inventory', 'inventory.stock.view', async (_ctx, db) => ({
      stores: await inventory.listStores(db),
    })),
  );

  app.get('/api/v1/inventory/balances', async (req) => {
    const query = req.query as { storeId?: string };
    return moduleHandler(req, 'inventory', 'inventory.stock.view', async (_ctx, db) => ({
      balances: await inventory.stockBalances(db, query.storeId),
    }));
  });

  app.get('/api/v1/inventory/movements', async (req) => {
    const query = req.query as { itemId?: string; limit?: string };
    return moduleHandler(req, 'inventory', 'inventory.stock.view', async (_ctx, db) => ({
      movements: await inventory.listMovements(db, query.itemId, Number(query.limit ?? 100)),
    }));
  });

  app.post('/api/v1/inventory/receipts', async (req) => {
    const body = req.body as Parameters<typeof inventory.receiveStock>[2];
    return moduleHandler(req, 'inventory', 'inventory.stock.receive', async (ctx, db) =>
      inventory.receiveStock(db, ctx, body),
    );
  });

  app.post('/api/v1/inventory/issues', async (req) => {
    const body = req.body as Parameters<typeof inventory.issueStock>[2];
    return moduleHandler(req, 'inventory', 'inventory.stock.issue', async (ctx, db) =>
      inventory.issueStock(db, ctx, body),
    );
  });

  app.post('/api/v1/inventory/adjustments', async (req) => {
    const body = (req.body ?? {}) as {
      storeId?: string;
      itemId?: string;
      quantity?: number | string;
      reason?: string;
    };
    return moduleHandler(req, 'inventory', 'inventory.stock.adjust', async (ctx, db) =>
      inventory.adjustStock(db, ctx, {
        storeId: need(body.storeId, 'storeId'),
        itemId: need(body.itemId, 'itemId'),
        quantity: asNumber(need(body.quantity, 'quantity'), 'quantity'),
        reason: need(body.reason, 'reason'),
      }),
    );
  });

  app.get('/api/v1/procurement/suppliers', async (req) =>
    moduleHandler(req, 'procurement', 'procurement.purchaseorders.view', async (_ctx, db) => ({
      suppliers: await inventory.listSuppliers(db),
    })),
  );

  app.post('/api/v1/procurement/suppliers', async (req) => {
    const body = (req.body ?? {}) as {
      code?: string;
      name?: string;
      email?: string;
      phone?: string;
      paymentTermsDays?: number;
    };
    return moduleHandler(req, 'procurement', 'procurement.suppliers.manage', async (ctx, db) =>
      inventory.createSupplier(db, ctx, {
        code: need(body.code, 'code'),
        name: need(body.name, 'name'),
        email: body.email,
        phone: body.phone,
        paymentTermsDays: body.paymentTermsDays,
      }),
    );
  });

  app.get('/api/v1/procurement/purchase-orders', async (req) =>
    moduleHandler(req, 'procurement', 'procurement.purchaseorders.view', async (_ctx, db) => ({
      purchaseOrders: await inventory.listPurchaseOrders(db),
    })),
  );

  app.post('/api/v1/procurement/purchase-orders', async (req) => {
    const body = req.body as Parameters<typeof inventory.createPurchaseOrder>[2];
    return moduleHandler(req, 'procurement', 'procurement.purchaseorders.create', async (ctx, db) =>
      inventory.createPurchaseOrder(db, ctx, body),
    );
  });

  app.post('/api/v1/procurement/purchase-orders/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'procurement', 'procurement.purchaseorders.approve', async (ctx, db) =>
      inventory.approvePurchaseOrder(db, ctx, id),
    );
  });

  app.post('/api/v1/procurement/invoices', async (req) => {
    const body = req.body as Parameters<typeof inventory.createSupplierInvoice>[2];
    return moduleHandler(req, 'procurement', 'procurement.invoices.manage', async (ctx, db) =>
      inventory.createSupplierInvoice(db, ctx, body),
    );
  });

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------
  app.get('/api/v1/reports/dashboard', async (req) => {
    const query = req.query as { hotelId?: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'hotel.reports.view', 'restaurant.reports.view', 'bar.reports.view', 'finance.reports.view');
      return reports.dashboard(db, query.hotelId);
    });
  });

  app.get('/api/v1/reports/daily-sales', async (req) => {
    const query = req.query as { from?: string; to?: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'restaurant.reports.view', 'bar.reports.view', 'hotel.reports.view');
      return reports.dailySales(db, query.from ?? todayIso(), query.to ?? todayIso());
    });
  });

  app.get('/api/v1/reports/occupancy', async (req) => {
    const query = req.query as { hotelId?: string; from?: string; to?: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'hotel.reports.view');
      return {
        rows: await reports.occupancyReport(
          db,
          need(query.hotelId, 'hotelId'),
          query.from ?? todayIso(),
          query.to ?? todayIso(),
        ),
      };
    });
  });

  // -------------------------------------------------------------------------
  // Mobile sync
  // -------------------------------------------------------------------------
  app.post('/api/v1/sync/devices', async (req) => {
    const body = (req.body ?? {}) as { deviceId?: string; platform?: string; appVersion?: string };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.sync.execute');
      return reports.registerDevice(db, ctx, {
        deviceId: need(body.deviceId, 'deviceId'),
        platform: body.platform ?? 'pwa',
        appVersion: body.appVersion,
      });
    });
  });

  app.post('/api/v1/sync/commands', async (req) => {
    const body = (req.body ?? {}) as {
      deviceId?: string;
      commandId?: string;
      commandType?: string;
      payload?: Record<string, unknown>;
    };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.sync.execute');
      return reports.submitSyncCommand(db, ctx, {
        deviceId: need(body.deviceId, 'deviceId'),
        commandId: need(body.commandId, 'commandId'),
        commandType: need(body.commandType, 'commandType'),
        payload: body.payload ?? {},
      });
    });
  });

  app.get('/api/v1/sync/conflicts', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.sync.execute', 'platform.audit.view');
      return { conflicts: await reports.listSyncConflicts(db) };
    }),
  );

  app.post('/api/v1/sync/conflicts/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      resolution?: 'client_wins' | 'server_wins' | 'merged' | 'discarded';
      note?: string;
    };
    return tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'platform.sync.execute');
      return reports.resolveSyncConflict(db, ctx, {
        conflictId: id,
        resolution: need(body.resolution, 'resolution'),
        note: body.note,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Public QR ordering
  // -------------------------------------------------------------------------
  const qrLookup = async (token: string) => {
    const row = await withScopedLookup(async (db) => {
      const { rows } = await db.query<{
        tenant_id: string;
        outlet_id: string;
        table_id: string | null;
        is_active: boolean;
        expires_at: string | null;
        accepts_qr_orders: boolean;
        outlet_status: string;
      }>('SELECT * FROM restaurant_qr_lookup($1)', [token]);
      return rows[0];
    });
    if (!row) throw notFound('QR code is not recognised');
    if (!row.is_active) throw forbidden('QR code has been disabled');
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      throw forbidden('QR code has expired');
    }
    if (!row.accepts_qr_orders || row.outlet_status !== 'active') {
      throw conflict('QR_ORDERING_UNAVAILABLE', 'This outlet is not accepting QR orders');
    }
    return row;
  };

  // Public QR channels respect licensing exactly like authenticated ones:
  // a deactivated restaurant menu/ordering module must lock the QR channel.
  const requireRestaurantLicense = async (
    db: Queryable,
    tenantId: string,
    moduleCode: string,
  ): Promise<void> => {
    const { rows } = await db.query<{ licensed: boolean }>(
      'SELECT licensing_is_module_licensed($1::uuid, $2::text, $3::text) AS licensed',
      [tenantId, moduleCode, 'restaurant'],
    );
    if (!rows[0]?.licensed) throw moduleNotLicensed(moduleCode);
  };

  app.get('/api/v1/public/qr/:token/menu', async (req) => {
    const { token } = req.params as { token: string };
    const qr = await qrLookup(token);
    return withTenant(qr.tenant_id, async (db) => {
      await requireRestaurantLicense(db, qr.tenant_id, 'menu_qr');
      return {
        ...(await restaurant.publicMenuByToken(db, { outlet_id: qr.outlet_id })),
        table: qr.table_id,
      };
    });
  });

  app.post('/api/v1/public/qr/:token/orders', async (req) => {
    const { token } = req.params as { token: string };
    const qr = await qrLookup(token);
    const body = (req.body ?? {}) as {
      items?: Array<{ itemId: string; quantity: number; notes?: string }>;
      customerName?: string;
      customerPhone?: string;
      clientOrderId?: string;
    };
    return withTenant(qr.tenant_id, async (db) => {
      await requireRestaurantLicense(db, qr.tenant_id, 'ordering');
      const order = await restaurant.createOrder(
        db,
        qr.tenant_id,
        {
          outletId: qr.outlet_id,
          channel: qr.table_id ? 'qr_table' : 'qr_general',
          items: body.items ?? [],
          tableId: qr.table_id ?? undefined,
          customerName: body.customerName,
          customerPhone: body.customerPhone,
          qrTokenId: undefined,
        },
        null,
      );
      return {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        total: order.total,
        currency: 'NGN',
        paymentTiming: order.paymentTiming,
        status: order.status,
        trackingUrl: `/qr/${token}/order/${order.orderId}`,
      };
    });
  });

  app.get('/api/v1/public/qr/:token/orders/:orderId', async (req) => {
    const { token, orderId } = req.params as { token: string; orderId: string };
    const qr = await qrLookup(token);
    return withTenant(qr.tenant_id, async (db) => {
      const order = await restaurant.getOrder(db, orderId);
      if ((order as { table_id: string | null }).table_id !== qr.table_id) {
        throw notFound('Order not found for this QR code');
      }
      return order;
    });
  });

  app.post('/api/v1/public/qr/:token/orders/:orderId/pay', async (req) => {
    const { token, orderId } = req.params as { token: string; orderId: string };
    const qr = await qrLookup(token);
    const body = (req.body ?? {}) as { provider?: 'paystack' | 'flutterwave' };
    const provider = need(body.provider, 'provider');
    return withTenant(qr.tenant_id, async (db) =>
      payments.createPublicOrderIntent(db, qr.tenant_id, orderId, provider),
    );
  });

  // -------------------------------------------------------------------------
  // Workforce: employees, rosters, attendance and payroll
  // -------------------------------------------------------------------------
  app.get('/api/v1/workforce/employees', async (req) =>
    moduleHandler(req, 'hr', 'hotel.hr.view', async (_ctx, db) => ({
      employees: await workforce.listEmployees(db),
    })),
  );

  app.post('/api/v1/workforce/employees', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      employeeNumber?: string;
      fullName?: string;
      email?: string;
      phone?: string;
      jobTitle?: string;
      department?: string;
      employmentType?: 'full_time' | 'part_time' | 'contract' | 'casual';
      hireDate?: string;
      baseSalary?: number | string;
    };
    return moduleHandler(req, 'hr', 'hotel.hr.manage', async (ctx, db) =>
      workforce.createEmployee(db, ctx, {
        branchId: body.branchId,
        employeeNumber: body.employeeNumber,
        fullName: need(body.fullName, 'fullName'),
        email: body.email,
        phone: body.phone,
        jobTitle: need(body.jobTitle, 'jobTitle'),
        department: need(body.department, 'department'),
        employmentType: body.employmentType,
        hireDate: need(body.hireDate, 'hireDate'),
        baseSalary: asNumber(need(body.baseSalary, 'baseSalary'), 'baseSalary'),
      }),
    );
  });

  app.patch('/api/v1/workforce/employees/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    return moduleHandler(req, 'hr', 'hotel.hr.manage', async (ctx, db) =>
      workforce.updateEmployee(db, ctx, id, {
        fullName: typeof body.fullName === 'string' ? body.fullName : undefined,
        email: body.email === null ? null : typeof body.email === 'string' ? body.email : undefined,
        phone: body.phone === null ? null : typeof body.phone === 'string' ? body.phone : undefined,
        jobTitle: typeof body.jobTitle === 'string' ? body.jobTitle : undefined,
        department: typeof body.department === 'string' ? body.department : undefined,
        employmentType:
          body.employmentType === 'full_time' ||
          body.employmentType === 'part_time' ||
          body.employmentType === 'contract' ||
          body.employmentType === 'casual'
            ? body.employmentType
            : undefined,
        baseSalary: body.baseSalary === undefined ? undefined : asNumber(body.baseSalary, 'baseSalary'),
      }),
    );
  });

  app.post('/api/v1/workforce/employees/:id/terminate', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { endDate?: string; reason?: string };
    return moduleHandler(req, 'hr', 'hotel.hr.manage', async (ctx, db) =>
      workforce.terminateEmployee(db, ctx, id, {
        endDate: need(body.endDate, 'endDate'),
        reason: body.reason,
      }),
    );
  });

  app.get('/api/v1/workforce/shifts', async (req) => {
    const query = req.query as { from?: string; to?: string };
    const from = query.from ?? new Date().toISOString().slice(0, 10);
    const to = query.to ?? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return moduleHandler(req, 'attendance_scheduling', 'hotel.attendance_scheduling.view', async (_ctx, db) => ({
      shifts: await workforce.listShifts(db, `${from}T00:00:00Z`, `${to}T23:59:59Z`),
    }));
  });

  app.post('/api/v1/workforce/shifts', async (req) => {
    const body = (req.body ?? {}) as {
      employeeId?: string;
      startsAt?: string;
      endsAt?: string;
      shiftRole?: string;
      notes?: string;
    };
    return moduleHandler(req, 'attendance_scheduling', 'hotel.attendance_scheduling.manage', async (ctx, db) =>
      workforce.createShift(db, ctx, {
        employeeId: need(body.employeeId, 'employeeId'),
        startsAt: need(body.startsAt, 'startsAt'),
        endsAt: need(body.endsAt, 'endsAt'),
        shiftRole: body.shiftRole,
        notes: body.notes,
      }),
    );
  });

  app.get('/api/v1/workforce/attendance', async (req) => {
    const query = req.query as { employeeId?: string };
    return moduleHandler(req, 'attendance_scheduling', 'hotel.attendance_scheduling.view', async (_ctx, db) => ({
      attendance: await workforce.listAttendance(db, query.employeeId),
    }));
  });

  app.post('/api/v1/workforce/attendance', async (req) => {
    const body = (req.body ?? {}) as {
      employeeId?: string;
      clockIn?: string;
      clockOut?: string;
      shiftId?: string;
      source?: 'manual' | 'mobile' | 'biometric';
      notes?: string;
    };
    return moduleHandler(req, 'attendance_scheduling', 'hotel.attendance_scheduling.manage', async (ctx, db) =>
      workforce.recordAttendance(db, ctx, {
        employeeId: need(body.employeeId, 'employeeId'),
        clockIn: need(body.clockIn, 'clockIn'),
        clockOut: body.clockOut,
        shiftId: body.shiftId,
        source: body.source,
        notes: body.notes,
      }),
    );
  });

  app.get('/api/v1/workforce/payroll-runs', async (req) =>
    moduleHandler(req, 'payroll', 'hotel.payroll.view', async (_ctx, db) => ({
      runs: await workforce.listPayrollRuns(db),
    })),
  );

  app.post('/api/v1/workforce/payroll-runs', async (req) => {
    const body = (req.body ?? {}) as { periodStart?: string; periodEnd?: string; branchId?: string };
    return moduleHandler(req, 'payroll', 'hotel.payroll.manage', async (ctx, db) =>
      workforce.createPayrollRun(db, ctx, {
        periodStart: need(body.periodStart, 'periodStart'),
        periodEnd: need(body.periodEnd, 'periodEnd'),
        branchId: body.branchId,
      }),
    );
  });

  app.get('/api/v1/workforce/payroll-runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'payroll', 'hotel.payroll.view', async (_ctx, db) =>
      workforce.getPayrollRun(db, id),
    );
  });

  app.post('/api/v1/workforce/payroll-runs/:id/post', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'payroll', 'hotel.payroll.manage', async (ctx, db) =>
      workforce.postPayrollRun(db, ctx, id),
    );
  });

  app.post('/api/v1/workforce/payroll-runs/:id/payment', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'payroll', 'hotel.payroll.manage', async (ctx, db) =>
      workforce.payPayrollRun(db, ctx, id),
    );
  });

  // -------------------------------------------------------------------------
  // Fixed assets
  // -------------------------------------------------------------------------
  app.get('/api/v1/assets', async (req) =>
    moduleHandler(req, 'fixed_assets', 'hotel.fixed_assets.view', async (_ctx, db) => ({
      assets: await assetRegister.listAssets(db),
    })),
  );

  app.post('/api/v1/assets', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      assetCode?: string;
      assetName?: string;
      category?: string;
      location?: string;
      acquisitionDate?: string;
      acquisitionCost?: number | string;
      salvageValue?: number | string;
      usefulLifeMonths?: number | string;
      serialNumber?: string;
      capitalise?: boolean;
    };
    return moduleHandler(req, 'fixed_assets', 'hotel.fixed_assets.manage', async (ctx, db) =>
      assetRegister.createAsset(db, ctx, {
        branchId: body.branchId,
        assetCode: need(body.assetCode, 'assetCode'),
        assetName: need(body.assetName, 'assetName'),
        category: need(body.category, 'category'),
        location: body.location,
        acquisitionDate: need(body.acquisitionDate, 'acquisitionDate'),
        acquisitionCost: asNumber(need(body.acquisitionCost, 'acquisitionCost'), 'acquisitionCost'),
        salvageValue:
          body.salvageValue === undefined ? undefined : asNumber(body.salvageValue, 'salvageValue'),
        usefulLifeMonths: asNumber(need(body.usefulLifeMonths, 'usefulLifeMonths'), 'usefulLifeMonths'),
        serialNumber: body.serialNumber,
        capitalise: body.capitalise,
      }),
    );
  });

  app.post('/api/v1/assets/:id/dispose', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { disposedOn?: string; proceeds?: number | string };
    return moduleHandler(req, 'fixed_assets', 'hotel.fixed_assets.manage', async (ctx, db) =>
      assetRegister.disposeAsset(db, ctx, id, {
        disposedOn: need(body.disposedOn, 'disposedOn'),
        proceeds: body.proceeds === undefined ? undefined : asNumber(body.proceeds, 'proceeds'),
      }),
    );
  });

  app.get('/api/v1/assets/depreciation-runs', async (req) =>
    moduleHandler(req, 'fixed_assets', 'hotel.fixed_assets.view', async (_ctx, db) => ({
      runs: await assetRegister.listDepreciationRuns(db),
    })),
  );

  app.post('/api/v1/assets/depreciation-runs', async (req) => {
    const body = (req.body ?? {}) as { periodStart?: string; periodEnd?: string };
    return moduleHandler(req, 'fixed_assets', 'hotel.fixed_assets.manage', async (ctx, db) =>
      assetRegister.createDepreciationRun(db, ctx, {
        periodStart: need(body.periodStart, 'periodStart'),
        periodEnd: need(body.periodEnd, 'periodEnd'),
      }),
    );
  });

  app.get('/api/v1/assets/depreciation-runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'fixed_assets', 'hotel.fixed_assets.view', async (_ctx, db) =>
      assetRegister.getDepreciationRun(db, id),
    );
  });

  app.post('/api/v1/assets/depreciation-runs/:id/post', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'fixed_assets', 'hotel.fixed_assets.manage', async (ctx, db) =>
      assetRegister.postDepreciationRun(db, ctx, id),
    );
  });

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Notifications and communication
  // -------------------------------------------------------------------------
  app.post('/api/v1/notifications/messages', async (req) => {
    const body = (req.body ?? {}) as {
      channel?: string;
      recipient?: string;
      body?: string;
      subject?: string;
      templateCode?: string;
      branchId?: string;
      relatedType?: string;
      relatedId?: string;
    };
    return moduleHandler(req, 'notifications', 'hotel.notifications.send', async (ctx, db) =>
      notif.queueMessage(db, ctx, {
        channel: need(body.channel, 'channel'),
        recipient: need(body.recipient, 'recipient'),
        body: need(body.body, 'body'),
        subject: body.subject,
        templateCode: body.templateCode,
        branchId: body.branchId,
        relatedType: body.relatedType,
        relatedId: body.relatedId,
      }),
    );
  });

  app.get('/api/v1/notifications/messages', async (req) => {
    const query = req.query as { status?: string };
    return moduleHandler(req, 'notifications', 'hotel.notifications.view', async (_ctx, db) => ({
      messages: await notif.listMessages(db, { status: query.status }),
    }));
  });

  // Manual delivery tick. Small deployments without a process manager can use
  // this to drain the queue; the worker entrypoint performs the same sweep
  // across all tenants on a timer.
  app.post('/api/v1/notifications/process', async (req) =>
    tenantHandler(req, async (ctx, db) => {
      requirePermission(ctx, 'hotel.notifications.send');
      await requireModule(ctx, db, 'notifications', 'hotel');
      return notif.processQueuedMessages(ctx.tenantId);
    }),
  );

  app.post('/api/v1/notifications/messages/:id/requeue', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'notifications', 'hotel.notifications.send', async (ctx, db) =>
      notif.requeueMessage(db, ctx, id),
    );
  });

  // -------------------------------------------------------------------------
  // Back office: budget, treasury, laundry, contracts, insurance, quality,
  // utilities, security, documents and training
  // -------------------------------------------------------------------------
  app.get('/api/v1/hotel/budgets', async (req) =>
    moduleHandler(req, 'budget_cost_control', 'hotel.budget_cost_control.view', async (_ctx, db) => ({
      budgets: await backoffice.listBudgets(db),
    })),
  );

  app.post('/api/v1/hotel/budgets', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      fiscalYear?: number | string;
      budgetCode?: string;
      name?: string;
      lines?: Array<{ accountId: string; category: string; costCentre?: string; amount: number | string }>;
    };
    return moduleHandler(req, 'budget_cost_control', 'hotel.budget_cost_control.manage', async (ctx, db) =>
      backoffice.createBudget(db, ctx, {
        branchId: body.branchId,
        fiscalYear: Math.trunc(asNumber(need(body.fiscalYear, 'fiscalYear'), 'fiscalYear')),
        budgetCode: body.budgetCode,
        name: need(body.name, 'name'),
        lines: body.lines?.map((line) => ({
          accountId: need(line.accountId, 'accountId'),
          category: need(line.category, 'category'),
          costCentre: line.costCentre,
          amount: asNumber(need(line.amount, 'amount'), 'amount'),
        })),
      }),
    );
  });

  app.post('/api/v1/hotel/budgets/:id/lines', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      accountId?: string;
      category?: string;
      costCentre?: string;
      amount?: number | string;
    };
    return moduleHandler(req, 'budget_cost_control', 'hotel.budget_cost_control.manage', async (ctx, db) =>
      backoffice.addBudgetLine(db, ctx, id, {
        accountId: need(body.accountId, 'accountId'),
        category: need(body.category, 'category'),
        costCentre: body.costCentre,
        amount: asNumber(need(body.amount, 'amount'), 'amount'),
      }),
    );
  });

  app.post('/api/v1/hotel/budgets/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'budget_cost_control', 'hotel.budget_cost_control.manage', async (ctx, db) =>
      backoffice.approveBudget(db, ctx, id),
    );
  });

  app.post('/api/v1/hotel/budgets/:id/lock', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'budget_cost_control', 'hotel.budget_cost_control.manage', async (ctx, db) =>
      backoffice.lockBudget(db, ctx, id),
    );
  });

  app.get('/api/v1/hotel/budgets/:id/variance', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'budget_cost_control', 'hotel.budget_cost_control.view', async (_ctx, db) =>
      backoffice.budgetVariance(db, id),
    );
  });

  app.get('/api/v1/hotel/treasury/positions', async (req) =>
    moduleHandler(req, 'treasury', 'hotel.treasury.view', async (_ctx, db) => ({
      accounts: await backoffice.treasuryPositions(db),
    })),
  );

  app.get('/api/v1/hotel/treasury/transfers', async (req) =>
    moduleHandler(req, 'treasury', 'hotel.treasury.view', async (_ctx, db) => ({
      transfers: await backoffice.listTreasuryTransfers(db),
    })),
  );

  app.post('/api/v1/hotel/treasury/transfers', async (req) => {
    const body = (req.body ?? {}) as {
      sourceBankAccountId?: string;
      destinationBankAccountId?: string;
      amount?: number | string;
      reference?: string;
      entryDate?: string;
      reason?: string;
    };
    return moduleHandler(req, 'treasury', 'hotel.treasury.manage', async (ctx, db) =>
      backoffice.createTreasuryTransfer(db, ctx, {
        sourceBankAccountId: need(body.sourceBankAccountId, 'sourceBankAccountId'),
        destinationBankAccountId: need(body.destinationBankAccountId, 'destinationBankAccountId'),
        amount: asNumber(need(body.amount, 'amount'), 'amount'),
        reference: need(body.reference, 'reference'),
        entryDate: body.entryDate,
        reason: body.reason,
      }),
    );
  });

  app.get('/api/v1/hotel/laundry', async (req) =>
    moduleHandler(req, 'laundry', 'hotel.laundry.view', async (_ctx, db) => ({
      cycles: await backoffice.listLaundry(db),
    })),
  );

  app.get('/api/v1/hotel/laundry/:id', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'laundry', 'hotel.laundry.view', async (_ctx, db) => backoffice.getLaundry(db, id));
  });

  app.post('/api/v1/hotel/laundry', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      hotelId?: string;
      cycleType?: string;
      scheduledAt?: string;
      notes?: string;
      items?: Array<{
        itemName: string;
        linenCategory?: string;
        quantity: number | string;
        returnedQuantity?: number | string;
        lostQuantity?: number | string;
        damagedQuantity?: number | string;
        notes?: string;
      }>;
    };
    return moduleHandler(req, 'laundry', 'hotel.laundry.manage', async (ctx, db) =>
      backoffice.createLaundry(db, ctx, {
        branchId: body.branchId,
        hotelId: body.hotelId,
        cycleType: need(body.cycleType, 'cycleType'),
        scheduledAt: need(body.scheduledAt, 'scheduledAt'),
        notes: body.notes,
        items: (body.items ?? []).map((item) => ({
          itemName: need(item.itemName, 'itemName'),
          linenCategory: item.linenCategory,
          quantity: asNumber(need(item.quantity, 'quantity'), 'quantity'),
          returnedQuantity: item.returnedQuantity === undefined ? undefined : asNumber(item.returnedQuantity, 'returnedQuantity'),
          lostQuantity: item.lostQuantity === undefined ? undefined : asNumber(item.lostQuantity, 'lostQuantity'),
          damagedQuantity: item.damagedQuantity === undefined ? undefined : asNumber(item.damagedQuantity, 'damagedQuantity'),
          notes: item.notes,
        })),
      }),
    );
  });

  app.post('/api/v1/hotel/laundry/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'laundry', 'hotel.laundry.manage', async (ctx, db) =>
      backoffice.completeLaundry(db, ctx, id),
    );
  });

  app.post('/api/v1/hotel/laundry/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'laundry', 'hotel.laundry.manage', async (ctx, db) =>
      backoffice.cancelLaundry(db, ctx, id),
    );
  });

  app.get('/api/v1/hotel/agreements', async (req) =>
    moduleHandler(req, 'contracts', 'hotel.contracts.view', async (_ctx, db) => ({
      agreements: await backoffice.listAgreements(db),
    })),
  );

  app.post('/api/v1/hotel/agreements', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      agreementCode?: string;
      agreementName?: string;
      agreementType?: string;
      counterparty?: string;
      startDate?: string;
      endDate?: string;
      amount?: number | string;
      terms?: string;
    };
    return moduleHandler(req, 'contracts', 'hotel.contracts.manage', async (ctx, db) =>
      backoffice.createAgreement(db, ctx, {
        branchId: body.branchId,
        agreementCode: body.agreementCode,
        agreementName: need(body.agreementName, 'agreementName'),
        agreementType: need(body.agreementType, 'agreementType'),
        counterparty: need(body.counterparty, 'counterparty'),
        startDate: need(body.startDate, 'startDate'),
        endDate: need(body.endDate, 'endDate'),
        amount: body.amount === undefined ? undefined : asNumber(body.amount, 'amount'),
        terms: body.terms,
      }),
    );
  });

  app.post('/api/v1/hotel/agreements/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: 'active' | 'suspended' | 'expired' | 'terminated' };
    const status = z.enum(['active', 'suspended', 'expired', 'terminated']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'contracts', 'hotel.contracts.manage', async (ctx, db) =>
      backoffice.updateAgreementStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/insurance/policies', async (req) =>
    moduleHandler(req, 'insurance', 'hotel.insurance.view', async (_ctx, db) => ({
      policies: await backoffice.listInsurancePolicies(db),
    })),
  );

  app.post('/api/v1/hotel/insurance/policies', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      insurer?: string;
      policyNumber?: string;
      coverageType?: string;
      startDate?: string;
      endDate?: string;
      premium?: number | string;
      deductible?: number | string;
      coverageDetails?: string;
    };
    return moduleHandler(req, 'insurance', 'hotel.insurance.manage', async (ctx, db) =>
      backoffice.createInsurancePolicy(db, ctx, {
        branchId: body.branchId,
        insurer: need(body.insurer, 'insurer'),
        policyNumber: need(body.policyNumber, 'policyNumber'),
        coverageType: need(body.coverageType, 'coverageType'),
        startDate: need(body.startDate, 'startDate'),
        endDate: need(body.endDate, 'endDate'),
        premium: body.premium === undefined ? undefined : asNumber(body.premium, 'premium'),
        deductible: body.deductible === undefined ? undefined : asNumber(body.deductible, 'deductible'),
        coverageDetails: body.coverageDetails,
      }),
    );
  });

  app.post('/api/v1/hotel/insurance/policies/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['active', 'expired', 'cancelled']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'insurance', 'hotel.insurance.manage', async (ctx, db) =>
      backoffice.updateInsurancePolicyStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/insurance/claims', async (req) => {
    const query = req.query as { policyId?: string };
    return moduleHandler(req, 'insurance', 'hotel.insurance.view', async (_ctx, db) => ({
      claims: await backoffice.listInsuranceClaims(db, query.policyId),
    }));
  });

  app.post('/api/v1/hotel/insurance/claims', async (req) => {
    const body = (req.body ?? {}) as {
      policyId?: string;
      claimNumber?: string;
      incidentDate?: string;
      claimedAmount?: number | string;
      description?: string;
    };
    return moduleHandler(req, 'insurance', 'hotel.insurance.manage', async (ctx, db) =>
      backoffice.createInsuranceClaim(db, ctx, {
        policyId: need(body.policyId, 'policyId'),
        claimNumber: body.claimNumber,
        incidentDate: need(body.incidentDate, 'incidentDate'),
        claimedAmount: asNumber(need(body.claimedAmount, 'claimedAmount'), 'claimedAmount'),
        description: body.description,
      }),
    );
  });

  app.post('/api/v1/hotel/insurance/claims/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      status?: string;
      estimatedRecovery?: number | string;
      paidAmount?: number | string;
    };
    const status = z.enum(['in_review', 'approved', 'paid', 'denied', 'closed']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'insurance', 'hotel.insurance.manage', async (ctx, db) =>
      backoffice.updateInsuranceClaim(db, ctx, id, {
        status,
        estimatedRecovery: body.estimatedRecovery === undefined ? undefined : asNumber(body.estimatedRecovery, 'estimatedRecovery'),
        paidAmount: body.paidAmount === undefined ? undefined : asNumber(body.paidAmount, 'paidAmount'),
      }),
    );
  });

  app.get('/api/v1/hotel/quality/inspections', async (req) =>
    moduleHandler(req, 'quality_assurance', 'hotel.quality_assurance.view', async (_ctx, db) => ({
      inspections: await backoffice.listQualityInspections(db),
    })),
  );

  app.post('/api/v1/hotel/quality/inspections', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      areaName?: string;
      standardName?: string;
      scheduledAt?: string;
      notes?: string;
    };
    return moduleHandler(req, 'quality_assurance', 'hotel.quality_assurance.manage', async (ctx, db) =>
      backoffice.createQualityInspection(db, ctx, {
        branchId: body.branchId,
        areaName: need(body.areaName, 'areaName'),
        standardName: need(body.standardName, 'standardName'),
        scheduledAt: need(body.scheduledAt, 'scheduledAt'),
        notes: body.notes,
      }),
    );
  });

  app.post('/api/v1/hotel/quality/inspections/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { score?: number | string; result?: string; notes?: string };
    return moduleHandler(req, 'quality_assurance', 'hotel.quality_assurance.manage', async (ctx, db) =>
      backoffice.completeQualityInspection(db, ctx, id, {
        score: asNumber(need(body.score, 'score'), 'score'),
        result: z.enum(['pass', 'fail', 'follow_up']).parse(need(body.result, 'result')),
        notes: body.notes,
      }),
    );
  });

  app.get('/api/v1/hotel/quality/actions', async (req) => {
    const query = req.query as { inspectionId?: string };
    return moduleHandler(req, 'quality_assurance', 'hotel.quality_assurance.view', async (_ctx, db) => ({
      actions: await backoffice.listQualityActions(db, query.inspectionId),
    }));
  });

  app.post('/api/v1/hotel/quality/actions', async (req) => {
    const body = (req.body ?? {}) as {
      inspectionId?: string;
      actionText?: string;
      ownerName?: string;
      dueDate?: string;
      estimatedCost?: number | string;
    };
    return moduleHandler(req, 'quality_assurance', 'hotel.quality_assurance.manage', async (ctx, db) =>
      backoffice.createQualityAction(db, ctx, {
        inspectionId: need(body.inspectionId, 'inspectionId'),
        actionText: need(body.actionText, 'actionText'),
        ownerName: body.ownerName,
        dueDate: body.dueDate,
        estimatedCost: body.estimatedCost === undefined ? undefined : asNumber(body.estimatedCost, 'estimatedCost'),
      }),
    );
  });

  app.post('/api/v1/hotel/quality/actions/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['in_progress', 'completed', 'cancelled']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'quality_assurance', 'hotel.quality_assurance.manage', async (ctx, db) =>
      backoffice.updateQualityAction(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/utilities/meters', async (req) =>
    moduleHandler(req, 'utilities', 'hotel.utilities.view', async (_ctx, db) => ({
      meters: await backoffice.listUtilityMeters(db),
    })),
  );

  app.post('/api/v1/hotel/utilities/meters', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      meterCode?: string;
      meterName?: string;
      utilityType?: string;
      location?: string;
      unit?: string;
    };
    return moduleHandler(req, 'utilities', 'hotel.utilities.manage', async (ctx, db) =>
      backoffice.createUtilityMeter(db, ctx, {
        branchId: body.branchId,
        meterCode: body.meterCode,
        meterName: need(body.meterName, 'meterName'),
        utilityType: need(body.utilityType, 'utilityType'),
        location: body.location,
        unit: body.unit,
      }),
    );
  });

  app.get('/api/v1/hotel/utilities/readings', async (req) => {
    const query = req.query as { meterId?: string };
    return moduleHandler(req, 'utilities', 'hotel.utilities.view', async (_ctx, db) => ({
      readings: await backoffice.listUtilityReadings(db, query.meterId),
    }));
  });

  app.post('/api/v1/hotel/utilities/readings', async (req) => {
    const body = (req.body ?? {}) as {
      meterId?: string;
      readingDate?: string;
      openingReading?: number | string;
      closingReading?: number | string;
      unitCost?: number | string;
      notes?: string;
    };
    return moduleHandler(req, 'utilities', 'hotel.utilities.manage', async (ctx, db) =>
      backoffice.createUtilityReading(db, ctx, {
        meterId: need(body.meterId, 'meterId'),
        readingDate: need(body.readingDate, 'readingDate'),
        openingReading: asNumber(need(body.openingReading, 'openingReading'), 'openingReading'),
        closingReading: asNumber(need(body.closingReading, 'closingReading'), 'closingReading'),
        unitCost: body.unitCost === undefined ? undefined : asNumber(body.unitCost, 'unitCost'),
        notes: body.notes,
      }),
    );
  });

  app.get('/api/v1/hotel/utilities/summary', async (req) =>
    moduleHandler(req, 'utilities', 'hotel.utilities.view', async (_ctx, db) => ({
      meters: await backoffice.utilitySummary(db),
    })),
  );

  app.get('/api/v1/hotel/security/incidents', async (req) =>
    moduleHandler(req, 'security_loss_prevention', 'hotel.security_loss_prevention.view', async (_ctx, db) => ({
      incidents: await backoffice.listSecurityIncidents(db),
    })),
  );

  app.post('/api/v1/hotel/security/incidents', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      incidentType?: string;
      severity?: string;
      occurredAt?: string;
      location?: string;
      reporterName?: string;
      description?: string;
    };
    return moduleHandler(req, 'security_loss_prevention', 'hotel.security_loss_prevention.manage', async (ctx, db) =>
      backoffice.createSecurityIncident(db, ctx, {
        branchId: body.branchId,
        incidentType: need(body.incidentType, 'incidentType'),
        severity: body.severity
          ? z.enum(['low', 'medium', 'high', 'critical']).parse(body.severity)
          : undefined,
        occurredAt: need(body.occurredAt, 'occurredAt'),
        location: body.location,
        reporterName: body.reporterName,
        description: need(body.description, 'description'),
      }),
    );
  });

  app.post('/api/v1/hotel/security/incidents/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string; actionTaken?: string };
    const status = z.enum(['monitoring', 'closed']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'security_loss_prevention', 'hotel.security_loss_prevention.manage', async (ctx, db) =>
      backoffice.updateSecurityIncident(db, ctx, id, status, body.actionTaken),
    );
  });

  app.get('/api/v1/hotel/security/patrols', async (req) =>
    moduleHandler(req, 'security_loss_prevention', 'hotel.security_loss_prevention.view', async (_ctx, db) => ({
      patrols: await backoffice.listSecurityPatrols(db),
    })),
  );

  app.post('/api/v1/hotel/security/patrols', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      patrolDate?: string;
      guardName?: string;
      areaName?: string;
      findings?: string;
    };
    return moduleHandler(req, 'security_loss_prevention', 'hotel.security_loss_prevention.manage', async (ctx, db) =>
      backoffice.createSecurityPatrol(db, ctx, {
        branchId: body.branchId,
        patrolDate: need(body.patrolDate, 'patrolDate'),
        guardName: need(body.guardName, 'guardName'),
        areaName: need(body.areaName, 'areaName'),
        findings: body.findings,
      }),
    );
  });

  app.post('/api/v1/hotel/security/patrols/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['in_progress', 'completed', 'missed']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'security_loss_prevention', 'hotel.security_loss_prevention.manage', async (ctx, db) =>
      backoffice.updateSecurityPatrol(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/documents', async (req) =>
    moduleHandler(req, 'documents', 'hotel.documents.view', async (_ctx, db) => ({
      documents: await backoffice.listDocuments(db),
    })),
  );

  app.post('/api/v1/hotel/documents', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      documentCode?: string;
      documentName?: string;
      documentCategory?: string;
      ownerName?: string;
      effectiveDate?: string;
      reviewDate?: string;
      retentionYears?: number | string;
      storageReference?: string;
    };
    return moduleHandler(req, 'documents', 'hotel.documents.manage', async (ctx, db) =>
      backoffice.createDocument(db, ctx, {
        branchId: body.branchId,
        documentCode: body.documentCode,
        documentName: need(body.documentName, 'documentName'),
        documentCategory: need(body.documentCategory, 'documentCategory'),
        ownerName: body.ownerName,
        effectiveDate: body.effectiveDate,
        reviewDate: body.reviewDate,
        retentionYears:
          body.retentionYears === undefined ? undefined : Math.trunc(asNumber(body.retentionYears, 'retentionYears')),
        storageReference: body.storageReference,
      }),
    );
  });

  app.post('/api/v1/hotel/documents/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['active', 'expired', 'archived']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'documents', 'hotel.documents.manage', async (ctx, db) =>
      backoffice.updateDocumentStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/documents/actions', async (req) => {
    const query = req.query as { documentId?: string };
    return moduleHandler(req, 'documents', 'hotel.documents.view', async (_ctx, db) => ({
      actions: await backoffice.listDocumentActions(db, query.documentId),
    }));
  });

  app.post('/api/v1/hotel/documents/actions', async (req) => {
    const body = (req.body ?? {}) as {
      documentId?: string;
      actionText?: string;
      ownerName?: string;
      dueDate?: string;
    };
    return moduleHandler(req, 'documents', 'hotel.documents.manage', async (ctx, db) =>
      backoffice.createDocumentAction(db, ctx, {
        documentId: need(body.documentId, 'documentId'),
        actionText: need(body.actionText, 'actionText'),
        ownerName: body.ownerName,
        dueDate: body.dueDate,
      }),
    );
  });

  app.post('/api/v1/hotel/documents/actions/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['in_progress', 'completed', 'cancelled']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'documents', 'hotel.documents.manage', async (ctx, db) =>
      backoffice.updateDocumentAction(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/training/courses', async (req) =>
    moduleHandler(req, 'training', 'hotel.training.view', async (_ctx, db) => ({
      courses: await backoffice.listTrainingCourses(db),
    })),
  );

  app.post('/api/v1/hotel/training/courses', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      courseCode?: string;
      courseName?: string;
      category?: string;
      provider?: string;
      validityDays?: number | string;
      mandatory?: boolean;
    };
    return moduleHandler(req, 'training', 'hotel.training.manage', async (ctx, db) =>
      backoffice.createTrainingCourse(db, ctx, {
        branchId: body.branchId,
        courseCode: body.courseCode,
        courseName: need(body.courseName, 'courseName'),
        category: body.category,
        provider: body.provider,
        validityDays:
          body.validityDays === undefined ? undefined : Math.trunc(asNumber(body.validityDays, 'validityDays')),
        mandatory: body.mandatory,
      }),
    );
  });

  app.get('/api/v1/hotel/training/enrollments', async (req) => {
    const query = req.query as { employeeId?: string };
    return moduleHandler(req, 'training', 'hotel.training.view', async (_ctx, db) => ({
      enrollments: await backoffice.listTrainingEnrollments(db, query.employeeId),
    }));
  });

  app.post('/api/v1/hotel/training/enrollments', async (req) => {
    const body = (req.body ?? {}) as { courseId?: string; employeeId?: string };
    return moduleHandler(req, 'training', 'hotel.training.manage', async (ctx, db) =>
      backoffice.createTrainingEnrollment(db, ctx, {
        courseId: need(body.courseId, 'courseId'),
        employeeId: need(body.employeeId, 'employeeId'),
      }),
    );
  });

  app.post('/api/v1/hotel/training/enrollments/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { score?: number | string; certificateReference?: string };
    return moduleHandler(req, 'training', 'hotel.training.manage', async (ctx, db) =>
      backoffice.completeTrainingEnrollment(db, ctx, id, {
        score: body.score === undefined ? undefined : asNumber(body.score, 'score'),
        certificateReference: body.certificateReference,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Guest operations: banquets, sales, CRM, channels, revenue, spa, tours,
  // call centre, food safety, corporate billing and franchise standards
  // -------------------------------------------------------------------------
  app.get('/api/v1/hotel/banquets', async (req) =>
    moduleHandler(req, 'banquet_events', 'hotel.banquet_events.view', async (_ctx, db) => ({
      events: await guestops.listBanquets(db),
    })),
  );

  app.post('/api/v1/hotel/banquets', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      hotelId?: string;
      eventCode?: string;
      eventName?: string;
      clientName?: string;
      eventAt?: string;
      expectedPax?: number | string;
      estimatedRevenue?: number | string;
      functionSheet?: string;
    };
    return moduleHandler(req, 'banquet_events', 'hotel.banquet_events.manage', async (ctx, db) =>
      guestops.createBanquet(db, ctx, {
        branchId: body.branchId,
        hotelId: body.hotelId,
        eventCode: body.eventCode,
        eventName: need(body.eventName, 'eventName'),
        clientName: need(body.clientName, 'clientName'),
        eventAt: need(body.eventAt, 'eventAt'),
        expectedPax: body.expectedPax === undefined ? undefined : Math.trunc(asNumber(body.expectedPax, 'expectedPax')),
        estimatedRevenue: body.estimatedRevenue === undefined ? undefined : asNumber(body.estimatedRevenue, 'estimatedRevenue'),
        functionSheet: body.functionSheet,
      }),
    );
  });

  app.post('/api/v1/hotel/banquets/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z
      .enum(['booked', 'confirmed', 'delivered', 'completed', 'cancelled'])
      .parse(need(body.status, 'status'));
    return moduleHandler(req, 'banquet_events', 'hotel.banquet_events.manage', async (ctx, db) =>
      guestops.updateBanquetStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/banquets/:id/charges', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'banquet_events', 'hotel.banquet_events.view', async (_ctx, db) => ({
      charges: await guestops.listBanquetCharges(db, id),
    }));
  });

  app.post('/api/v1/hotel/banquets/:id/charges', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      chargeType?: string;
      description?: string;
      quantity?: number | string;
      unitPrice?: number | string;
    };
    return moduleHandler(req, 'banquet_events', 'hotel.banquet_events.manage', async (ctx, db) =>
      guestops.addBanquetCharge(db, ctx, id, {
        chargeType: need(body.chargeType, 'chargeType'),
        description: need(body.description, 'description'),
        quantity: asNumber(need(body.quantity, 'quantity'), 'quantity'),
        unitPrice: asNumber(need(body.unitPrice, 'unitPrice'), 'unitPrice'),
      }),
    );
  });

  app.get('/api/v1/hotel/sales/campaigns', async (req) =>
    moduleHandler(req, 'sales_marketing', 'hotel.sales_marketing.view', async (_ctx, db) => ({
      campaigns: await guestops.listSalesCampaigns(db),
    })),
  );

  app.post('/api/v1/hotel/sales/campaigns', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      campaignCode?: string;
      campaignName?: string;
      channel?: string;
      budgetAmount?: number | string;
      expectedRevenue?: number | string;
      startsOn?: string;
      endsOn?: string;
    };
    return moduleHandler(req, 'sales_marketing', 'hotel.sales_marketing.manage', async (ctx, db) =>
      guestops.createSalesCampaign(db, ctx, {
        branchId: body.branchId,
        campaignCode: body.campaignCode,
        campaignName: need(body.campaignName, 'campaignName'),
        channel: body.channel,
        budgetAmount: body.budgetAmount === undefined ? undefined : asNumber(body.budgetAmount, 'budgetAmount'),
        expectedRevenue: body.expectedRevenue === undefined ? undefined : asNumber(body.expectedRevenue, 'expectedRevenue'),
        startsOn: body.startsOn,
        endsOn: body.endsOn,
      }),
    );
  });

  app.post('/api/v1/hotel/sales/campaigns/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['active', 'completed', 'cancelled']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'sales_marketing', 'hotel.sales_marketing.manage', async (ctx, db) =>
      guestops.updateSalesCampaignStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/sales/opportunities', async (req) => {
    const query = req.query as { campaignId?: string };
    return moduleHandler(req, 'sales_marketing', 'hotel.sales_marketing.view', async (_ctx, db) => ({
      opportunities: await guestops.listSalesOpportunities(db, query.campaignId),
    }));
  });

  app.post('/api/v1/hotel/sales/opportunities', async (req) => {
    const body = (req.body ?? {}) as {
      campaignId?: string;
      prospectName?: string;
      contactEmail?: string;
      estimatedValue?: number | string;
      probabilityPercent?: number | string;
      expectedCloseDate?: string;
      notes?: string;
    };
    return moduleHandler(req, 'sales_marketing', 'hotel.sales_marketing.manage', async (ctx, db) =>
      guestops.createSalesOpportunity(db, ctx, {
        campaignId: body.campaignId,
        prospectName: need(body.prospectName, 'prospectName'),
        contactEmail: body.contactEmail,
        estimatedValue: body.estimatedValue === undefined ? undefined : asNumber(body.estimatedValue, 'estimatedValue'),
        probabilityPercent:
          body.probabilityPercent === undefined ? undefined : asNumber(body.probabilityPercent, 'probabilityPercent'),
        expectedCloseDate: body.expectedCloseDate,
        notes: body.notes,
      }),
    );
  });

  app.post('/api/v1/hotel/sales/opportunities/:id/stage', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { stage?: string };
    const stage = z
      .enum(['qualified', 'proposal', 'negotiating', 'won', 'lost'])
      .parse(need(body.stage, 'stage'));
    return moduleHandler(req, 'sales_marketing', 'hotel.sales_marketing.manage', async (ctx, db) =>
      guestops.updateSalesOpportunityStage(db, ctx, id, stage),
    );
  });

  app.get('/api/v1/hotel/crm/segments', async (req) =>
    moduleHandler(req, 'crm', 'hotel.crm.view', async (_ctx, db) => ({
      segments: await guestops.listCrmSegments(db),
    })),
  );

  app.post('/api/v1/hotel/crm/segments', async (req) => {
    const body = (req.body ?? {}) as {
      segmentCode?: string;
      segmentName?: string;
      criteria?: Record<string, unknown>;
    };
    return moduleHandler(req, 'crm', 'hotel.crm.manage', async (ctx, db) =>
      guestops.createCrmSegment(db, ctx, {
        segmentCode: body.segmentCode,
        segmentName: need(body.segmentName, 'segmentName'),
        criteria: body.criteria,
      }),
    );
  });

  app.get('/api/v1/hotel/crm/interactions', async (req) => {
    const query = req.query as { guestId?: string };
    return moduleHandler(req, 'crm', 'hotel.crm.view', async (_ctx, db) => ({
      interactions: await guestops.listCrmInteractions(db, query.guestId),
    }));
  });

  app.post('/api/v1/hotel/crm/interactions', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      guestId?: string;
      segmentId?: string;
      customerName?: string;
      interactionType?: string;
      summary?: string;
      satisfactionScore?: number | string;
      followUpDue?: string;
    };
    return moduleHandler(req, 'crm', 'hotel.crm.manage', async (ctx, db) =>
      guestops.createCrmInteraction(db, ctx, {
        branchId: body.branchId,
        guestId: body.guestId,
        segmentId: body.segmentId,
        customerName: body.customerName,
        interactionType: need(body.interactionType, 'interactionType'),
        summary: need(body.summary, 'summary'),
        satisfactionScore:
          body.satisfactionScore === undefined ? undefined : Math.trunc(asNumber(body.satisfactionScore, 'satisfactionScore')),
        followUpDue: body.followUpDue,
      }),
    );
  });

  app.post('/api/v1/hotel/crm/interactions/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'crm', 'hotel.crm.manage', async (ctx, db) =>
      guestops.completeCrmInteraction(db, ctx, id),
    );
  });

  app.get('/api/v1/hotel/channels/inventory', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'channel_management', 'hotel.channel_management.view', async (_ctx, db) => ({
      allocations: await guestops.listChannelInventory(db, query.hotelId),
    }));
  });

  app.post('/api/v1/hotel/channels/inventory', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      roomTypeId?: string;
      channelName?: string;
      allocationDate?: string;
      allocatedUnits?: number | string;
      netRate?: number | string;
    };
    return moduleHandler(req, 'channel_management', 'hotel.channel_management.manage', async (ctx, db) =>
      guestops.createChannelInventory(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        roomTypeId: need(body.roomTypeId, 'roomTypeId'),
        channelName: need(body.channelName, 'channelName'),
        allocationDate: need(body.allocationDate, 'allocationDate'),
        allocatedUnits: Math.trunc(asNumber(need(body.allocatedUnits, 'allocatedUnits'), 'allocatedUnits')),
        netRate: body.netRate === undefined ? undefined : asNumber(body.netRate, 'netRate'),
      }),
    );
  });

  app.post('/api/v1/hotel/channels/inventory/:id/update', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      soldUnits?: number | string;
      netRate?: number | string;
      parityStatus?: string;
    };
    return moduleHandler(req, 'channel_management', 'hotel.channel_management.manage', async (ctx, db) =>
      guestops.updateChannelInventorySold(db, ctx, id, {
        soldUnits: body.soldUnits === undefined ? undefined : Math.trunc(asNumber(body.soldUnits, 'soldUnits')),
        netRate: body.netRate === undefined ? undefined : asNumber(body.netRate, 'netRate'),
        parityStatus: body.parityStatus
          ? z.enum(['matched', 'parity_failed', 'alerted']).parse(body.parityStatus)
          : undefined,
      }),
    );
  });

  app.get('/api/v1/hotel/revenue/forecasts', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'revenue_management', 'hotel.revenue_management.view', async (_ctx, db) => ({
      forecasts: await guestops.listRevenueForecasts(db, query.hotelId),
    }));
  });

  app.get('/api/v1/hotel/revenue/summary', async (req) =>
    moduleHandler(req, 'revenue_management', 'hotel.revenue_management.view', async (_ctx, db) => ({
      hotels: await guestops.revenueSummary(db),
    })),
  );

  app.post('/api/v1/hotel/revenue/forecasts', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      forecastDate?: string;
      occupancyPercent?: number | string;
      adr?: number | string;
      forecastRevenue?: number | string;
      strategy?: string;
    };
    return moduleHandler(req, 'revenue_management', 'hotel.revenue_management.manage', async (ctx, db) =>
      guestops.createRevenueForecast(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        forecastDate: need(body.forecastDate, 'forecastDate'),
        occupancyPercent: asNumber(need(body.occupancyPercent, 'occupancyPercent'), 'occupancyPercent'),
        adr: asNumber(need(body.adr, 'adr'), 'adr'),
        forecastRevenue: asNumber(need(body.forecastRevenue, 'forecastRevenue'), 'forecastRevenue'),
        strategy: body.strategy,
      }),
    );
  });

  app.post('/api/v1/hotel/revenue/forecasts/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'revenue_management', 'hotel.revenue_management.manage', async (ctx, db) =>
      guestops.approveRevenueForecast(db, ctx, id),
    );
  });

  app.get('/api/v1/hotel/spa/resources', async (req) =>
    moduleHandler(req, 'spa_wellness', 'hotel.spa_wellness.view', async (_ctx, db) => ({
      resources: await guestops.listSpaResources(db),
    })),
  );

  app.post('/api/v1/hotel/spa/resources', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      hotelId?: string;
      resourceCode?: string;
      resourceName?: string;
      resourceType?: string;
      capacity?: number | string;
    };
    return moduleHandler(req, 'spa_wellness', 'hotel.spa_wellness.manage', async (ctx, db) =>
      guestops.createSpaResource(db, ctx, {
        branchId: body.branchId,
        hotelId: body.hotelId,
        resourceCode: body.resourceCode,
        resourceName: need(body.resourceName, 'resourceName'),
        resourceType: body.resourceType,
        capacity: body.capacity === undefined ? undefined : Math.trunc(asNumber(body.capacity, 'capacity')),
      }),
    );
  });

  app.get('/api/v1/hotel/spa/bookings', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'spa_wellness', 'hotel.spa_wellness.view', async (_ctx, db) => ({
      bookings: await guestops.listSpaBookings(db, query.hotelId),
    }));
  });

  app.post('/api/v1/hotel/spa/bookings', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      guestId?: string;
      resourceId?: string;
      serviceName?: string;
      startsAt?: string;
      durationMinutes?: number | string;
      price?: number | string;
      notes?: string;
    };
    return moduleHandler(req, 'spa_wellness', 'hotel.spa_wellness.manage', async (ctx, db) =>
      guestops.createSpaBooking(db, ctx, {
        hotelId: body.hotelId,
        guestId: body.guestId,
        resourceId: need(body.resourceId, 'resourceId'),
        serviceName: need(body.serviceName, 'serviceName'),
        startsAt: need(body.startsAt, 'startsAt'),
        durationMinutes:
          body.durationMinutes === undefined ? undefined : Math.trunc(asNumber(body.durationMinutes, 'durationMinutes')),
        price: body.price === undefined ? undefined : asNumber(body.price, 'price'),
        notes: body.notes,
      }),
    );
  });

  app.post('/api/v1/hotel/spa/bookings/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'spa_wellness', 'hotel.spa_wellness.manage', async (ctx, db) =>
      guestops.cancelSpaBooking(db, ctx, id),
    );
  });

  app.get('/api/v1/hotel/tours/packages', async (req) =>
    moduleHandler(req, 'tours_travel', 'hotel.tours_travel.view', async (_ctx, db) => ({
      packages: await guestops.listTourPackages(db),
    })),
  );

  app.post('/api/v1/hotel/tours/packages', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      tourCode?: string;
      tourName?: string;
      destination?: string;
      capacity?: number | string;
      pricePerPerson?: number | string;
    };
    return moduleHandler(req, 'tours_travel', 'hotel.tours_travel.manage', async (ctx, db) =>
      guestops.createTourPackage(db, ctx, {
        branchId: body.branchId,
        tourCode: body.tourCode,
        tourName: need(body.tourName, 'tourName'),
        destination: body.destination,
        capacity: Math.trunc(asNumber(need(body.capacity, 'capacity'), 'capacity')),
        pricePerPerson: body.pricePerPerson === undefined ? undefined : asNumber(body.pricePerPerson, 'pricePerPerson'),
      }),
    );
  });

  app.get('/api/v1/hotel/tours/bookings', async (req) => {
    const query = req.query as { packageId?: string };
    return moduleHandler(req, 'tours_travel', 'hotel.tours_travel.view', async (_ctx, db) => ({
      bookings: await guestops.listTourBookings(db, query.packageId),
    }));
  });

  app.post('/api/v1/hotel/tours/bookings', async (req) => {
    const body = (req.body ?? {}) as {
      packageId?: string;
      departureAt?: string;
      groupName?: string;
      pax?: number | string;
    };
    return moduleHandler(req, 'tours_travel', 'hotel.tours_travel.manage', async (ctx, db) =>
      guestops.createTourBooking(db, ctx, {
        packageId: need(body.packageId, 'packageId'),
        departureAt: need(body.departureAt, 'departureAt'),
        groupName: need(body.groupName, 'groupName'),
        pax: Math.trunc(asNumber(need(body.pax, 'pax'), 'pax')),
      }),
    );
  });

  app.post('/api/v1/hotel/tours/bookings/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'tours_travel', 'hotel.tours_travel.manage', async (ctx, db) =>
      guestops.cancelTourBooking(db, ctx, id),
    );
  });

  app.get('/api/v1/hotel/callcentre/calls', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'central_reservation', 'hotel.central_reservation.view', async (_ctx, db) => ({
      calls: await guestops.listCallLogs(db, query.hotelId),
    }));
  });

  app.post('/api/v1/hotel/callcentre/calls', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      callerName?: string;
      callerPhone?: string;
      callType?: string;
      callAt?: string;
      durationMinutes?: number | string;
      outcome?: string;
      resolution?: string;
    };
    return moduleHandler(req, 'central_reservation', 'hotel.central_reservation.manage', async (ctx, db) =>
      guestops.createCallLog(db, ctx, {
        hotelId: body.hotelId,
        callerName: body.callerName,
        callerPhone: body.callerPhone,
        callType: body.callType,
        callAt: body.callAt,
        durationMinutes:
          body.durationMinutes === undefined ? undefined : asNumber(body.durationMinutes, 'durationMinutes'),
        outcome: need(body.outcome, 'outcome'),
        resolution: body.resolution,
      }),
    );
  });

  app.get('/api/v1/hotel/callcentre/reservations', async (req) => {
    const query = req.query as { hotelId?: string };
    return moduleHandler(req, 'central_reservation', 'hotel.central_reservation.view', async (_ctx, db) => ({
      reservations: await guestops.listCentralReservations(db, query.hotelId),
    }));
  });

  app.post('/api/v1/hotel/callcentre/reservations', async (req) => {
    const body = (req.body ?? {}) as {
      hotelId?: string;
      bookingReference?: string;
      guestId?: string;
      channel?: string;
      arrivalDate?: string;
      departureDate?: string;
      amount?: number | string;
    };
    return moduleHandler(req, 'central_reservation', 'hotel.central_reservation.manage', async (ctx, db) =>
      guestops.createCentralReservation(db, ctx, {
        hotelId: need(body.hotelId, 'hotelId'),
        bookingReference: body.bookingReference,
        guestId: body.guestId,
        channel: body.channel,
        arrivalDate: need(body.arrivalDate, 'arrivalDate'),
        departureDate: need(body.departureDate, 'departureDate'),
        amount: body.amount === undefined ? undefined : asNumber(body.amount, 'amount'),
      }),
    );
  });

  app.post('/api/v1/hotel/callcentre/reservations/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['confirmed', 'cancelled', 'converted']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'central_reservation', 'hotel.central_reservation.manage', async (ctx, db) =>
      guestops.updateCentralReservationStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/foodsafety/checks', async (req) =>
    moduleHandler(req, 'food_safety', 'hotel.food_safety.view', async (_ctx, db) => ({
      checks: await guestops.listFoodSafetyChecks(db),
    })),
  );

  app.post('/api/v1/hotel/foodsafety/checks', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      areaName?: string;
      checkType?: string;
      scheduledAt?: string;
      correctiveAction?: string;
    };
    return moduleHandler(req, 'food_safety', 'hotel.food_safety.manage', async (ctx, db) =>
      guestops.createFoodSafetyCheck(db, ctx, {
        branchId: body.branchId,
        areaName: need(body.areaName, 'areaName'),
        checkType: need(body.checkType, 'checkType'),
        scheduledAt: need(body.scheduledAt, 'scheduledAt'),
        correctiveAction: body.correctiveAction,
      }),
    );
  });

  app.post('/api/v1/hotel/foodsafety/checks/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { result?: string; correctiveAction?: string };
    return moduleHandler(req, 'food_safety', 'hotel.food_safety.manage', async (ctx, db) =>
      guestops.completeFoodSafetyCheck(db, ctx, id, {
        result: z.enum(['pass', 'fail']).parse(need(body.result, 'result')),
        correctiveAction: body.correctiveAction,
      }),
    );
  });

  app.get('/api/v1/hotel/foodsafety/logs', async (req) => {
    const query = req.query as { checkId?: string };
    return moduleHandler(req, 'food_safety', 'hotel.food_safety.view', async (_ctx, db) => ({
      logs: await guestops.listFoodSafetyLogs(db, query.checkId),
    }));
  });

  app.post('/api/v1/hotel/foodsafety/logs', async (req) => {
    const body = (req.body ?? {}) as {
      checkId?: string;
      logType?: string;
      reading?: number | string;
      unit?: string;
      status?: string;
      notes?: string;
    };
    return moduleHandler(req, 'food_safety', 'hotel.food_safety.manage', async (ctx, db) =>
      guestops.createFoodSafetyLog(db, ctx, {
        checkId: need(body.checkId, 'checkId'),
        logType: need(body.logType, 'logType'),
        reading: body.reading === undefined ? undefined : asNumber(body.reading, 'reading'),
        unit: body.unit,
        status: body.status ? z.enum(['pass', 'fail']).parse(body.status) : undefined,
        notes: body.notes,
      }),
    );
  });

  app.get('/api/v1/hotel/corporate/accounts', async (req) =>
    moduleHandler(req, 'guest_credit', 'hotel.guest_credit.view', async (_ctx, db) => ({
      accounts: await guestops.listCorporateAccounts(db),
    })),
  );

  app.post('/api/v1/hotel/corporate/accounts', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      accountCode?: string;
      accountName?: string;
      billingEmail?: string;
      creditLimit?: number | string;
      priority?: string;
    };
    return moduleHandler(req, 'guest_credit', 'hotel.guest_credit.manage', async (ctx, db) =>
      guestops.createCorporateAccount(db, ctx, {
        branchId: body.branchId,
        accountCode: body.accountCode,
        accountName: need(body.accountName, 'accountName'),
        billingEmail: body.billingEmail,
        creditLimit: body.creditLimit === undefined ? undefined : asNumber(body.creditLimit, 'creditLimit'),
        priority: body.priority ? z.enum(['standard', 'premium']).parse(body.priority) : undefined,
      }),
    );
  });

  app.post('/api/v1/hotel/corporate/accounts/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['suspended', 'closed', 'active']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'guest_credit', 'hotel.guest_credit.manage', async (ctx, db) =>
      guestops.updateCorporateAccountStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/hotel/corporate/invoices', async (req) => {
    const query = req.query as { accountId?: string };
    return moduleHandler(req, 'guest_credit', 'hotel.guest_credit.view', async (_ctx, db) => ({
      invoices: await guestops.listCorporateInvoices(db, query.accountId),
    }));
  });

  app.post('/api/v1/hotel/corporate/invoices', async (req) => {
    const body = (req.body ?? {}) as {
      corporateAccountId?: string;
      invoiceNumber?: string;
      issueDate?: string;
      dueDate?: string;
      amount?: number | string;
    };
    return moduleHandler(req, 'guest_credit', 'hotel.guest_credit.manage', async (ctx, db) =>
      guestops.createCorporateInvoice(db, ctx, {
        corporateAccountId: need(body.corporateAccountId, 'corporateAccountId'),
        invoiceNumber: body.invoiceNumber,
        issueDate: need(body.issueDate, 'issueDate'),
        dueDate: need(body.dueDate, 'dueDate'),
        amount: asNumber(need(body.amount, 'amount'), 'amount'),
      }),
    );
  });

  app.post('/api/v1/hotel/corporate/invoices/:id/pay', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { amount?: number | string; paymentDate?: string };
    return moduleHandler(req, 'guest_credit', 'hotel.guest_credit.manage', async (ctx, db) =>
      guestops.payCorporateInvoice(db, ctx, id, {
        amount: asNumber(need(body.amount, 'amount'), 'amount'),
        paymentDate: body.paymentDate,
      }),
    );
  });

  app.get('/api/v1/hotel/franchise/standards', async (req) =>
    moduleHandler(req, 'franchise', 'hotel.franchise.view', async (_ctx, db) => ({
      standards: await guestops.listFranchiseStandards(db),
    })),
  );

  app.post('/api/v1/hotel/franchise/standards', async (req) => {
    const body = (req.body ?? {}) as {
      standardCode?: string;
      standardName?: string;
      category?: string;
      description?: string;
      mandatory?: boolean;
    };
    return moduleHandler(req, 'franchise', 'hotel.franchise.manage', async (ctx, db) =>
      guestops.createFranchiseStandard(db, ctx, {
        standardCode: body.standardCode,
        standardName: need(body.standardName, 'standardName'),
        category: need(body.category, 'category'),
        description: body.description,
        mandatory: body.mandatory,
      }),
    );
  });

  app.get('/api/v1/hotel/franchise/audits', async (req) => {
    const query = req.query as { standardId?: string };
    return moduleHandler(req, 'franchise', 'hotel.franchise.view', async (_ctx, db) => ({
      audits: await guestops.listFranchiseAudits(db, query.standardId),
    }));
  });

  app.post('/api/v1/hotel/franchise/audits', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      standardId?: string;
      auditDate?: string;
      auditor?: string;
      findings?: string;
    };
    return moduleHandler(req, 'franchise', 'hotel.franchise.manage', async (ctx, db) =>
      guestops.createFranchiseAudit(db, ctx, {
        branchId: body.branchId,
        standardId: need(body.standardId, 'standardId'),
        auditDate: need(body.auditDate, 'auditDate'),
        auditor: body.auditor,
        findings: body.findings,
      }),
    );
  });

  app.post('/api/v1/hotel/franchise/audits/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { score?: number | string; findings?: string };
    return moduleHandler(req, 'franchise', 'hotel.franchise.manage', async (ctx, db) =>
      guestops.completeFranchiseAudit(db, ctx, id, {
        score: asNumber(need(body.score, 'score'), 'score'),
        findings: body.findings,
      }),
    );
  });

  app.get('/api/v1/hotel/franchise/actions', async (req) => {
    const query = req.query as { auditId?: string };
    return moduleHandler(req, 'franchise', 'hotel.franchise.view', async (_ctx, db) => ({
      actions: await guestops.listFranchiseActions(db, query.auditId),
    }));
  });

  app.post('/api/v1/hotel/franchise/actions', async (req) => {
    const body = (req.body ?? {}) as {
      auditId?: string;
      actionText?: string;
      ownerName?: string;
      dueDate?: string;
      estimatedCost?: number | string;
    };
    return moduleHandler(req, 'franchise', 'hotel.franchise.manage', async (ctx, db) =>
      guestops.createFranchiseAction(db, ctx, {
        auditId: need(body.auditId, 'auditId'),
        actionText: need(body.actionText, 'actionText'),
        ownerName: body.ownerName,
        dueDate: body.dueDate,
        estimatedCost: body.estimatedCost === undefined ? undefined : asNumber(body.estimatedCost, 'estimatedCost'),
      }),
    );
  });

  app.post('/api/v1/hotel/franchise/actions/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['in_progress', 'completed', 'cancelled']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'franchise', 'hotel.franchise.manage', async (ctx, db) =>
      guestops.updateFranchiseAction(db, ctx, id, status),
    );
  });

  // -------------------------------------------------------------------------
  // External Channel Manager (OTA/GDS connectivity)
  // -------------------------------------------------------------------------
  app.get('/api/v1/hotel/channel/providers', async (req) =>
    moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listProviders(db, ctx),
    ),
  );

  app.post('/api/v1/hotel/channel/providers', async (req) => {
    const body = (req.body ?? {}) as {
      providerCode?: string;
      providerName?: string;
      apiEndpoint?: string;
      authType?: string;
      authConfig?: Record<string, unknown>;
      isActive?: boolean;
      defaultCommissionPercent?: number | string;
      defaultCurrency?: string;
      timeoutMs?: number | string;
      retryPolicy?: Record<string, unknown>;
    };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.createProvider(db, ctx, {
        providerCode: need(body.providerCode, 'providerCode'),
        providerName: need(body.providerName, 'providerName'),
        apiEndpoint: need(body.apiEndpoint, 'apiEndpoint'),
        authType: body.authType,
        authConfig: body.authConfig,
        isActive: body.isActive,
        defaultCommissionPercent:
          body.defaultCommissionPercent === undefined ? undefined : asNumber(body.defaultCommissionPercent, 'defaultCommissionPercent'),
        defaultCurrency: body.defaultCurrency,
        timeoutMs: body.timeoutMs === undefined ? undefined : Math.trunc(asNumber(body.timeoutMs, 'timeoutMs')),
        retryPolicy: body.retryPolicy,
      }),
    );
  });

  app.post('/api/v1/hotel/channel/providers/:id/deactivate', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.deactivateProvider(db, ctx, id),
    );
  });

  app.get('/api/v1/hotel/channel/mappings', async (req) => {
    const query = req.query as { hotelId?: string; roomTypeId?: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listChannelMappings(db, ctx, query.hotelId, query.roomTypeId),
    );
  });

  app.post('/api/v1/hotel/channel/mappings', async (req) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      hotelId?: string;
      roomTypeId?: string;
      providerRoomCode?: string;
      providerRatePlanCode?: string;
      isActive?: boolean;
      overrides?: Record<string, unknown>;
    };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.createChannelMapping(db, ctx, {
        providerId: need(body.providerId, 'providerId'),
        hotelId: need(body.hotelId, 'hotelId'),
        roomTypeId: need(body.roomTypeId, 'roomTypeId'),
        providerRoomCode: need(body.providerRoomCode, 'providerRoomCode'),
        providerRatePlanCode: body.providerRatePlanCode,
        isActive: body.isActive,
        overrides: body.overrides,
      }),
    );
  });

  app.get('/api/v1/hotel/channel/ari-queue', async (req) => {
    const query = req.query as { status?: string; providerId?: string; hotelId?: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listAriQueue(db, ctx, {
        status: query.status,
        providerId: query.providerId,
        hotelId: query.hotelId,
      }),
    );
  });

  app.post('/api/v1/hotel/channel/ari-queue', async (req) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      hotelId?: string;
      roomTypeId?: string;
      startDate?: string;
      endDate?: string;
      operation?: 'availability' | 'rates' | 'restrictions' | 'all';
      payload?: Record<string, unknown>;
    };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.enqueueAriPush(db, ctx, {
        providerId: need(body.providerId, 'providerId'),
        hotelId: need(body.hotelId, 'hotelId'),
        roomTypeId: need(body.roomTypeId, 'roomTypeId'),
        startDate: need(body.startDate, 'startDate'),
        endDate: need(body.endDate, 'endDate'),
        operation: body.operation,
        payload: body.payload,
      }),
    );
  });

  app.post('/api/v1/hotel/channel/ari-queue/:id/process', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.processAriQueue(db, ctx, id),
    );
  });

  app.post('/api/v1/hotel/channel/ari-queue/sweep', async (req) => {
    const body = (req.body ?? {}) as { providerId?: string; hotelId?: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.runAriSyncSweep(db, ctx, body),
    );
  });

  app.get('/api/v1/hotel/channel/reservation-imports', async (req) => {
    const query = req.query as { status?: string; providerId?: string; hotelId?: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listReservationImports(db, ctx, {
        status: query.status,
        providerId: query.providerId,
        hotelId: query.hotelId,
      }),
    );
  });

  app.post('/api/v1/hotel/channel/reservation-imports', async (req) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      hotelId?: string;
      externalReservationId?: string;
      externalConfirmationCode?: string;
      status?: 'imported' | 'mapped' | 'created' | 'failed' | 'duplicate';
      rawPayload?: Record<string, unknown>;
      mappedData?: Record<string, unknown>;
      localReservationId?: string;
      errorMessage?: string;
    };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.createReservationImport(db, ctx, {
        providerId: need(body.providerId, 'providerId'),
        hotelId: need(body.hotelId, 'hotelId'),
        externalReservationId: need(body.externalReservationId, 'externalReservationId'),
        externalConfirmationCode: body.externalConfirmationCode,
        status: body.status,
        rawPayload: body.rawPayload,
        mappedData: body.mappedData,
        localReservationId: body.localReservationId,
        errorMessage: body.errorMessage,
      }),
    );
  });

  app.get('/api/v1/hotel/channel/rate-parity', async (req) => {
    const query = req.query as { status?: string; providerId?: string; hotelId?: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listRateParityChecks(db, ctx, {
        status: query.status,
        providerId: query.providerId,
        hotelId: query.hotelId,
      }),
    );
  });

  app.post('/api/v1/hotel/channel/rate-parity', async (req) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      hotelId?: string;
      roomTypeId?: string;
      checkDate?: string;
      localRate?: number | string;
      channelRate?: number | string;
      currency?: string;
      parityStatus?: 'matched' | 'parity_failed' | 'alerted' | 'under_cut';
      variancePercent?: number | string;
    };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.runRateParityCheck(db, ctx, {
        providerId: need(body.providerId, 'providerId'),
        hotelId: need(body.hotelId, 'hotelId'),
        roomTypeId: need(body.roomTypeId, 'roomTypeId'),
        checkDate: need(body.checkDate, 'checkDate'),
        localRate: asNumber(need(body.localRate, 'localRate'), 'localRate'),
        channelRate: asNumber(need(body.channelRate, 'channelRate'), 'channelRate'),
        currency: body.currency,
        parityStatus: body.parityStatus,
        variancePercent:
          body.variancePercent === undefined ? undefined : asNumber(body.variancePercent, 'variancePercent'),
      }),
    );
  });

  app.get('/api/v1/hotel/channel/commissions', async (req) => {
    const query = req.query as { status?: string; providerId?: string; hotelId?: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listCommissions(db, ctx, {
        status: query.status,
        providerId: query.providerId,
        hotelId: query.hotelId,
      }),
    );
  });

  app.post('/api/v1/hotel/channel/commissions', async (req) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      hotelId?: string;
      reservationId?: string;
      externalReservationId?: string;
      stayDate?: string;
      roomNights?: number | string;
      grossAmount?: number | string;
      commissionPercent?: number | string;
      netAmount?: number | string;
      currency?: string;
      status?: 'accrued' | 'invoiced' | 'paid' | 'disputed';
      periodStart?: string;
      periodEnd?: string;
    };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.createCommission(db, ctx, {
        providerId: need(body.providerId, 'providerId'),
        hotelId: need(body.hotelId, 'hotelId'),
        reservationId: body.reservationId,
        externalReservationId: body.externalReservationId,
        stayDate: need(body.stayDate, 'stayDate'),
        roomNights: Math.trunc(asNumber(need(body.roomNights, 'roomNights'), 'roomNights')),
        grossAmount: asNumber(need(body.grossAmount, 'grossAmount'), 'grossAmount'),
        commissionPercent: asNumber(need(body.commissionPercent, 'commissionPercent'), 'commissionPercent'),
        netAmount: asNumber(need(body.netAmount, 'netAmount'), 'netAmount'),
        currency: body.currency,
        status: body.status,
        periodStart: need(body.periodStart, 'periodStart'),
        periodEnd: need(body.periodEnd, 'periodEnd'),
      }),
    );
  });

  app.get('/api/v1/hotel/channel/provider-health', async (req) =>
    moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listProviderHealth(db, ctx),
    ),
  );

  app.post('/api/v1/hotel/channel/provider-health', async (req) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      checkType?: 'connectivity' | 'auth' | 'ari_push' | 'reservation_pull' | 'rate_parity';
      status?: 'healthy' | 'degraded' | 'down' | 'unknown';
      responseTimeMs?: number | string;
      errorMessage?: string;
      details?: Record<string, unknown>;
    };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.manage', async (ctx, db) =>
      channelManager.recordProviderHealth(db, ctx, {
        providerId: need(body.providerId, 'providerId'),
        checkType: z
          .enum(['connectivity', 'auth', 'ari_push', 'reservation_pull', 'rate_parity'])
          .parse(need(body.checkType, 'checkType')),
        status: z.enum(['healthy', 'degraded', 'down', 'unknown']).parse(need(body.status, 'status')),
        responseTimeMs:
          body.responseTimeMs === undefined ? undefined : Math.trunc(asNumber(body.responseTimeMs, 'responseTimeMs')),
        errorMessage: body.errorMessage,
        details: body.details,
      }),
    );
  });

  app.get('/api/v1/hotel/channel/sync-log', async (req) => {
    const query = req.query as { status?: string; operation?: string };
    return moduleHandler(req, 'channel_connector', 'hotel.channel_connector.view', async (ctx, db) =>
      channelManager.listSyncLog(db, ctx, {
        status: query.status,
        operation: query.operation,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Restaurant operations: reservations, waitlist, customers, loyalty and
  // promotions, recipe costing; bar events and ticket bookings
  // -------------------------------------------------------------------------
  app.get('/api/v1/restaurant/reservations', async (req) => {
    const query = req.query as { outletId?: string; date?: string };
    return moduleHandler(req, 'reservations', 'restaurant.reservations.view', async (_ctx, db) => ({
      reservations: await productops.listReservations(db, query.outletId, query.date),
    }));
  });

  app.post('/api/v1/restaurant/reservations', async (req) => {
    const body = (req.body ?? {}) as {
      outletId?: string;
      tableId?: string;
      customerName?: string;
      customerPhone?: string;
      partySize?: number | string;
      reservationAt?: string;
      durationMinutes?: number | string;
      notes?: string;
    };
    return moduleHandler(req, 'reservations', 'restaurant.reservations.manage', async (ctx, db) =>
      productops.createReservation(db, ctx, {
        outletId: need(body.outletId, 'outletId'),
        tableId: body.tableId,
        customerName: need(body.customerName, 'customerName'),
        customerPhone: body.customerPhone,
        partySize: Math.trunc(asNumber(need(body.partySize, 'partySize'), 'partySize')),
        reservationAt: need(body.reservationAt, 'reservationAt'),
        durationMinutes:
          body.durationMinutes === undefined ? undefined : Math.trunc(asNumber(body.durationMinutes, 'durationMinutes')),
        notes: body.notes,
      }),
    );
  });

  app.post('/api/v1/restaurant/reservations/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['seated', 'completed', 'cancelled', 'no_show']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'reservations', 'restaurant.reservations.manage', async (ctx, db) =>
      productops.updateReservationStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/restaurant/waitlist', async (req) => {
    const query = req.query as { outletId?: string };
    return moduleHandler(req, 'reservations', 'restaurant.reservations.view', async (_ctx, db) => ({
      waitlist: await productops.listWaitlist(db, query.outletId),
    }));
  });

  app.post('/api/v1/restaurant/waitlist', async (req) => {
    const body = (req.body ?? {}) as {
      outletId?: string;
      customerName?: string;
      customerPhone?: string;
      partySize?: number | string;
      quotedMinutes?: number | string;
    };
    return moduleHandler(req, 'reservations', 'restaurant.reservations.manage', async (ctx, db) =>
      productops.addToWaitlist(db, ctx, {
        outletId: need(body.outletId, 'outletId'),
        customerName: need(body.customerName, 'customerName'),
        customerPhone: body.customerPhone,
        partySize: Math.trunc(asNumber(need(body.partySize, 'partySize'), 'partySize')),
        quotedMinutes:
          body.quotedMinutes === undefined ? undefined : Math.trunc(asNumber(body.quotedMinutes, 'quotedMinutes')),
      }),
    );
  });

  app.post('/api/v1/restaurant/waitlist/:id/seat', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'reservations', 'restaurant.reservations.manage', async (ctx, db) =>
      productops.seatWaitlist(db, ctx, id),
    );
  });

  app.post('/api/v1/restaurant/waitlist/:id/abandon', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'reservations', 'restaurant.reservations.manage', async (ctx, db) =>
      productops.abandonWaitlist(db, ctx, id),
    );
  });

  app.get('/api/v1/restaurant/customers', async (req) => {
    const query = req.query as { search?: string };
    return moduleHandler(req, 'customers', 'restaurant.customers.view', async (_ctx, db) => ({
      customers: await productops.listCustomers(db, query.search),
    }));
  });

  app.post('/api/v1/restaurant/customers', async (req) => {
    const body = (req.body ?? {}) as {
      branchId?: string;
      customerCode?: string;
      fullName?: string;
      email?: string;
      phone?: string;
      segment?: string;
      marketingConsent?: boolean;
    };
    return moduleHandler(req, 'customers', 'restaurant.customers.manage', async (ctx, db) =>
      productops.createCustomer(db, ctx, {
        branchId: body.branchId,
        customerCode: body.customerCode,
        fullName: need(body.fullName, 'fullName'),
        email: body.email,
        phone: body.phone,
        segment: body.segment
          ? z.enum(['general', 'frequent', 'vip', 'corporate', 'resident']).parse(body.segment)
          : undefined,
        marketingConsent: body.marketingConsent,
      }),
    );
  });

  app.post('/api/v1/restaurant/customers/:id/segment', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { segment?: string };
    const segment = z
      .enum(['general', 'frequent', 'vip', 'corporate', 'resident'])
      .parse(need(body.segment, 'segment'));
    return moduleHandler(req, 'customers', 'restaurant.customers.manage', async (ctx, db) =>
      productops.updateCustomerSegment(db, ctx, id, segment),
    );
  });

  app.get('/api/v1/restaurant/customers/:id/loyalty', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'loyalty', 'restaurant.loyalty.view', async (_ctx, db) =>
      productops.loyaltyBalance(db, id),
    );
  });

  app.post('/api/v1/restaurant/customers/:id/loyalty/earn', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { points?: number | string; reference?: string };
    return moduleHandler(req, 'loyalty', 'restaurant.loyalty.manage', async (ctx, db) =>
      productops.earnLoyaltyPoints(db, ctx, id, {
        points: Math.trunc(asNumber(need(body.points, 'points'), 'points')),
        reference: body.reference,
      }),
    );
  });

  app.post('/api/v1/restaurant/customers/:id/loyalty/redeem', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { points?: number | string; reference?: string };
    return moduleHandler(req, 'loyalty', 'restaurant.loyalty.manage', async (ctx, db) =>
      productops.redeemLoyaltyPoints(db, ctx, id, {
        points: Math.trunc(asNumber(need(body.points, 'points'), 'points')),
        reference: body.reference,
      }),
    );
  });

  app.get('/api/v1/restaurant/promotions', async (req) =>
    moduleHandler(req, 'loyalty', 'restaurant.loyalty.view', async (_ctx, db) => ({
      promotions: await productops.listPromotions(db),
    })),
  );

  app.post('/api/v1/restaurant/promotions', async (req) => {
    const body = (req.body ?? {}) as {
      promoCode?: string;
      promoName?: string;
      promotionType?: string;
      discountPercent?: number | string;
      fixedDiscount?: number | string;
      minimumSubtotal?: number | string;
      startsAt?: string;
      endsAt?: string;
    };
    return moduleHandler(req, 'loyalty', 'restaurant.loyalty.manage', async (ctx, db) =>
      productops.createPromotion(db, ctx, {
        promoCode: need(body.promoCode, 'promoCode'),
        promoName: need(body.promoName, 'promoName'),
        promotionType: body.promotionType,
        discountPercent:
          body.discountPercent === undefined ? undefined : asNumber(body.discountPercent, 'discountPercent'),
        fixedDiscount: body.fixedDiscount === undefined ? undefined : asNumber(body.fixedDiscount, 'fixedDiscount'),
        minimumSubtotal:
          body.minimumSubtotal === undefined ? undefined : asNumber(body.minimumSubtotal, 'minimumSubtotal'),
        startsAt: need(body.startsAt, 'startsAt'),
        endsAt: need(body.endsAt, 'endsAt'),
      }),
    );
  });

  app.post('/api/v1/restaurant/promotions/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z.enum(['active', 'inactive', 'expired']).parse(need(body.status, 'status'));
    return moduleHandler(req, 'loyalty', 'restaurant.loyalty.manage', async (ctx, db) =>
      productops.updatePromotionStatus(db, ctx, id, status),
    );
  });

  app.post('/api/v1/restaurant/promotions/quote', async (req) => {
    const body = (req.body ?? {}) as { promoCode?: string; subtotal?: number | string };
    return moduleHandler(req, 'loyalty', 'restaurant.loyalty.view', async (_ctx, db) =>
      productops.quotePromotion(
        db,
        need(body.promoCode, 'promoCode'),
        asNumber(need(body.subtotal, 'subtotal'), 'subtotal'),
      ),
    );
  });

  app.get('/api/v1/restaurant/food-cost', async (req) => {
    const query = req.query as { outletId?: string };
    return moduleHandler(req, 'recipes', 'restaurant.recipes.view', async (_ctx, db) =>
      productops.foodCostReport(db, query.outletId),
    );
  });

  app.get('/api/v1/bar/events', async (req) => {
    const query = req.query as { barId?: string };
    return moduleHandler(req, 'events', 'bar.events.view', async (_ctx, db) => ({
      events: await productops.listBarEvents(db, query.barId),
    }));
  });

  app.post('/api/v1/bar/events', async (req) => {
    const body = (req.body ?? {}) as {
      barId?: string;
      eventName?: string;
      eventDate?: string;
      startsAt?: string;
      capacity?: number | string;
      ticketPrice?: number | string;
      description?: string;
    };
    return moduleHandler(req, 'events', 'bar.events.manage', async (ctx, db) =>
      productops.createBarEvent(db, ctx, {
        barId: need(body.barId, 'barId'),
        eventName: need(body.eventName, 'eventName'),
        eventDate: need(body.eventDate, 'eventDate'),
        startsAt: body.startsAt,
        capacity: body.capacity === undefined ? undefined : Math.trunc(asNumber(body.capacity, 'capacity')),
        ticketPrice: body.ticketPrice === undefined ? undefined : asNumber(body.ticketPrice, 'ticketPrice'),
        description: body.description,
      }),
    );
  });

  app.post('/api/v1/bar/events/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = z
      .enum(['on_sale', 'sold_out', 'completed', 'cancelled'])
      .parse(need(body.status, 'status'));
    return moduleHandler(req, 'events', 'bar.events.manage', async (ctx, db) =>
      productops.updateBarEventStatus(db, ctx, id, status),
    );
  });

  app.get('/api/v1/bar/events/bookings', async (req) => {
    const query = req.query as { eventId?: string };
    return moduleHandler(req, 'events', 'bar.events.view', async (_ctx, db) => ({
      bookings: await productops.listBarEventBookings(db, query.eventId),
    }));
  });

  app.post('/api/v1/bar/events/:id/bookings', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      customerName?: string;
      seats?: number | string;
      ticketPrice?: number | string;
    };
    return moduleHandler(req, 'events', 'bar.events.manage', async (ctx, db) =>
      productops.createBarEventBooking(db, ctx, id, {
        customerName: need(body.customerName, 'customerName'),
        seats: Math.trunc(asNumber(need(body.seats, 'seats'), 'seats')),
        ticketPrice: body.ticketPrice === undefined ? undefined : asNumber(body.ticketPrice, 'ticketPrice'),
      }),
    );
  });

  app.post('/api/v1/bar/events/bookings/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return moduleHandler(req, 'events', 'bar.events.manage', async (ctx, db) =>
      productops.cancelBarEventBooking(db, ctx, id),
    );
  });

  for (const provider of ['paystack', 'flutterwave'] as const) {
    app.post(
      `/api/v1/webhooks/${provider}`,
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const raw = (req as FastifyRequest & { rawBody?: string }).rawBody;
        if (!raw) throw badRequest('Raw body unavailable for signature verification');
        const result = await payments.handleWebhook(provider, raw, req.headers);
        return reply.status(result.httpStatus).send(result.body);
      },
    );
  }
}

export { tenantHandler, moduleHandler, need, asNumber };
