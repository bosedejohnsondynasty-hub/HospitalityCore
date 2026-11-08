-- 023: expanded catalogue domains.
--
-- The 72-module catalogue contained 25 catalogue-only or partial domains with no data
-- seam. This migration adds production storage for those domains using the project
-- conventions: UUID primary keys, tenant_id, composite tenant foreign keys, NUMERIC
-- (18,4) money, TIMESTAMPTZ timestamps, unique tenant-scoped keys, indexes and RLS.
-- Append-only or immutable posted/ledger records are never modified in place.
--
-- The schemas are deliberately grouped by operational ownership rather than by the
-- licensing module names, so one business record can still span adjacent services:
-- backoffice (finance-adjacent and administrative hotel workflows), guestops
-- (commercial / guest-service workflows), restaurant/bar product operations.

CREATE SCHEMA IF NOT EXISTS backoffice;
CREATE SCHEMA IF NOT EXISTS guestops;

-- ---------------------------------------------------------------------------
-- Back office: budget, treasury, laundry, contracts, insurance, quality,
-- utilities, security, documents and training
-- ---------------------------------------------------------------------------

CREATE TABLE backoffice.budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  fiscal_year integer NOT NULL,
  budget_code varchar(40) NOT NULL,
  budget_name varchar(180) NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  total_amount numeric(18,4) NOT NULL DEFAULT 0,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budgets_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT budgets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT budgets_code_key UNIQUE (tenant_id, branch_id, fiscal_year, budget_code),
  CONSTRAINT budgets_year_check CHECK (fiscal_year BETWEEN 2000 AND 2100),
  CONSTRAINT budgets_status_check CHECK (status IN ('draft', 'approved', 'locked')),
  CONSTRAINT budgets_total_check CHECK (total_amount >= 0)
);

CREATE TABLE backoffice.budget_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  account_id uuid NOT NULL,
  category varchar(120) NOT NULL,
  cost_centre varchar(80),
  amount numeric(18,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_lines_budget_fk FOREIGN KEY (tenant_id, budget_id)
    REFERENCES backoffice.budgets (tenant_id, id),
  CONSTRAINT budget_lines_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES finance.accounts (tenant_id, id),
  CONSTRAINT budget_lines_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT budget_lines_key UNIQUE (tenant_id, budget_id, account_id, cost_centre, category),
  CONSTRAINT budget_lines_amount_check CHECK (amount > 0)
);
CREATE INDEX idx_budget_lines_budget ON backoffice.budget_lines (tenant_id, budget_id);

CREATE TABLE backoffice.treasury_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  source_bank_account_id uuid NOT NULL,
  destination_bank_account_id uuid NOT NULL,
  entry_date date NOT NULL,
  amount numeric(18,4) NOT NULL,
  reference varchar(80) NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  journal_entry_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT treasury_source_fk FOREIGN KEY (tenant_id, source_bank_account_id)
    REFERENCES finance.bank_accounts (tenant_id, id),
  CONSTRAINT treasury_destination_fk FOREIGN KEY (tenant_id, destination_bank_account_id)
    REFERENCES finance.bank_accounts (tenant_id, id),
  CONSTRAINT treasury_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT treasury_journal_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT treasury_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT treasury_reference_key UNIQUE (tenant_id, reference),
  CONSTRAINT treasury_amount_check CHECK (amount > 0),
  CONSTRAINT treasury_accounts_check CHECK (source_bank_account_id <> destination_bank_account_id),
  CONSTRAINT treasury_status_check CHECK (status IN ('pending', 'posted', 'reversed'))
);
CREATE INDEX idx_treasury_transfers_date ON backoffice.treasury_transfers (tenant_id, entry_date DESC);

CREATE TABLE backoffice.laundry_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  hotel_id uuid,
  cycle_type varchar(80) NOT NULL,
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'scheduled',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT laundry_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT laundry_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT laundry_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT laundry_status_check CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT laundry_time_check CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX idx_laundry_status ON backoffice.laundry_cycles (tenant_id, status, scheduled_at);

