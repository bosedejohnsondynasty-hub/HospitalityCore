import pg from 'pg';
import { config } from './config.js';

export type Queryable = Pick<pg.PoolClient, 'query'>;

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.NODE_ENV === 'test' ? 5 : 20,
  idleTimeoutMillis: 30_000,
  application_name: 'hospitality-core-api',
});

/** Admin connection, used only for first-run provisioning and maintenance. */
let adminPool: pg.Pool | undefined;
export function getAdminPool(): pg.Pool {
  if (!config.DATABASE_ADMIN_URL) {
    throw new Error('DATABASE_ADMIN_URL is not configured');
  }
  adminPool ??= new pg.Pool({
    connectionString: config.DATABASE_ADMIN_URL,
    max: 2,
    application_name: 'hospitality-core-admin',
  });
  return adminPool;
}

/**
 * Runs a unit of work in a transaction with the tenant context set.
 *
 * app.tenant_id drives row level security; every query outside a privileged
 * SECURITY DEFINER lookup must run through this helper so the database, not the
 * application, enforces tenant isolation.
 */
export async function withTenant<T>(
  tenantId: string | null,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only helper for lookups that intentionally run without tenant context. */
export async function withScopedLookup<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Verifies the runtime connection is not a superuser or table owner, because
 * either would bypass row level security silently.
 */
export async function verifyDatabaseSecurity(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns_tables: boolean;
    }>(`
      SELECT current_user,
        (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls,
        EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'hotel' AND tableowner = current_user
        ) AS owns_tables
    `);
    const row = rows[0];
    if (!row) throw new Error('Unable to determine database role');
    const unsafe = row.rolsuper || row.rolbypassrls || row.owns_tables;
    if (unsafe && config.REQUIRE_RESTRICTED_DB_ROLE) {
      throw new Error(
        `Refusing to start: database role "${row.current_user}" can bypass row level security ` +
          '(superuser, BYPASSRLS or table owner). Configure DATABASE_URL with the restricted ' +
          'runtime role, or set REQUIRE_RESTRICTED_DB_ROLE=false only for a deliberate maintenance window.',
      );
    }
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await pool.end().catch(() => {});
  await adminPool?.end().catch(() => {});
}
