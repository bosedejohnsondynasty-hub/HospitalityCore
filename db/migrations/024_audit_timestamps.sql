-- 024: audit timestamp backfill.
--
-- Master AI Builder v2.5, Part IV §8 requires every business record to carry
-- created_at and updated_at (and app-level created_by/updated_by). Migrations
-- 001-023 added created_at/updated_at to the tables written first, but 136 of
-- 168 tables had drifted: the whole backoffice and guestops surface, the bar and
-- restaurant modules, parts of hotel/maintenance, and several line tables never
-- received them, and none of the new mutable tables had the app_touch_updated_at
-- trigger used elsewhere. That left concurrency checks and audit reconstruction
-- impossible for those domains.
--
-- This migration is additive and idempotent:
--   * created_at is added with DEFAULT now(); existing rows are backfilled with
--     the migration timestamp (the true creation time was never recorded, and
--     inventing one would be worse than stating this).
--   * updated_at is added the same way and maintained by the shared
--     app_touch_updated_at() trigger.
--   * Append-only / immutable tables (posted folio entries, journal lines,
--     stock movements, audit events, licence events, the loyalty ledger,
--     webhook receipts) get the columns for uniform reads but deliberately no
--     touch trigger: their UPDATE is revoked at grant level, so a trigger would
--     never fire and would imply mutability that does not exist.

DO $$
DECLARE
  target record;
  immutable text[] := ARRAY[
    'hotel.folio_entries',
    'finance.journal_lines',
    'inventory.movements',
    'audit.events',
    'licensing.license_events',
    'restaurant.loyalty_ledger',
    'payments.webhook_events'
  ];
  qualified text;
BEGIN
  FOR target IN
    SELECT t.table_schema, t.table_name
    FROM information_schema.tables t
    WHERE t.table_type = 'BASE TABLE'
      AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND t.table_schema NOT LIKE 'pg_%'
      AND NOT (t.table_schema = 'public' AND t.table_name IN ('migrations', 'platform_schema_migrations'))
    ORDER BY t.table_schema, t.table_name
  LOOP
    qualified := format('%I.%I', target.table_schema, target.table_name);

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = target.table_schema
        AND table_name = target.table_name
        AND column_name = 'created_at'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()',
        qualified
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = target.table_schema
        AND table_name = target.table_name
        AND column_name = 'updated_at'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()',
        qualified
      );
    END IF;

    IF qualified = ANY (immutable) THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE NOT tg.tgisinternal
        AND n.nspname = target.table_schema
        AND c.relname = target.table_name
        AND p.proname = 'app_touch_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at()',
        target.table_name || '_touch',
        qualified
      );
    END IF;
  END LOOP;
END $$;