CREATE TABLE backoffice.laundry_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  item_name varchar(160) NOT NULL,
  linen_category varchar(80) NOT NULL DEFAULT 'guest_linen',
  quantity integer NOT NULL,
  returned_quantity integer NOT NULL DEFAULT 0,
  lost_quantity integer NOT NULL DEFAULT 0,
  damaged_quantity integer NOT NULL DEFAULT 0,
  notes text,
  CONSTRAINT laundry_items_cycle_fk FOREIGN KEY (tenant_id, cycle_id)
    REFERENCES backoffice.laundry_cycles (tenant_id, id),
  CONSTRAINT laundry_items_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT laundry_items_key UNIQUE (tenant_id, cycle_id, item_name, linen_category),
  CONSTRAINT laundry_items_qty_check CHECK (quantity > 0 AND returned_quantity >= 0 AND lost_quantity >= 0 AND damaged_quantity >= 0 AND returned_quantity <= quantity AND lost_quantity <= quantity AND damaged_quantity <= quantity AND returned_quantity + lost_quantity + damaged_quantity <= quantity)
);

CREATE TABLE backoffice.agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  agreement_code varchar(40) NOT NULL,
  agreement_name varchar(180) NOT NULL,
  agreement_type varchar(80) NOT NULL,
  counterparty varchar(180) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  amount numeric(18,4) NOT NULL DEFAULT 0,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'draft',
  terms text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreements_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT agreements_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT agreements_code_key UNIQUE (tenant_id, agreement_code),
  CONSTRAINT agreements_date_check CHECK (end_date >= start_date),
  CONSTRAINT agreements_amount_check CHECK (amount >= 0),
  CONSTRAINT agreements_status_check CHECK (status IN ('draft', 'active', 'suspended', 'expired', 'terminated'))
);

CREATE TABLE backoffice.insurance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  insurer varchar(180) NOT NULL,
  policy_number varchar(80) NOT NULL,
  coverage_type varchar(120) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  premium numeric(18,4) NOT NULL DEFAULT 0,
  deductible numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  coverage_details text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policies_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT policies_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT policies_number_key UNIQUE (tenant_id, insurer, policy_number),
  CONSTRAINT policies_date_check CHECK (end_date >= start_date),
  CONSTRAINT policies_money_check CHECK (premium >= 0 AND deductible >= 0),
  CONSTRAINT policies_status_check CHECK (status IN ('draft', 'active', 'expired', 'cancelled'))
);

CREATE TABLE backoffice.insurance_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  claim_number varchar(80) NOT NULL,
  incident_date date NOT NULL,
  claimed_amount numeric(18,4) NOT NULL,
  estimated_recovery numeric(18,4) NOT NULL DEFAULT 0,
  paid_amount numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  description text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claims_policy_fk FOREIGN KEY (tenant_id, policy_id)
    REFERENCES backoffice.insurance_policies (tenant_id, id),
  CONSTRAINT claims_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT claims_number_key UNIQUE (tenant_id, claim_number),
  CONSTRAINT claims_money_check CHECK (claimed_amount > 0 AND estimated_recovery >= 0 AND paid_amount >= 0 AND estimated_recovery <= claimed_amount AND paid_amount <= claimed_amount),
  CONSTRAINT claims_status_check CHECK (status IN ('open', 'in_review', 'approved', 'paid', 'denied', 'closed'))
);
CREATE INDEX idx_claims_policy ON backoffice.insurance_claims (tenant_id, policy_id, status);

CREATE TABLE backoffice.quality_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  inspection_code varchar(40) NOT NULL,
  area_name varchar(180) NOT NULL,
  standard_name varchar(180) NOT NULL,
  scheduled_at timestamptz NOT NULL,
  completed_at timestamptz,
  score numeric(6,2),
  result text NOT NULL DEFAULT 'pending',
  status text NOT NULL DEFAULT 'scheduled',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT quality_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT quality_code_key UNIQUE (tenant_id, inspection_code),
  CONSTRAINT quality_score_check CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CONSTRAINT quality_result_check CHECK (result IN ('pending', 'pass', 'fail', 'follow_up')),
  CONSTRAINT quality_status_check CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE backoffice.quality_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  inspection_id uuid NOT NULL,
  action_text text NOT NULL,
  owner_name varchar(180),
  due_date date,
  estimated_cost numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_actions_inspection_fk FOREIGN KEY (tenant_id, inspection_id)
    REFERENCES backoffice.quality_inspections (tenant_id, id),
  CONSTRAINT quality_actions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT quality_actions_cost_check CHECK (estimated_cost >= 0),
  CONSTRAINT quality_actions_status_check CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE backoffice.utility_meters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  meter_code varchar(40) NOT NULL,
  meter_name varchar(180) NOT NULL,
  utility_type varchar(80) NOT NULL,
  location varchar(180),
  unit varchar(30) NOT NULL DEFAULT 'kWh',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_meters_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT utility_meters_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT utility_meters_code_key UNIQUE (tenant_id, meter_code),
  CONSTRAINT utility_meters_status_check CHECK (status IN ('active', 'retired'))
);

