#!/usr/bin/env node
/**
 * Structural integrity checks for a Hospitality Core database.
 * Run against the admin connection: node scripts/verify-db.mjs
 */
import 'dotenv/config';
import pg from 'pg';

const connectionString = process.env.DATABASE_ADMIN_URL;
if (!connectionString) {
  console.error('DATABASE_ADMIN_URL is required');
  process.exit(2);
}

const client = new pg.Client({ connectionString });
await client.connect();

let failures = 0;
const check = async (name, sql, assertion) => {
  const { rows } = await client.query(sql);
  const result = assertion(rows);
  if (result === true) {
    console.log(`ok    ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}: ${JSON.stringify(rows)}`);
  }
};

await check(
  'migration history is complete',
  'SELECT count(*)::int AS n FROM public.platform_schema_migrations',
  (rows) => rows[0].n >= 20,
);
await check(
  'seed catalogue has 3 products, 73 modules and 217 permissions',
  `SELECT (SELECT count(*) FROM licensing.product_catalogue)::int AS products,
          (SELECT count(*) FROM licensing.module_catalogue)::int AS modules,
          (SELECT count(*) FROM access.permissions)::int AS permissions`,
  (rows) => rows[0].products === 3 && rows[0].modules === 73 && rows[0].permissions === 217,
);
await check(
  'row level security is enabled on tenant tables',
  `SELECT n.nspname || '.' || c.relname AS t
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('hotel','restaurant','bar','inventory','finance','payments','licensing','identity','access','mobile','housekeeping','maintenance','procurement','audit','notification','integration','workforce','assets')
      AND c.relkind = 'r' AND c.relrowsecurity IS FALSE
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
         WHERE col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'tenant_id'
      )`,
  (rows) => rows.length === 0,
);
await check(
  'no application view bypasses RLS',
  `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v' AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND NOT coalesce(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)`,
  (rows) => rows.length === 0,
);
await check(
  'runtime role cannot update or delete ledger tables',
  `SELECT table_schema || '.' || table_name AS t
     FROM information_schema.role_table_grants
    WHERE grantee = 'hospitality_app'
      AND (
        (privilege_type = 'DELETE' AND table_schema || '.' || table_name IN (
          'audit.events','hotel.folio_entries','inventory.movements',
          'finance.journal_lines','finance.journal_entries','licensing.license_events',
          'workforce.payslips','assets.depreciation_entries'))
        OR
        (privilege_type = 'UPDATE' AND table_schema || '.' || table_name IN (
          'audit.events','hotel.folio_entries','inventory.movements',
          'finance.journal_lines','licensing.license_events',
          'workforce.payslips','assets.depreciation_entries'))
      )`,
  (rows) => rows.length === 0,
);
await check(
  'room overlap exclusion constraint exists',
  `SELECT conname FROM pg_constraint WHERE conname = 'room_allocations_no_overlap'`,
  (rows) => rows.length === 1,
);
await check(
  'posting link uniqueness exists',
  `SELECT indexname FROM pg_indexes
    WHERE schemaname = 'finance' AND tablename = 'posting_links'
      AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%source_type%'`,
  (rows) => rows.length >= 1,
);
await check(
  'posted journals are balanced',
  `SELECT count(*)::int AS n FROM (
     SELECT e.id FROM finance.journal_entries e
       JOIN finance.journal_lines l ON l.entry_id = e.id
      WHERE e.status = 'posted'
      GROUP BY e.id HAVING round(sum(l.debit), 4) <> round(sum(l.credit), 4)
   ) x`,
  (rows) => rows[0].n === 0,
);
await check(
  'payroll totals reconcile with payslips',
  `SELECT count(*)::int AS n FROM (
     SELECT r.id FROM workforce.payroll_runs r
       JOIN workforce.payslips p ON p.run_id = r.id
      GROUP BY r.id
     HAVING round(sum(p.gross), 4) <> r.gross_total
         OR round(sum(p.paye), 4) <> r.paye_total
         OR round(sum(p.pension_employee + p.pension_employer), 4) <> r.pension_total
         OR round(sum(p.net), 4) <> r.net_total
   ) x`,
  (rows) => rows[0].n === 0,
);
await check(
  'asset accumulated depreciation stays within the depreciable base',
  `SELECT count(*)::int AS n FROM assets.fixed_assets
    WHERE accumulated_depreciation < 0
       OR accumulated_depreciation > acquisition_cost - salvage_value`,
  (rows) => rows[0].n === 0,
);
await check(
  'no orphaned composite tenant references in folios',
  `SELECT count(*)::int AS n FROM hotel.folios f
     LEFT JOIN hotel.stays s ON s.tenant_id = f.tenant_id AND s.id = f.stay_id
    WHERE f.stay_id IS NOT NULL AND s.id IS NULL`,
  (rows) => rows[0].n === 0,
);

await client.end();
if (failures > 0) {
  console.error(`\n${failures} integrity check(s) failed`);
  process.exit(1);
}
console.log('\nAll database integrity checks passed');
