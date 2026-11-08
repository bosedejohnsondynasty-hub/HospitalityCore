-- 027: External Channel Manager (OTA/GDS connectivity)
-- Adds provider registry, channel mapping, ARI sync queue, reservation import, rate parity monitoring

CREATE SCHEMA IF NOT EXISTS channel;

-- Provider registry: OTA/GDS providers (Booking.com, Expedia, Agoda, etc.)
CREATE TABLE channel.providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_code varchar(50) NOT NULL,          -- e.g. 'booking.com', 'expedia', 'agoda', 'airbnb'
  provider_name varchar(180) NOT NULL,
  api_endpoint text NOT NULL,
  auth_type text NOT NULL DEFAULT 'api_key',    -- 'api_key', 'oauth2', 'basic', 'cert'
  auth_config jsonb NOT NULL DEFAULT '{}',      -- provider-specific credentials (encrypted at rest via app)
  is_active boolean NOT NULL DEFAULT true,
  default_commission_percent numeric(6,2) NOT NULL DEFAULT 15.00,
  default_currency varchar(3) NOT NULL DEFAULT 'USD',
  timeout_ms integer NOT NULL DEFAULT 30000,
  retry_policy jsonb NOT NULL DEFAULT '{"max_retries": 3, "backoff_ms": 1000}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT providers_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT providers_tenant_code_key UNIQUE (tenant_id, provider_code)
);

-- Channel mapping: map local room types to provider room/rate plan codes
CREATE TABLE channel.channel_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES channel.providers(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  provider_room_code varchar(100) NOT NULL,     -- provider's room type code
  provider_rate_plan_code varchar(100),         -- provider's rate plan code
  is_active boolean NOT NULL DEFAULT true,
  overrides jsonb NOT NULL DEFAULT '{}',        -- price offsets, restrictions, etc.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_mappings_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT channel_mappings_unique UNIQUE (tenant_id, provider_id, hotel_id, room_type_id),
  CONSTRAINT channel_mappings_hotel_fk FOREIGN KEY (tenant_id, hotel_id) REFERENCES hotel.hotels(tenant_id, id),
  CONSTRAINT channel_mappings_room_fk FOREIGN KEY (tenant_id, hotel_id, room_type_id) REFERENCES hotel.room_types(tenant_id, hotel_id, id)
);

-- ARI (Availability, Rates, Inventory) push queue
CREATE TABLE channel.ari_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES channel.providers(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  operation text NOT NULL,                      -- 'availability', 'rates', 'restrictions', 'all'
  payload jsonb NOT NULL,                       -- serialized ARI payload for provider
  status text NOT NULL DEFAULT 'pending',       -- 'pending', 'processing', 'completed', 'failed', 'dead_letter'
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ari_queue_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT ari_queue_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter'))
);

CREATE INDEX idx_ari_queue_pending ON channel.ari_queue (tenant_id, provider_id, status, scheduled_for)
  WHERE status IN ('pending', 'processing');

-- Reservation import from channels
CREATE TABLE channel.reservation_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES channel.providers(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  external_reservation_id varchar(200) NOT NULL, -- provider's reservation ID
  external_confirmation_code varchar(100),
  status text NOT NULL DEFAULT 'imported',      -- 'imported', 'mapped', 'created', 'failed', 'duplicate'
  raw_payload jsonb NOT NULL,                   -- full provider response
  mapped_data jsonb,                            -- normalized data ready for reservation creation
  local_reservation_id uuid,                    -- link to hotel.reservations after creation
  error_message text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_imports_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT reservation_imports_unique UNIQUE (tenant_id, provider_id, external_reservation_id),
  CONSTRAINT reservation_imports_status_check CHECK (status IN ('imported', 'mapped', 'created', 'failed', 'duplicate')),
  CONSTRAINT reservation_imports_hotel_fk FOREIGN KEY (tenant_id, hotel_id) REFERENCES hotel.hotels(tenant_id, id)
);

-- Rate parity monitoring
CREATE TABLE channel.rate_parity_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES channel.providers(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  check_date date NOT NULL,
  local_rate numeric(18,4) NOT NULL,
  channel_rate numeric(18,4) NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  parity_status text NOT NULL DEFAULT 'matched', -- 'matched', 'parity_failed', 'alerted', 'under_cut'
  variance_percent numeric(6,2),
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_parity_checks_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT rate_parity_checks_unique UNIQUE (tenant_id, provider_id, hotel_id, room_type_id, check_date),
  CONSTRAINT rate_parity_checks_parity_check CHECK (parity_status IN ('matched', 'parity_failed', 'alerted', 'under_cut')),
  CONSTRAINT rate_parity_checks_hotel_fk FOREIGN KEY (tenant_id, hotel_id) REFERENCES hotel.hotels(tenant_id, id),
  CONSTRAINT rate_parity_checks_room_fk FOREIGN KEY (tenant_id, hotel_id, room_type_id) REFERENCES hotel.room_types(tenant_id, hotel_id, id)
);

-- Commission tracking
CREATE TABLE channel.commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES channel.providers(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  reservation_id uuid,                          -- link to hotel.reservations if local
  external_reservation_id varchar(200),
  stay_date date NOT NULL,
  room_nights integer NOT NULL DEFAULT 1,
  gross_amount numeric(18,4) NOT NULL,
  commission_percent numeric(6,2) NOT NULL,
  commission_amount numeric(18,4) NOT NULL,
  net_amount numeric(18,4) NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'accrued',       -- 'accrued', 'invoiced', 'paid', 'disputed'
  period_start date NOT NULL,
  period_end date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commissions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT commissions_hotel_fk FOREIGN KEY (tenant_id, hotel_id) REFERENCES hotel.hotels(tenant_id, id)
);