CREATE TABLE backoffice.utility_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  meter_id uuid NOT NULL,
  reading_date date NOT NULL,
  opening_reading numeric(16,4) NOT NULL,
  closing_reading numeric(16,4) NOT NULL,
  unit_cost numeric(18,4) NOT NULL DEFAULT 0,
  consumption numeric(16,4) NOT NULL,
  estimated_cost numeric(18,4) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_readings_meter_fk FOREIGN KEY (tenant_id, meter_id)
    REFERENCES backoffice.utility_meters (tenant_id, id),
  CONSTRAINT utility_readings_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT utility_readings_unique UNIQUE (tenant_id, meter_id, reading_date),
  CONSTRAINT utility_readings_values_check CHECK (closing_reading >= opening_reading AND unit_cost >= 0 AND consumption >= 0 AND estimated_cost >= 0)
);
CREATE INDEX idx_utility_readings_date ON backoffice.utility_readings (tenant_id, reading_date DESC);

CREATE TABLE backoffice.security_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  incident_code varchar(40) NOT NULL,
  incident_type varchar(120) NOT NULL,
  severity text NOT NULL DEFAULT 'low',
  occurred_at timestamptz NOT NULL,
  location varchar(180),
  reporter_name varchar(180),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  action_taken text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT security_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT security_code_key UNIQUE (tenant_id, incident_code),
  CONSTRAINT security_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT security_status_check CHECK (status IN ('open', 'monitoring', 'closed'))
);

CREATE TABLE backoffice.security_patrols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  patrol_date date NOT NULL,
  guard_name varchar(180) NOT NULL,
  area_name varchar(180) NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  findings text,
  status text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patrol_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT patrol_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT patrol_status_check CHECK (status IN ('scheduled', 'in_progress', 'completed', 'missed')),
  CONSTRAINT patrol_time_check CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE backoffice.document_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  document_code varchar(40) NOT NULL,
  document_name varchar(180) NOT NULL,
  document_category varchar(120) NOT NULL,
  owner_name varchar(180),
  effective_date date,
  review_date date,
  retention_years integer NOT NULL DEFAULT 7,
  version_number varchar(30) NOT NULL DEFAULT '1.0',
  storage_reference text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT documents_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT documents_code_key UNIQUE (tenant_id, document_code),
  CONSTRAINT documents_retention_check CHECK (retention_years >= 0),
  CONSTRAINT documents_status_check CHECK (status IN ('draft', 'active', 'expired', 'archived'))
);

CREATE TABLE backoffice.document_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  action_text text NOT NULL,
  owner_name varchar(180),
  due_date date,
  status text NOT NULL DEFAULT 'open',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_actions_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES backoffice.document_register (tenant_id, id),
  CONSTRAINT document_actions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT document_actions_status_check CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE backoffice.training_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  course_code varchar(40) NOT NULL,
  course_name varchar(180) NOT NULL,
  category varchar(120) NOT NULL DEFAULT 'general',
  provider varchar(180),
  validity_days integer,
  mandatory boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courses_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT courses_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT courses_code_key UNIQUE (tenant_id, course_code),
  CONSTRAINT courses_validity_check CHECK (validity_days IS NULL OR validity_days >= 0),
  CONSTRAINT courses_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE backoffice.training_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'enrolled',
  score numeric(6,2),
  certificate_reference varchar(120),
  CONSTRAINT enrollments_course_fk FOREIGN KEY (tenant_id, course_id)
    REFERENCES backoffice.training_courses (tenant_id, id),
  CONSTRAINT enrollments_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES workforce.employees (tenant_id, id),
  CONSTRAINT enrollments_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT enrollments_active_key UNIQUE (tenant_id, course_id, employee_id),
  CONSTRAINT enrollments_score_check CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CONSTRAINT enrollments_status_check CHECK (status IN ('enrolled', 'completed', 'expired', 'cancelled'))
);
CREATE INDEX idx_enrollments_employee ON backoffice.training_enrollments (tenant_id, employee_id, status);

