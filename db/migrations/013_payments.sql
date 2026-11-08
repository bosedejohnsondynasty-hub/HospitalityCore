-- 013: payments - provider settings, intents, verified transactions, webhook
--      replay protection, refunds and settlements.
--
-- Provider secrets are NOT stored here. Only public configuration lives in the
-- database; signing secrets stay in the environment.

CREATE TABLE payments.provider_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  provider text NOT NULL,
  mode text NOT NULL DEFAULT 'test',
  public_key varchar(200),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_settings_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT provider_settings_unique UNIQUE (tenant_id, branch_id, provider),
  CONSTRAINT provider_settings_provider_check CHECK (provider IN ('paystack', 'flutterwave', 'cash', 'bank_transfer', 'pos_terminal')),
  CONSTRAINT provider_settings_mode_check CHECK (mode IN ('test', 'live'))
);

CREATE TABLE payments.intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  reference varchar(80) NOT NULL,
  provider text NOT NULL,
  purpose text NOT NULL,
  related_type text NOT NULL,
  related_id text NOT NULL,
  amount numeric(18,4) NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'pending',
  payment_timing text NOT NULL DEFAULT 'pay_before',
  customer_email varchar(254),
  customer_phone varchar(40),
  checkout_url text,
  provider_reference varchar(120),
  expires_at timestamptz,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intents_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT intents_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT intents_reference_key UNIQUE (tenant_id, reference),
  CONSTRAINT intents_amount_check CHECK (amount > 0),
  CONSTRAINT intents_provider_check CHECK (provider IN ('paystack', 'flutterwave', 'cash', 'bank_transfer', 'pos_terminal')),
  CONSTRAINT intents_purpose_check CHECK (
    purpose IN ('restaurant_order', 'bar_order', 'hotel_folio', 'reservation_deposit')
  ),
  CONSTRAINT intents_status_check CHECK (
    status IN ('pending', 'requires_action', 'successful', 'failed', 'cancelled', 'expired')
  )
);
CREATE INDEX idx_intents_related ON payments.intents (tenant_id, related_type, related_id);

CREATE TABLE payments.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  provider text NOT NULL,
  provider_transaction_id varchar(120) NOT NULL,
  amount numeric(18,4) NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  status text NOT NULL,
  channel varchar(60),
  gateway_fee numeric(18,4) NOT NULL DEFAULT 0,
  paid_at timestamptz,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_intent_fk FOREIGN KEY (tenant_id, intent_id)
    REFERENCES payments.intents (tenant_id, id),
  CONSTRAINT transactions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT transactions_provider_key UNIQUE (provider, provider_transaction_id),
  CONSTRAINT transactions_amount_check CHECK (amount > 0),
  CONSTRAINT transactions_status_check CHECK (status IN ('successful', 'failed', 'pending', 'reversed'))
);

-- One row per provider webhook event. The unique constraint is the replay guard:
-- a duplicate delivery can never be processed twice.
CREATE TABLE payments.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  provider text NOT NULL,
  event_id varchar(160) NOT NULL,
  event_type varchar(120) NOT NULL,
  signature_valid boolean NOT NULL,
  payload jsonb NOT NULL,
  result text NOT NULL DEFAULT 'received',
  result_detail text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT webhook_events_unique UNIQUE (provider, event_id),
  CONSTRAINT webhook_events_result_check CHECK (
    result IN ('received', 'processed', 'ignored', 'rejected', 'duplicate', 'error')
  )
);
CREATE INDEX idx_webhook_events_received ON payments.webhook_events (provider, received_at DESC);

CREATE TABLE payments.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  amount numeric(18,4) NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  rejection_reason text,
  provider_refund_id varchar(120),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_intent_fk FOREIGN KEY (tenant_id, intent_id)
    REFERENCES payments.intents (tenant_id, id),
  CONSTRAINT refunds_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT refunds_amount_check CHECK (amount > 0),
  CONSTRAINT refunds_status_check CHECK (
    status IN ('requested', 'approved', 'rejected', 'processed', 'failed')
  ),
  CONSTRAINT refunds_four_eyes CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE payments.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  provider text NOT NULL,
  settlement_reference varchar(120) NOT NULL,
  settlement_date date NOT NULL,
  gross_amount numeric(18,4) NOT NULL,
  fees numeric(18,4) NOT NULL DEFAULT 0,
  net_amount numeric(18,4) NOT NULL,
  bank_account_id uuid,
  status text NOT NULL DEFAULT 'pending',
  matched_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT settlements_reference_key UNIQUE (tenant_id, provider, settlement_reference),
  CONSTRAINT settlements_amount_check CHECK (gross_amount >= 0 AND fees >= 0 AND net_amount >= 0),
  CONSTRAINT settlements_status_check CHECK (status IN ('pending', 'matched', 'disputed'))
);
