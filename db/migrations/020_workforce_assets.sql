-- 020: workforce and fixed assets.
--
-- Both domains are tenant scoped and use composite foreign keys on
-- (tenant_id, id) so a row can never reference another tenant's employee,
-- branch or asset. Payroll and depreciation are financial documents: their
-- posted values are immutable and every posting goes through finance.posting_links
-- (source_type + purpose), so a run can only hit the ledger once.

CREATE SCHEMA IF NOT EXISTS assets;

-- Contra-asset accounts (accumulated depreciation) carry a credit normal
-- balance while remaining asset class. The original check only allowed
-- debit-normal assets, so widen it deliberately for that case.
ALTER TABLE finance.accounts DROP CONSTRAINT accounts_balance_check;
ALTER TABLE finance.accounts ADD CONSTRAINT accounts_balance_check CHECK (
  (account_class IN ('asset', 'expense') AND normal_balance = 'debit')
  OR (account_class IN ('liability', 'equity', 'revenue') AND normal_balance = 'credit')
  OR (account_class = 'asset' AND normal_balance = 'credit')
);

-- ---------------------------------------------------------------------------
-- Workforce
-- ---------------------------------------------------------------------------

CREATE TABLE workforce.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  employee_number varchar(30) NOT NULL,
  full_name varchar(180) NOT NULL,
  email varchar(254),
  phone varchar(40),
  job_title varchar(120) NOT NULL,
  department varchar(80) NOT NULL,
  employment_type text NOT NULL DEFAULT 'full_time',
  hire_date date NOT NULL,
  end_date date,
  base_salary numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT employees_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT employees_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT employees_number_key UNIQUE (tenant_id, employee_number),
  CONSTRAINT employees_type_check CHECK (
    employment_type IN ('full_time', 'part_time', 'contract', 'casual')
  ),
  CONSTRAINT employees_status_check CHECK (
    status IN ('active', 'suspended', 'terminated')
  ),
  CONSTRAINT employees_salary_check CHECK (base_salary >= 0),
  CONSTRAINT employees_dates_check CHECK (end_date IS NULL OR end_date >= hire_date)
);
CREATE INDEX idx_employees_branch ON workforce.employees (tenant_id, branch_id, status);

CREATE TABLE workforce.shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  shift_role varchar(120),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shifts_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT shifts_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES workforce.employees (tenant_id, id),
  CONSTRAINT shifts_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT shifts_range_check CHECK (ends_at > starts_at),
  CONSTRAINT shifts_status_check CHECK (
    status IN ('scheduled', 'completed', 'absent', 'cancelled')
  ),
  -- One employee cannot be rostered twice over the same period.
  CONSTRAINT shifts_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('scheduled', 'completed'))
);
CREATE INDEX idx_shifts_window ON workforce.shifts (tenant_id, starts_at, ends_at);

CREATE TABLE workforce.attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  shift_id uuid,
  clock_in timestamptz NOT NULL,
  clock_out timestamptz,
  source text NOT NULL DEFAULT 'manual',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES workforce.employees (tenant_id, id),
  CONSTRAINT attendance_shift_fk FOREIGN KEY (tenant_id, shift_id)
    REFERENCES workforce.shifts (tenant_id, id),
  CONSTRAINT attendance_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT attendance_range_check CHECK (clock_out IS NULL OR clock_out > clock_in),
  CONSTRAINT attendance_source_check CHECK (source IN ('manual', 'mobile', 'biometric'))
);
CREATE INDEX idx_attendance_employee ON workforce.attendance (tenant_id, employee_id, clock_in DESC);

CREATE TABLE workforce.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  run_number varchar(40) NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  gross_total numeric(18,4) NOT NULL DEFAULT 0,
  paye_total numeric(18,4) NOT NULL DEFAULT 0,
  pension_total numeric(18,4) NOT NULL DEFAULT 0,
  net_total numeric(18,4) NOT NULL DEFAULT 0,
  journal_entry_id uuid,
  payment_journal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  paid_at timestamptz,
  CONSTRAINT payroll_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT payroll_journal_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT payroll_payment_fk FOREIGN KEY (tenant_id, payment_journal_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT payroll_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT payroll_number_key UNIQUE (tenant_id, run_number),
  CONSTRAINT payroll_range_check CHECK (period_end >= period_start),
  CONSTRAINT payroll_status_check CHECK (status IN ('draft', 'posted', 'paid')),
  CONSTRAINT payroll_totals_check CHECK (
    gross_total >= 0 AND paye_total >= 0 AND pension_total >= 0 AND net_total >= 0
  )
);
CREATE UNIQUE INDEX payroll_period_key
  ON workforce.payroll_runs (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start, period_end);

CREATE TABLE workforce.payslips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  gross numeric(18,4) NOT NULL,
  paye numeric(18,4) NOT NULL,
  pension_employee numeric(18,4) NOT NULL,
  pension_employer numeric(18,4) NOT NULL,
  net numeric(18,4) NOT NULL,
  CONSTRAINT payslips_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES workforce.payroll_runs (tenant_id, id),
  CONSTRAINT payslips_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES workforce.employees (tenant_id, id),
  CONSTRAINT payslips_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT payslips_run_employee_key UNIQUE (tenant_id, run_id, employee_id),
  CONSTRAINT payslips_amounts_check CHECK (
    gross >= 0 AND paye >= 0 AND pension_employee >= 0 AND pension_employer >= 0 AND net >= 0
  )
);