-- Provider health monitoring
CREATE TABLE channel.provider_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES channel.providers(id) ON DELETE CASCADE,
  check_type text NOT NULL,                     -- 'connectivity', 'auth', 'ari_push', 'reservation_pull', 'rate_parity'
  status text NOT NULL,                         -- 'healthy', 'degraded', 'down', 'unknown'
  response_time_ms integer,
  error_message text,
  details jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_health_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT provider_health_status_check CHECK (status IN ('healthy', 'degraded', 'down', 'unknown'))
);

-- Sync log for audit trail
CREATE TABLE channel.sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES channel.providers(id) ON DELETE CASCADE,
  operation text NOT NULL,                      -- 'ari_push', 'reservation_pull', 'rate_parity_check', 'commission_calc'
  entity_type text,                             -- 'ari_queue', 'reservation_imports', 'rate_parity_checks', 'commissions'
  entity_id uuid,
  status text NOT NULL,                         -- 'started', 'completed', 'failed'
  records_processed integer NOT NULL DEFAULT 0,
  records_failed integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT sync_log_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT sync_log_status_check CHECK (status IN ('started', 'completed', 'failed'))
);

-- RLS policies
ALTER TABLE channel.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel.channel_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel.ari_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel.reservation_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel.rate_parity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel.commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel.provider_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel.sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY providers_rls ON channel.providers USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY channel_mappings_rls ON channel.channel_mappings USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY ari_queue_rls ON channel.ari_queue USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY reservation_imports_rls ON channel.reservation_imports USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY rate_parity_checks_rls ON channel.rate_parity_checks USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY commissions_rls ON channel.commissions USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY provider_health_rls ON channel.provider_health USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY sync_log_rls ON channel.sync_log USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.providers TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.channel_mappings TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.ari_queue TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.reservation_imports TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.rate_parity_checks TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.commissions TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.provider_health TO hospitality_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel.sync_log TO hospitality_app;

-- Security invoker views for reporting
CREATE VIEW channel.provider_performance WITH (security_invoker = true) AS
SELECT p.provider_code, p.provider_name,
       COUNT(ri.id) AS total_imports,
       COUNT(ri.id) FILTER (WHERE ri.status = 'created') AS successful_imports,
       COUNT(ri.id) FILTER (WHERE ri.status = 'failed') AS failed_imports,
       AVG(ph.response_time_ms) AS avg_response_time_ms,
       MAX(ph.checked_at) AS last_health_check
FROM channel.providers p
LEFT JOIN channel.reservation_imports ri ON ri.provider_id = p.id
LEFT JOIN channel.provider_health ph ON ph.provider_id = p.id
GROUP BY p.id, p.provider_code, p.provider_name;

CREATE VIEW channel.parity_summary WITH (security_invoker = true) AS
SELECT pc.provider_code, rpc.hotel_id, rt.room_type_code,
       COUNT(*) AS total_checks,
       COUNT(*) FILTER (WHERE rpc.parity_status = 'matched') AS matched,
       COUNT(*) FILTER (WHERE rpc.parity_status = 'parity_failed') AS parity_failed,
       COUNT(*) FILTER (WHERE rpc.parity_status = 'under_cut') AS under_cut,
       MAX(rpc.checked_at) AS last_check
FROM channel.rate_parity_checks rpc
JOIN channel.providers pc ON pc.id = rpc.provider_id
JOIN hotel.room_types rt ON rt.id = rpc.room_type_id AND rt.hotel_id = rpc.hotel_id
GROUP BY pc.provider_code, rpc.hotel_id, rt.room_type_code;

GRANT SELECT ON channel.provider_performance TO hospitality_app;
GRANT SELECT ON channel.parity_summary TO hospitality_app;

-- Touch triggers
CREATE TRIGGER trg_channel_providers_touch
  BEFORE UPDATE ON channel.providers
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

CREATE TRIGGER trg_channel_mappings_touch
  BEFORE UPDATE ON channel.channel_mappings
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

CREATE TRIGGER trg_ari_queue_touch
  BEFORE UPDATE ON channel.ari_queue
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

CREATE TRIGGER trg_reservation_imports_touch
  BEFORE UPDATE ON channel.reservation_imports
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

CREATE TRIGGER trg_rate_parity_checks_touch
  BEFORE UPDATE ON channel.rate_parity_checks
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

CREATE TRIGGER trg_commissions_touch
  BEFORE UPDATE ON channel.commissions
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

CREATE TRIGGER trg_provider_health_touch
  BEFORE UPDATE ON channel.provider_health
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

CREATE TRIGGER trg_sync_log_touch
  BEFORE UPDATE ON channel.sync_log
  FOR EACH ROW EXECUTE FUNCTION public.app_touch_updated_at();

-- Seed the channel manager module catalogue entry for licensed products.
INSERT INTO licensing.module_catalogue (product_id, module_code, module_name, module_category, description, is_core, display_order)
SELECT pc.id, 'channel_connector', 'Channel Manager Connector', 'specialized',
       'External OTA/GDS connectivity: provider registry, ARI sync queue, reservation import, rate parity checks and commission tracking.',
       false, 32
FROM licensing.product_catalogue pc
WHERE pc.product_code = 'hotel'
ON CONFLICT (product_id, module_code) DO UPDATE SET
  module_name = EXCLUDED.module_name,
  description = EXCLUDED.description,
  display_order = EXCLUDED.display_order;