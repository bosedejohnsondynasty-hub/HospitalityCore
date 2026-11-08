-- 002: platform core - tenants, organization hierarchy, document counters,
--      audit trail, integration outbox, idempotency keys and notifications.

CREATE TABLE platform.doc_counters (
  tenant_id uuid NOT NULL,
  counter_key text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, counter_key)
);

CREATE TABLE platform.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_code varchar(50) NOT NULL,
  tenant_name varchar(200) NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'NG',
  default_currency char(3) NOT NULL DEFAULT 'NGN',
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_id_tenant_code_key UNIQUE (id, tenant_code),
  CONSTRAINT tenants_tenant_code_key UNIQUE (tenant_code),
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'closed')),
  CONSTRAINT tenants_currency_check CHECK (default_currency ~ '^[A-Z]{3}$')
);
CREATE TRIGGER tenants_touch BEFORE UPDATE ON platform.tenants
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE platform.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  organization_code varchar(50) NOT NULL,
  organization_name varchar(200) NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT organizations_code_key UNIQUE (tenant_id, organization_code),
  CONSTRAINT organizations_status_check CHECK (status IN ('active', 'inactive'))
);
CREATE TRIGGER organizations_touch BEFORE UPDATE ON platform.organizations
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE platform.legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  entity_code varchar(50) NOT NULL,
  entity_name varchar(200) NOT NULL,
  registration_number varchar(80),
  tax_identification_number varchar(80),
  base_currency char(3) NOT NULL DEFAULT 'NGN',
  fiscal_year_start_month smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_entities_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES platform.organizations (tenant_id, id),
  CONSTRAINT legal_entities_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT legal_entities_org_key UNIQUE (tenant_id, organization_id, id),
  CONSTRAINT legal_entities_code_key UNIQUE (tenant_id, organization_id, entity_code),
  CONSTRAINT legal_entities_month_check CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
);
CREATE TRIGGER legal_entities_touch BEFORE UPDATE ON platform.legal_entities
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE platform.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  branch_code varchar(50) NOT NULL,
  branch_name varchar(200) NOT NULL,
  branch_type text NOT NULL DEFAULT 'hotel',
  address_line1 text,
  city varchar(120),
  state_region varchar(120),
  country_code char(2) NOT NULL DEFAULT 'NG',
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branches_entity_fk FOREIGN KEY (tenant_id, organization_id, legal_entity_id)
    REFERENCES platform.legal_entities (tenant_id, organization_id, id),
  CONSTRAINT branches_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT branches_org_key UNIQUE (tenant_id, organization_id, id),
  CONSTRAINT branches_code_key UNIQUE (tenant_id, organization_id, branch_code),
  CONSTRAINT branches_type_check CHECK (branch_type IN ('hotel', 'restaurant', 'bar', 'mixed', 'support')),
  CONSTRAINT branches_status_check CHECK (status IN ('active', 'inactive'))
);
CREATE TRIGGER branches_touch BEFORE UPDATE ON platform.branches
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE platform.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  department_code varchar(50) NOT NULL,
  department_name varchar(150) NOT NULL,
  cost_centre_code varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT departments_branch_fk FOREIGN KEY (tenant_id, organization_id, branch_id)
    REFERENCES platform.branches (tenant_id, organization_id, id),
  CONSTRAINT departments_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT departments_code_key UNIQUE (tenant_id, branch_id, department_code)
);
CREATE TRIGGER departments_touch BEFORE UPDATE ON platform.departments
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE platform.tenant_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  setting_key text NOT NULL,
  setting_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_settings_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tenant_settings_key UNIQUE (tenant_id, setting_key)
);

-- Append-only audit trail. actor_user_id is intentionally not a foreign key:
-- audit records must survive user archival and remain readable.
CREATE TABLE audit.events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_user_id uuid,
  actor_label text,
  correlation_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  branch_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_events_tenant_created ON audit.events (tenant_id, created_at DESC);
CREATE INDEX idx_audit_events_entity ON audit.events (tenant_id, entity_type, entity_id);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

-- Transactional outbox for domain events consumed by integrations/reports.
CREATE TABLE integration.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT outbox_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT outbox_status_check CHECK (status IN ('pending', 'processing', 'processed', 'failed'))
);
CREATE INDEX idx_outbox_pending ON integration.outbox (status, available_at) WHERE status = 'pending';

-- Replay protection for non-webhook write endpoints (mobile sync, payments).
CREATE TABLE integration.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  CONSTRAINT idempotency_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT idempotency_scope_key UNIQUE (tenant_id, scope, idempotency_key)
);

CREATE TABLE notification.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  channel text NOT NULL,
  recipient text NOT NULL,
  template_code text,
  subject text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  related_type text,
  related_id text,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT messages_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT messages_channel_check CHECK (channel IN ('email', 'sms', 'push', 'inapp')),
  CONSTRAINT messages_status_check CHECK (status IN ('queued', 'sent', 'failed', 'cancelled'))
);
CREATE INDEX idx_messages_queue ON notification.messages (tenant_id, status, created_at);

-- Domain event helper: writes to the outbox inside the caller's transaction.
CREATE OR REPLACE FUNCTION app_emit_event(
  p_tenant_id uuid,
  p_event_type text,
  p_aggregate_type text,
  p_aggregate_id text,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO integration.outbox (tenant_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (p_tenant_id, p_event_type, p_aggregate_type, p_aggregate_id, coalesce(p_payload, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