-- ---------------------------------------------------------------------------
-- Guest operations: banquets, sales, CRM, channels, revenue, spa, tours,
-- call centre, food safety, corporate credit and franchise
-- ---------------------------------------------------------------------------

CREATE TABLE guestops.banquet_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  hotel_id uuid,
  event_code varchar(40) NOT NULL,
  event_name varchar(180) NOT NULL,
  client_name varchar(180) NOT NULL,
  event_at timestamptz NOT NULL,
  expected_pax integer NOT NULL DEFAULT 0,
  estimated_revenue numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'enquiry',
  function_sheet text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banquets_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT banquets_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT banquets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT banquets_code_key UNIQUE (tenant_id, event_code),
  CONSTRAINT banquets_pax_check CHECK (expected_pax >= 0),
  CONSTRAINT banquets_revenue_check CHECK (estimated_revenue >= 0),
  CONSTRAINT banquets_status_check CHECK (status IN ('enquiry', 'booked', 'confirmed', 'delivered', 'completed', 'cancelled'))
);

CREATE TABLE guestops.banquet_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  charge_type varchar(80) NOT NULL,
  description varchar(180) NOT NULL,
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit_price numeric(18,4) NOT NULL,
  amount numeric(18,4) NOT NULL,
  CONSTRAINT banquet_charges_event_fk FOREIGN KEY (tenant_id, event_id)
    REFERENCES guestops.banquet_events (tenant_id, id),
  CONSTRAINT banquet_charges_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT banquet_charges_values_check CHECK (quantity > 0 AND unit_price >= 0 AND amount >= 0),
  CONSTRAINT banquet_charges_total_check CHECK (amount = round(quantity * unit_price, 4))
);
CREATE INDEX idx_banquet_charges_event ON guestops.banquet_charges (tenant_id, event_id);

CREATE TABLE guestops.sales_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  campaign_code varchar(40) NOT NULL,
  campaign_name varchar(180) NOT NULL,
  channel varchar(80) NOT NULL DEFAULT 'email',
  budget_amount numeric(18,4) NOT NULL DEFAULT 0,
  expected_revenue numeric(18,4) NOT NULL DEFAULT 0,
  starts_on date,
  ends_on date,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT campaigns_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT campaigns_code_key UNIQUE (tenant_id, campaign_code),
  CONSTRAINT campaigns_values_check CHECK (budget_amount >= 0 AND expected_revenue >= 0 AND (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)),
  CONSTRAINT campaigns_status_check CHECK (status IN ('draft', 'active', 'completed', 'cancelled'))
);

CREATE TABLE guestops.sales_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid,
  prospect_name varchar(180) NOT NULL,
  contact_email varchar(254),
  estimated_value numeric(18,4) NOT NULL DEFAULT 0,
  probability_percent numeric(6,2) NOT NULL DEFAULT 50,
  stage text NOT NULL DEFAULT 'new',
  expected_close_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opps_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES guestops.sales_campaigns (tenant_id, id),
  CONSTRAINT opps_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT opps_values_check CHECK (estimated_value >= 0 AND probability_percent BETWEEN 0 AND 100),
  CONSTRAINT opps_stage_check CHECK (stage IN ('new', 'qualified', 'proposal', 'negotiating', 'won', 'lost'))
);
CREATE INDEX idx_opportunities_stage ON guestops.sales_opportunities (tenant_id, stage, expected_close_date);

CREATE TABLE guestops.crm_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  segment_code varchar(40) NOT NULL,
  segment_name varchar(180) NOT NULL,
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_segments_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT crm_segments_code_key UNIQUE (tenant_id, segment_code),
  CONSTRAINT crm_segments_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE guestops.crm_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  guest_id uuid,
  segment_id uuid,
  customer_name varchar(180),
  interaction_type varchar(80) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  summary text NOT NULL,
  satisfaction_score integer,
  follow_up_due date,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_interactions_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT crm_interactions_guest_fk FOREIGN KEY (tenant_id, guest_id)
    REFERENCES hotel.guests (tenant_id, id),
  CONSTRAINT crm_interactions_segment_fk FOREIGN KEY (tenant_id, segment_id)
    REFERENCES guestops.crm_segments (tenant_id, id),
  CONSTRAINT crm_interactions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT crm_interactions_score_check CHECK (satisfaction_score IS NULL OR satisfaction_score BETWEEN 1 AND 5),
  CONSTRAINT crm_interactions_status_check CHECK (status IN ('open', 'completed', 'cancelled'))
);
CREATE INDEX idx_crm_interactions_guest ON guestops.crm_interactions (tenant_id, guest_id, occurred_at DESC);

