-- 015: row level security and runtime grants.
--
-- Tenant isolation is enforced by the database, not only by application code.
-- Every table carrying a tenant_id gets a policy comparing it to the session
-- variable app.tenant_id, which the API sets per transaction. The runtime role is
-- NOT the table owner, so RLS always applies to it.

DO $$
DECLARE
  r record;
  v_tenant_tables text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_schema IN (
        'platform', 'identity', 'access', 'licensing', 'hotel', 'housekeeping',
        'maintenance', 'restaurant', 'bar', 'inventory', 'procurement', 'finance',
        'payments', 'notification', 'integration', 'audit', 'mobile', 'workforce', 'reporting'
      )
    ORDER BY c.table_schema, c.table_name
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I '
      'USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      r.table_schema, r.table_name
    );
    v_tenant_tables := v_tenant_tables || format('%I.%I', r.table_schema, r.table_name);
  END LOOP;
  RAISE NOTICE 'Enabled tenant isolation on % tenant scoped tables', array_length(v_tenant_tables, 1);
END;
$$;

-- Security invoker views must not leak across tenants either; views over
-- tenant-scoped tables inherit the underlying RLS automatically.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hospitality_app') THEN
    RAISE EXCEPTION
      'Runtime role hospitality_app does not exist. Run scripts/db-bootstrap.mjs (npm run db:setup) before applying migration 015.';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA platform, identity, access, licensing, hotel, housekeeping,
  maintenance, restaurant, bar, inventory, procurement, finance, payments,
  workforce, integration, notification, audit, reporting, mobile, public
  TO hospitality_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform, identity, access,
  licensing, hotel, housekeeping, maintenance, restaurant, bar, inventory, procurement,
  finance, payments, workforce, integration, notification, audit, reporting, mobile
  TO hospitality_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform, identity, access, licensing,
  hotel, housekeeping, maintenance, restaurant, bar, inventory, procurement, finance,
  payments, workforce, integration, notification, audit, reporting, mobile
  TO hospitality_app;

-- Reference catalogues are read-only for the runtime role.
REVOKE INSERT, UPDATE, DELETE ON access.permissions FROM hospitality_app;
REVOKE INSERT, UPDATE, DELETE ON licensing.product_catalogue FROM hospitality_app;
REVOKE INSERT, UPDATE, DELETE ON licensing.module_catalogue FROM hospitality_app;
REVOKE INSERT, UPDATE, DELETE ON licensing.module_dependencies FROM hospitality_app;
GRANT SELECT ON access.permissions, licensing.product_catalogue,
  licensing.module_catalogue, licensing.module_dependencies TO hospitality_app;

-- Append-only ledgers: no UPDATE or DELETE privileges at all, on top of the
-- rejection triggers.
REVOKE UPDATE, DELETE ON audit.events FROM hospitality_app;
REVOKE UPDATE, DELETE ON hotel.folio_entries FROM hospitality_app;
REVOKE UPDATE, DELETE ON inventory.movements FROM hospitality_app;
REVOKE UPDATE, DELETE ON finance.journal_lines FROM hospitality_app;
REVOKE UPDATE, DELETE ON licensing.license_events FROM hospitality_app;

GRANT EXECUTE ON FUNCTION licensing_is_module_licensed(uuid, text) TO hospitality_app;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO hospitality_app;
GRANT EXECUTE ON FUNCTION app_next_document_number(uuid, text, text) TO hospitality_app;
GRANT EXECUTE ON FUNCTION app_emit_event(uuid, text, text, text, jsonb) TO hospitality_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform, identity, access, licensing, hotel,
  housekeeping, maintenance, restaurant, bar, inventory, procurement, finance,
  payments, workforce, integration, notification, audit, reporting, mobile
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hospitality_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, identity, access, licensing, hotel,
  housekeeping, maintenance, restaurant, bar, inventory, procurement, finance,
  payments, workforce, integration, notification, audit, reporting, mobile
  GRANT USAGE, SELECT ON SEQUENCES TO hospitality_app;
