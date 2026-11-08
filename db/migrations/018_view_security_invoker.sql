-- 018: make every application view RLS-aware.
--
-- PostgreSQL views run with the privileges of their owner by default, which
-- silently bypasses row level security for the runtime role. Reporting views
-- such as finance.trial_balance would then aggregate every tenant's ledger.
-- security_invoker makes the caller's policies apply.

DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT n.nspname AS schema_name, c.relname AS view_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'v'
       AND n.nspname IN (
         'platform', 'identity', 'access', 'licensing', 'hotel', 'housekeeping',
         'maintenance', 'restaurant', 'bar', 'inventory', 'procurement', 'finance',
         'payments', 'mobile', 'integration', 'notification', 'reporting', 'audit'
       )
  LOOP
    EXECUTE format('ALTER VIEW %I.%I SET (security_invoker = true)', v.schema_name, v.view_name);
  END LOOP;
END
$$;

-- Fail the migration if any application view still bypasses RLS.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
    INTO offenders
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'v'
     AND n.nspname IN (
       'platform', 'identity', 'access', 'licensing', 'hotel', 'housekeeping',
       'maintenance', 'restaurant', 'bar', 'inventory', 'procurement', 'finance',
       'payments', 'mobile', 'integration', 'notification', 'reporting', 'audit'
     )
     AND NOT coalesce((c.reloptions::text[] @> ARRAY['security_invoker=true']), false);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Views still bypass row level security: %', offenders;
  END IF;
END
$$;