CREATE TABLE guestops.channel_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  channel_name varchar(100) NOT NULL,
  allocation_date date NOT NULL,
  allocated_units integer NOT NULL,
  sold_units integer NOT NULL DEFAULT 0,
  net_rate numeric(18,4) NOT NULL DEFAULT 0,
  parity_status text NOT NULL DEFAULT 'matched',
  CONSTRAINT channel_inventory_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT channel_inventory_room_fk FOREIGN KEY (tenant_id, hotel_id, room_type_id)
    REFERENCES hotel.room_types (tenant_id, hotel_id, id),
  CONSTRAINT channel_inventory_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT channel_inventory_key UNIQUE (tenant_id, hotel_id, room_type_id, channel_name, allocation_date),
  CONSTRAINT channel_inventory_units_check CHECK (allocated_units > 0 AND sold_units >= 0 AND sold_units <= allocated_units),
  CONSTRAINT channel_inventory_rate_check CHECK (net_rate >= 0),
  CONSTRAINT channel_inventory_parity_check CHECK (parity_status IN ('matched', 'parity_failed', 'alerted'))
);

CREATE TABLE guestops.revenue_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  forecast_date date NOT NULL,
  occupancy_percent numeric(6,2) NOT NULL,
  adr numeric(18,4) NOT NULL DEFAULT 0,
  forecast_revenue numeric(18,4) NOT NULL DEFAULT 0,
  strategy text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT revenue_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT revenue_date_key UNIQUE (tenant_id, hotel_id, forecast_date),
  CONSTRAINT revenue_values_check CHECK (occupancy_percent BETWEEN 0 AND 100 AND adr >= 0 AND forecast_revenue >= 0),
  CONSTRAINT revenue_status_check CHECK (status IN ('draft', 'approved'))
);

CREATE TABLE guestops.spa_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  hotel_id uuid,
  resource_code varchar(40) NOT NULL,
  resource_name varchar(180) NOT NULL,
  resource_type varchar(80) NOT NULL DEFAULT 'treatment_room',
  capacity integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spa_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT spa_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT spa_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT spa_code_key UNIQUE (tenant_id, resource_code),
  CONSTRAINT spa_capacity_check CHECK (capacity > 0),
  CONSTRAINT spa_status_check CHECK (status IN ('active', 'inactive', 'maintenance'))
);

CREATE TABLE guestops.spa_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid,
  guest_id uuid,
  resource_id uuid NOT NULL,
  service_name varchar(180) NOT NULL,
  starts_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 60,
  price numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'booked',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spa_bookings_resource_fk FOREIGN KEY (tenant_id, resource_id)
    REFERENCES guestops.spa_resources (tenant_id, id),
  CONSTRAINT spa_bookings_guest_fk FOREIGN KEY (tenant_id, guest_id)
    REFERENCES hotel.guests (tenant_id, id),
  CONSTRAINT spa_bookings_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT spa_bookings_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT spa_bookings_duration_check CHECK (duration_minutes > 0),
  CONSTRAINT spa_bookings_price_check CHECK (price >= 0),
  CONSTRAINT spa_bookings_status_check CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show'))
);
CREATE INDEX idx_spa_bookings_resource_time ON guestops.spa_bookings (tenant_id, resource_id, starts_at);

CREATE TABLE guestops.tour_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  tour_code varchar(40) NOT NULL,
  tour_name varchar(180) NOT NULL,
  destination varchar(180),
  capacity integer NOT NULL DEFAULT 20,
  price_per_person numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tours_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT tours_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tours_code_key UNIQUE (tenant_id, tour_code),
  CONSTRAINT tours_values_check CHECK (capacity > 0 AND price_per_person >= 0),
  CONSTRAINT tours_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE guestops.tour_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  departure_at timestamptz NOT NULL,
  group_name varchar(180) NOT NULL,
  pax integer NOT NULL DEFAULT 1,
  amount numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'booked',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tour_bookings_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES guestops.tour_packages (tenant_id, id),
  CONSTRAINT tour_bookings_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tour_bookings_values_check CHECK (pax > 0 AND amount >= 0),
  CONSTRAINT tour_bookings_status_check CHECK (status IN ('booked', 'completed', 'cancelled'))
);
CREATE INDEX idx_tour_bookings_package ON guestops.tour_bookings (tenant_id, package_id, departure_at);