-- Posted payroll runs may only move to paid; the money columns are frozen.
CREATE OR REPLACE FUNCTION workforce_payroll_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted', 'paid') THEN
    IF NEW.gross_total <> OLD.gross_total
       OR NEW.paye_total <> OLD.paye_total
       OR NEW.pension_total <> OLD.pension_total
       OR NEW.net_total <> OLD.net_total
       OR NEW.period_start <> OLD.period_start
       OR NEW.period_end <> OLD.period_end
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
      RAISE EXCEPTION 'Payroll run % is posted and immutable', OLD.run_number
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payroll_run_guard
  BEFORE UPDATE ON workforce.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION workforce_payroll_run_guard();

CREATE OR REPLACE FUNCTION workforce_payroll_run_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Posted payroll runs cannot be deleted; reverse the journal instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_payroll_run_no_delete
  BEFORE DELETE ON workforce.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION workforce_payroll_run_no_delete();

-- ---------------------------------------------------------------------------
-- Fixed assets
-- ---------------------------------------------------------------------------

CREATE TABLE assets.fixed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  asset_code varchar(30) NOT NULL,
  asset_name varchar(180) NOT NULL,
  category varchar(80) NOT NULL,
  location varchar(120),
  acquisition_date date NOT NULL,
  acquisition_cost numeric(18,4) NOT NULL,
  salvage_value numeric(18,4) NOT NULL DEFAULT 0,
  useful_life_months integer NOT NULL,
  accumulated_depreciation numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  serial_number varchar(120),
  disposed_on date,
  disposal_proceeds numeric(18,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT assets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT assets_code_key UNIQUE (tenant_id, asset_code),
  CONSTRAINT assets_cost_check CHECK (acquisition_cost > 0),
  CONSTRAINT assets_salvage_check CHECK (salvage_value >= 0 AND salvage_value <= acquisition_cost),
  CONSTRAINT assets_life_check CHECK (useful_life_months BETWEEN 1 AND 600),
  CONSTRAINT assets_accumulated_check CHECK (
    accumulated_depreciation >= 0
    AND accumulated_depreciation <= acquisition_cost - salvage_value
  ),
  CONSTRAINT assets_accumulated_precision_check CHECK (
    accumulated_depreciation = round(accumulated_depreciation, 4)
  ),
  CONSTRAINT assets_status_check CHECK (status IN ('active', 'fully_depreciated', 'disposed')),
  CONSTRAINT assets_disposal_check CHECK (
    (status = 'disposed' AND disposed_on IS NOT NULL)
    OR (status <> 'disposed' AND disposed_on IS NULL)
  )
);
CREATE INDEX idx_assets_branch ON assets.fixed_assets (tenant_id, branch_id, status);

CREATE TABLE assets.depreciation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_number varchar(40) NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  total_amount numeric(18,4) NOT NULL DEFAULT 0,
  journal_entry_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  CONSTRAINT depreciation_journal_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT depreciation_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT depreciation_number_key UNIQUE (tenant_id, run_number),
  CONSTRAINT depreciation_range_check CHECK (period_end >= period_start),
  CONSTRAINT depreciation_status_check CHECK (status IN ('draft', 'posted')),
  CONSTRAINT depreciation_total_check CHECK (total_amount >= 0),
  CONSTRAINT depreciation_period_key UNIQUE (tenant_id, period_start, period_end)
);

CREATE TABLE assets.depreciation_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  amount numeric(18,4) NOT NULL,
  CONSTRAINT depreciation_entries_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES assets.depreciation_runs (tenant_id, id),
  CONSTRAINT depreciation_entries_asset_fk FOREIGN KEY (tenant_id, asset_id)
    REFERENCES assets.fixed_assets (tenant_id, id),
  CONSTRAINT depreciation_entries_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT depreciation_entries_key UNIQUE (tenant_id, run_id, asset_id),
  CONSTRAINT depreciation_entries_amount_check CHECK (amount > 0)
);

CREATE OR REPLACE FUNCTION assets_depreciation_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Depreciation run % is posted and immutable', OLD.run_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_depreciation_run_guard
  BEFORE UPDATE ON assets.depreciation_runs
  FOR EACH ROW EXECUTE FUNCTION assets_depreciation_run_guard();

-- ---------------------------------------------------------------------------
-- Ledger accounts for the new domains (existing tenants included).
-- ---------------------------------------------------------------------------

INSERT INTO finance.accounts
  (tenant_id, organization_id, account_code, account_name, account_class, normal_balance, currency_code)
SELECT o.tenant_id, o.id, v.code, v.name, v.class, v.normal, 'NGN'
FROM platform.organizations o
CROSS JOIN (VALUES
  ('1510', 'Accumulated Depreciation', 'asset', 'credit'),
  ('2300', 'Salaries Payable', 'liability', 'credit'),
  ('4400', 'Gain on Disposal', 'revenue', 'credit'),
  ('6600', 'Depreciation Expense', 'expense', 'debit'),
  ('6700', 'Loss on Disposal', 'expense', 'debit')
) AS v(code, name, class, normal)
ON CONFLICT (tenant_id, organization_id, account_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS and runtime grants for the new tables.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_schema IN ('workforce', 'assets')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I '
      'USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      r.table_schema, r.table_name
    );
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA workforce, assets TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA workforce, assets TO hospitality_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA workforce, assets TO hospitality_app;

-- Payroll payslips and depreciation documents are append-only once written.
REVOKE UPDATE, DELETE ON workforce.payslips FROM hospitality_app;
REVOKE UPDATE, DELETE ON assets.depreciation_entries FROM hospitality_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA workforce, assets
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hospitality_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA workforce, assets
  GRANT USAGE, SELECT ON SEQUENCES TO hospitality_app;
