-- 019: remove residual destructive privileges on financial ledger tables.
--
-- finance.journal_entries legitimately allows UPDATE for the posted -> reversed
-- transition, but DELETE was left granted by the blanket table grant in 015.
-- Posted journals must only ever be reversed by a new entry. TRUNCATE is also
-- removed from every append-only ledger table.

REVOKE DELETE ON finance.journal_entries FROM hospitality_app;
REVOKE TRUNCATE ON finance.journal_entries FROM hospitality_app;
REVOKE TRUNCATE ON finance.journal_lines FROM hospitality_app;
REVOKE TRUNCATE ON hotel.folio_entries FROM hospitality_app;
REVOKE TRUNCATE ON inventory.movements FROM hospitality_app;
REVOKE TRUNCATE ON audit.events FROM hospitality_app;
REVOKE TRUNCATE ON licensing.license_events FROM hospitality_app;

-- Fail loudly if a destructive privilege survives on an append-only table.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT table_schema || '.' || table_name || ':' || privilege_type, ', ')
    INTO offenders
    FROM information_schema.role_table_grants
   WHERE grantee = 'hospitality_app'
     AND (
       (privilege_type IN ('DELETE', 'TRUNCATE') AND table_schema || '.' || table_name IN (
         'finance.journal_entries', 'finance.journal_lines', 'hotel.folio_entries',
         'inventory.movements', 'audit.events', 'licensing.license_events'))
       OR
       (privilege_type = 'UPDATE' AND table_schema || '.' || table_name IN (
         'finance.journal_lines', 'hotel.folio_entries', 'inventory.movements',
         'audit.events', 'licensing.license_events'))
     );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Destructive privileges remain for hospitality_app: %', offenders;
  END IF;
END
$$;