CREATE TABLE guestops.call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid,
  caller_name varchar(180),
  caller_phone varchar(40),
  call_type varchar(80) NOT NULL DEFAULT 'reservation',
  call_at timestamptz NOT NULL DEFAULT now(),
  duration_minutes numeric(8,2) NOT NULL DEFAULT 0,
  outcome varchar(180) NOT NULL,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_logs_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT call_logs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT call_logs_duration_check CHECK (duration_minutes >= 0)
);

CREATE TABLE guestops.central_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  booking_reference varchar(80) NOT NULL,
  guest_id uuid,
  channel varchar(80) NOT NULL DEFAULT 'call_centre',
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  amount numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'held',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT central_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT central_guest_fk FOREIGN KEY (tenant_id, guest_id)
    REFERENCES hotel.guests (tenant_id, id),
  CONSTRAINT central_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT central_ref_key UNIQUE (tenant_id, booking_reference),
  CONSTRAINT central_dates_check CHECK (departure_date > arrival_date),
  CONSTRAINT central_amount_check CHECK (amount >= 0),
  CONSTRAINT central_status_check CHECK (status IN ('held', 'confirmed', 'cancelled', 'converted'))
);

CREATE TABLE guestops.food_safety_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  check_code varchar(40) NOT NULL,
  area_name varchar(180) NOT NULL,
  check_type varchar(120) NOT NULL,
  scheduled_at timestamptz NOT NULL,
  completed_at timestamptz,
  result text NOT NULL DEFAULT 'pending',
  status text NOT NULL DEFAULT 'scheduled',
  corrective_action text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT food_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT food_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT food_code_key UNIQUE (tenant_id, check_code),
  CONSTRAINT food_result_check CHECK (result IN ('pending', 'pass', 'fail')),
  CONSTRAINT food_status_check CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE guestops.food_safety_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  check_id uuid NOT NULL,
  log_type varchar(120) NOT NULL,
  reading numeric(12,4),
  unit varchar(30) NOT NULL DEFAULT 'degC',
  status text NOT NULL DEFAULT 'pass',
  notes text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT food_logs_check_fk FOREIGN KEY (tenant_id, check_id)
    REFERENCES guestops.food_safety_checks (tenant_id, id),
  CONSTRAINT food_logs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT food_logs_status_check CHECK (status IN ('pass', 'fail'))
);

CREATE TABLE guestops.corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  account_code varchar(40) NOT NULL,
  account_name varchar(180) NOT NULL,
  billing_email varchar(254),
  credit_limit numeric(18,4) NOT NULL DEFAULT 0,
  current_balance numeric(18,4) NOT NULL DEFAULT 0,
  priority text NOT NULL DEFAULT 'standard',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corporate_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT corporate_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT corporate_code_key UNIQUE (tenant_id, account_code),
  CONSTRAINT corporate_balance_check CHECK (credit_limit >= 0 AND current_balance >= 0),
  CONSTRAINT corporate_priority_check CHECK (priority IN ('standard', 'premium')),
  CONSTRAINT corporate_status_check CHECK (status IN ('active', 'suspended', 'closed'))
);

CREATE TABLE guestops.corporate_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  corporate_account_id uuid NOT NULL,
  invoice_number varchar(80) NOT NULL,
  issue_date date NOT NULL,
  due_date date NOT NULL,
  amount numeric(18,4) NOT NULL,
  paid_amount numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  journal_entry_id uuid,
  payment_journal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corp_invoice_account_fk FOREIGN KEY (tenant_id, corporate_account_id)
    REFERENCES guestops.corporate_accounts (tenant_id, id),
  CONSTRAINT corp_invoice_journal_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT corp_invoice_payment_fk FOREIGN KEY (tenant_id, payment_journal_id)
    REFERENCES finance.journal_entries (tenant_id, id),
  CONSTRAINT corp_invoice_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT corp_invoice_number_key UNIQUE (tenant_id, invoice_number),
  CONSTRAINT corp_invoice_dates_check CHECK (due_date >= issue_date),
  CONSTRAINT corp_invoice_money_check CHECK (amount > 0 AND paid_amount >= 0 AND paid_amount <= amount),
  CONSTRAINT corp_invoice_status_check CHECK (status IN ('open', 'partial', 'paid', 'overdue', 'void'))
);
CREATE INDEX idx_corp_invoice_account ON guestops.corporate_invoices (tenant_id, corporate_account_id, status);

