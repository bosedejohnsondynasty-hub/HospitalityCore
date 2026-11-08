-- 012: financial accounting - chart of accounts, periods, journal and the
--      exactly-once posting links used by product integrations.

CREATE TABLE finance.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  account_code varchar(30) NOT NULL,
  account_name varchar(180) NOT NULL,
  account_class text NOT NULL,
  normal_balance text NOT NULL,
  parent_id uuid,
  is_postable boolean NOT NULL DEFAULT true,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES platform.organizations (tenant_id, id),
  CONSTRAINT accounts_parent_fk FOREIGN KEY (tenant_id, parent_id)
    REFERENCES finance.accounts (tenant_id, id),
  CONSTRAINT accounts_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT accounts_code_key UNIQUE (tenant_id, organization_id, account_code),
  CONSTRAINT accounts_class_check CHECK (
    account_class IN ('asset', 'liability', 'equity', 'revenue', 'expense')
  ),
  CONSTRAINT accounts_balance_check CHECK (
    (account_class IN ('asset', 'expense') AND normal_balance = 'debit')
    OR (account_class IN ('liability', 'equity', 'revenue') AND normal_balance = 'credit')
  )
);

CREATE TABLE finance.fiscal_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  period_code varchar(20) NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  closed_by uuid,
  closed_at timestamptz,
  CONSTRAINT periods_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES platform.organizations (tenant_id, id),
  CONSTRAINT periods_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT periods_code_key UNIQUE (tenant_id, organization_id, period_code),
  CONSTRAINT periods_range_check CHECK (ends_on >= starts_on),
  CONSTRAINT periods_status_check CHECK (status IN ('open', 'closed', 'locked'))
);

CREATE TABLE finance.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid,
  entry_number varchar(40) NOT NULL,
  entry_date date NOT NULL,
  period_id uuid NOT NULL,
  description text NOT NULL,
  source_type text,
  source_id text,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'draft',
  posted_by uuid,
  posted_at timestamptz,
  reverses_entry_id uuid,
  reversed_by_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entries_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES platform.organizations (tenant_id, id),
  CONSTRAINT entries_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT entries_period_fk FOREIGN KEY (tenant_id, period_id)
    REFERENCES finance.fiscal_periods (tenant_id, id),
  CONSTRAINT entries_reverses_fk FOREIGN KEY (tenant_id, reverses_entry_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT entries_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT entries_number_key UNIQUE (tenant_id, entry_number),
  CONSTRAINT entries_status_check CHECK (status IN ('draft', 'posted', 'reversed', 'void'))
);
CREATE INDEX idx_entries_source ON finance.journal_entries (tenant_id, source_type, source_id);

CREATE TABLE finance.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_number integer NOT NULL,
  account_id uuid NOT NULL,
  debit numeric(18,4) NOT NULL DEFAULT 0,
  credit numeric(18,4) NOT NULL DEFAULT 0,
  description text,
  cost_centre varchar(80),
  CONSTRAINT lines_entry_fk FOREIGN KEY (tenant_id, entry_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT lines_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES finance.accounts (tenant_id, id),
  CONSTRAINT lines_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT lines_line_key UNIQUE (tenant_id, entry_id, line_number),
  CONSTRAINT lines_amount_check CHECK (
    debit >= 0 AND credit >= 0 AND ((debit = 0 AND credit > 0) OR (credit = 0 AND debit > 0))
  )
);
CREATE INDEX idx_lines_account ON finance.journal_lines (tenant_id, account_id);

-- Exactly-once posting: a business document can create at most one journal entry
-- per purpose (revenue, settlement, refund, ...). This is what prevents
-- integration paths from recognising the same revenue twice.
CREATE TABLE finance.posting_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  purpose text NOT NULL,
  journal_entry_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posting_links_entry_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT posting_links_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT posting_links_unique UNIQUE (tenant_id, source_type, source_id, purpose)
);

CREATE TABLE finance.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  account_name varchar(150) NOT NULL,
  bank_name varchar(150) NOT NULL,
  account_number varchar(40) NOT NULL,
  gl_account_id uuid NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT bank_accounts_gl_fk FOREIGN KEY (tenant_id, gl_account_id)
    REFERENCES finance.accounts (tenant_id, id),
  CONSTRAINT bank_accounts_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bank_accounts_number_key UNIQUE (tenant_id, bank_name, account_number)
);