CREATE TABLE guestops.franchise_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  standard_code varchar(40) NOT NULL,
  standard_name varchar(180) NOT NULL,
  category varchar(120) NOT NULL,
  description text,
  mandatory boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT franchise_standards_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT franchise_standards_code_key UNIQUE (tenant_id, standard_code),
  CONSTRAINT franchise_standards_status_check CHECK (status IN ('draft', 'active', 'suspended'))
);

CREATE TABLE guestops.franchise_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  standard_id uuid NOT NULL,
  audit_code varchar(40) NOT NULL,
  audit_date date NOT NULL,
  auditor varchar(180),
  score numeric(6,2),
  findings text,
  status text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT franchise_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT franchise_audits_standard_fk FOREIGN KEY (tenant_id, standard_id)
    REFERENCES guestops.franchise_standards (tenant_id, id),
  CONSTRAINT franchise_audits_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT franchise_audits_code_key UNIQUE (tenant_id, audit_code),
  CONSTRAINT franchise_audits_score_check CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  CONSTRAINT franchise_audits_status_check CHECK (status IN ('scheduled', 'in_progress', 'completed'))
);

CREATE TABLE guestops.franchise_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  action_text text NOT NULL,
  owner_name varchar(180),
  due_date date,
  estimated_cost numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT franchise_actions_audit_fk FOREIGN KEY (tenant_id, audit_id)
    REFERENCES guestops.franchise_audits (tenant_id, id),
  CONSTRAINT franchise_actions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT franchise_actions_cost_check CHECK (estimated_cost >= 0),
  CONSTRAINT franchise_actions_status_check CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled'))
);

-- ---------------------------------------------------------------------------
-- Restaurant: customers, promotions, loyalty ledger and table timing seam
-- ---------------------------------------------------------------------------

CREATE TABLE restaurant.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  customer_code varchar(40) NOT NULL,
  full_name varchar(180) NOT NULL,
  email varchar(254),
  phone varchar(40),
  loyalty_points integer NOT NULL DEFAULT 0,
  segment varchar(120) NOT NULL DEFAULT 'general',
  marketing_consent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT customers_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT customers_code_key UNIQUE (tenant_id, customer_code),
  CONSTRAINT customers_points_check CHECK (loyalty_points >= 0),
  CONSTRAINT customers_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT customers_segment_check CHECK (segment IN ('general', 'frequent', 'vip', 'corporate', 'resident'))
);

CREATE TABLE restaurant.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  promo_code varchar(40) NOT NULL,
  promo_name varchar(180) NOT NULL,
  promotion_type varchar(80) NOT NULL DEFAULT 'percentage_discount',
  discount_percent numeric(6,2) NOT NULL DEFAULT 0,
  fixed_discount numeric(18,4) NOT NULL DEFAULT 0,
  minimum_subtotal numeric(18,4) NOT NULL DEFAULT 0,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT promotions_code_key UNIQUE (tenant_id, promo_code),
  CONSTRAINT promotions_window_check CHECK (ends_at > starts_at),
  CONSTRAINT promotions_values_check CHECK (discount_percent BETWEEN 0 AND 100 AND fixed_discount >= 0 AND minimum_subtotal >= 0 AND NOT (discount_percent > 0 AND fixed_discount > 0)),
  CONSTRAINT promotions_status_check CHECK (status IN ('draft', 'active', 'inactive', 'expired'))
);

CREATE TABLE restaurant.loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  event_type varchar(80) NOT NULL,
  points integer NOT NULL,
  balance_after integer NOT NULL,
  reference varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_customer_fk FOREIGN KEY (tenant_id, customer_id)
    REFERENCES restaurant.customers (tenant_id, id),
  CONSTRAINT loyalty_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT loyalty_points_check CHECK (points <> 0 AND balance_after >= 0),
  CONSTRAINT loyalty_event_check CHECK (event_type IN ('earn', 'redeem', 'adjustment'))
);
CREATE INDEX idx_loyalty_customer ON restaurant.loyalty_ledger (tenant_id, customer_id, created_at DESC);

-- Half-open dining periods make restaurant reservations conflict-safe in the
-- same way hotel room allocations are.
ALTER TABLE restaurant.reservations
  ADD COLUMN IF NOT EXISTS dining_period tstzrange;
UPDATE restaurant.reservations
SET dining_period = tstzrange(reservation_at, reservation_at + interval '2 hours', '[)')
WHERE dining_period IS NULL;
ALTER TABLE restaurant.reservations
  ALTER COLUMN dining_period SET NOT NULL,
  ADD CONSTRAINT reservations_period_check CHECK (NOT isempty(dining_period));

-- Every reservation has a dining period: callers may pass an explicit window,
-- otherwise the default two-hour seating is derived from the booking time so
-- existing insert paths keep working.
CREATE OR REPLACE FUNCTION restaurant_reservation_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.dining_period IS NULL THEN
    NEW.dining_period := tstzrange(NEW.reservation_at, NEW.reservation_at + interval '2 hours', '[)');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reservations_period_default ON restaurant.reservations;
CREATE TRIGGER reservations_period_default
  BEFORE INSERT OR UPDATE ON restaurant.reservations
  FOR EACH ROW EXECUTE FUNCTION restaurant_reservation_period();
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_reservations_no_overlap'
  ) THEN
    ALTER TABLE restaurant.reservations
      ADD CONSTRAINT restaurant_reservations_no_overlap EXCLUDE USING gist (
        tenant_id WITH =, table_id WITH =, dining_period WITH &&
      ) WHERE (table_id IS NOT NULL AND status IN ('booked', 'seated'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_rest_reservations_time ON restaurant.reservations (tenant_id, outlet_id, reservation_at);

-- ---------------------------------------------------------------------------
-- Bar: event bookings
-- ---------------------------------------------------------------------------

CREATE TABLE bar.event_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  customer_name varchar(180) NOT NULL,
  seats integer NOT NULL DEFAULT 1,
  ticket_price numeric(18,4) NOT NULL DEFAULT 0,
  amount numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'booked',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bar_event_bookings_event_fk FOREIGN KEY (tenant_id, event_id)
    REFERENCES bar.events (tenant_id, id),
  CONSTRAINT bar_event_bookings_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bar_event_bookings_values_check CHECK (seats > 0 AND ticket_price >= 0 AND amount >= 0),
  CONSTRAINT bar_event_bookings_total_check CHECK (amount = round(seats * ticket_price, 4)),
  CONSTRAINT bar_event_bookings_status_check CHECK (status IN ('booked', 'cancelled'))
);
CREATE INDEX idx_bar_event_bookings_event ON bar.event_bookings (tenant_id, event_id, status);

-- ---------------------------------------------------------------------------
-- Ledger accounts used by corporate billing (existing tenants included).
-- ---------------------------------------------------------------------------

INSERT INTO finance.accounts
  (tenant_id, organization_id, account_code, account_name, account_class, normal_balance, currency_code)
SELECT o.tenant_id, o.id, v.code, v.name, v.class, v.normal, 'NGN'
FROM platform.organizations o
CROSS JOIN (VALUES
  ('6800', 'Corporate Billing - Other Revenue Clearing', 'revenue', 'credit'),
  ('6810', 'Corporate Billing - Bad Debt', 'expense', 'debit')
) AS v(code, name, class, normal)
ON CONFLICT (tenant_id, organization_id, account_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS and runtime grants for every new tenant-scoped table.
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
      AND c.table_schema IN (
        'backoffice', 'guestops', 'restaurant', 'bar'
      )
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

GRANT USAGE ON SCHEMA backoffice, guestops TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA backoffice, guestops TO hospitality_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA backoffice, guestops TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant.customers, restaurant.promotions, restaurant.loyalty_ledger, bar.event_bookings TO hospitality_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA restaurant, bar TO hospitality_app;

-- Loyalty movement is a posted ledger: never edit or delete a movement.
REVOKE UPDATE, DELETE ON restaurant.loyalty_ledger FROM hospitality_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA backoffice, guestops
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hospitality_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA backoffice, guestops
  GRANT USAGE, SELECT ON SEQUENCES TO hospitality_app;