-- --- Integrity: period control, balanced postings, immutable posted records ---

CREATE OR REPLACE FUNCTION finance_assert_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_start date;
  v_end date;
BEGIN
  SELECT status, starts_on, ends_on INTO v_status, v_start, v_end
  FROM finance.fiscal_periods WHERE id = NEW.period_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Fiscal period % does not exist', NEW.period_id;
  END IF;
  IF NEW.entry_date < v_start OR NEW.entry_date > v_end THEN
    RAISE EXCEPTION 'Entry date % is outside fiscal period % (% to %)',
      NEW.entry_date, NEW.period_id, v_start, v_end USING ERRCODE = 'check_violation';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'Fiscal period % is %; posting is not allowed', NEW.period_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER entries_period_open BEFORE INSERT ON finance.journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance_assert_period_open();

CREATE OR REPLACE FUNCTION finance_assert_entry_balanced(p_entry_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_debit numeric(18,4);
  v_credit numeric(18,4);
  v_lines integer;
BEGIN
  SELECT status INTO v_status FROM finance.journal_entries WHERE id = p_entry_id;
  IF v_status IS DISTINCT FROM 'posted' THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
  INTO v_debit, v_credit, v_lines
  FROM finance.journal_lines WHERE entry_id = p_entry_id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'Journal entry % must have at least two lines', p_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debit % <> credit %', p_entry_id, v_debit, v_credit
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_debit = 0 THEN
    RAISE EXCEPTION 'Journal entry % has zero value', p_entry_id USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION finance_check_balance_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM finance_assert_entry_balanced(coalesce(NEW.entry_id, OLD.entry_id));
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON finance.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_check_balance_trigger();

CREATE OR REPLACE FUNCTION finance_guard_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Journal entries cannot be deleted; reverse the entry instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'posted' THEN
    IF NEW.status NOT IN ('posted', 'reversed') THEN
      RAISE EXCEPTION 'Posted journal entry % can only become reversed', OLD.entry_number
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF (to_jsonb(NEW) - 'status' - 'reversed_by_entry_id')
       <> (to_jsonb(OLD) - 'status' - 'reversed_by_entry_id') THEN
      RAISE EXCEPTION 'Posted journal entry % is immutable; create a reversal entry instead', OLD.entry_number
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_entries_guard BEFORE UPDATE OR DELETE ON finance.journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance_guard_entry_mutation();

CREATE OR REPLACE FUNCTION finance_guard_line_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM finance.journal_entries
  WHERE id = coalesce(NEW.entry_id, OLD.entry_id);
  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'Lines of posted journal entry % are immutable', coalesce(NEW.entry_id, OLD.entry_id)
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
CREATE TRIGGER journal_lines_guard BEFORE UPDATE OR DELETE ON finance.journal_lines
  FOR EACH ROW EXECUTE FUNCTION finance_guard_line_mutation();

CREATE OR REPLACE VIEW finance.trial_balance AS
SELECT
  l.tenant_id,
  l.account_id,
  a.account_code,
  a.account_name,
  a.account_class,
  sum(l.debit) AS total_debit,
  sum(l.credit) AS total_credit,
  sum(l.debit) - sum(l.credit) AS net_debit,
  sum(l.credit) - sum(l.debit) AS net_credit
FROM finance.journal_lines l
JOIN finance.journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
JOIN finance.accounts a ON a.id = l.account_id
GROUP BY l.tenant_id, l.account_id, a.account_code, a.account_name, a.account_class;

CREATE OR REPLACE VIEW finance.revenue_by_branch AS
SELECT
  e.tenant_id,
  e.branch_id,
  e.entry_date,
  e.source_type,
  sum(l.credit - l.debit) AS revenue_amount
FROM finance.journal_entries e
JOIN finance.journal_lines l ON l.entry_id = e.id
JOIN finance.accounts a ON a.id = l.account_id
WHERE e.status = 'posted' AND a.account_class = 'revenue'
GROUP BY e.tenant_id, e.branch_id, e.entry_date, e.source_type;
