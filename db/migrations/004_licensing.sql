-- 004: licensing and entitlements.
--
-- Products (hotel_erp, restaurant, bar) are independently licensable. Modules
-- are licensed per product instance. Nothing in this schema requires one
-- product to be licensed for another product to operate.

CREATE TABLE licensing.product_catalogue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code varchar(50) NOT NULL,
  product_name varchar(150) NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_code_key UNIQUE (product_code),
  CONSTRAINT products_id_code_key UNIQUE (id, product_code),
  CONSTRAINT products_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE licensing.module_catalogue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES licensing.product_catalogue (id),
  module_code varchar(80) NOT NULL,
  module_name varchar(180) NOT NULL,
  module_category varchar(60) NOT NULL,
  description text,
  is_core boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT modules_product_key UNIQUE (product_id, id),
  CONSTRAINT modules_code_key UNIQUE (product_id, module_code),
  CONSTRAINT modules_product_code_key UNIQUE (product_id, module_code, id)
);

CREATE TABLE licensing.module_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  module_id uuid NOT NULL,
  required_module_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_deps_product_fk FOREIGN KEY (product_id, module_id)
    REFERENCES licensing.module_catalogue (product_id, id),
  CONSTRAINT module_deps_required_fk FOREIGN KEY (product_id, required_module_id)
    REFERENCES licensing.module_catalogue (product_id, id),
  CONSTRAINT module_deps_distinct CHECK (module_id <> required_module_id),
  CONSTRAINT module_deps_unique UNIQUE (module_id, required_module_id)
);

CREATE TABLE licensing.product_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES licensing.product_catalogue (id),
  instance_code varchar(60) NOT NULL,
  status text NOT NULL DEFAULT 'active',
  activated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_instances_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES platform.organizations (tenant_id, id),
  CONSTRAINT product_instances_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT product_instances_org_key UNIQUE (tenant_id, organization_id, id),
  CONSTRAINT product_instances_code_key UNIQUE (tenant_id, organization_id, instance_code),
  CONSTRAINT product_instances_product_key UNIQUE (tenant_id, organization_id, product_id),
  CONSTRAINT product_instances_status_check CHECK (status IN ('active', 'suspended', 'expired', 'deactivated'))
);

CREATE TABLE licensing.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  subscription_number varchar(60) NOT NULL,
  license_type text NOT NULL DEFAULT 'subscription',
  plan_code varchar(60) NOT NULL DEFAULT 'standard',
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  status text NOT NULL DEFAULT 'active',
  user_limit integer,
  branch_limit integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES platform.organizations (tenant_id, id),
  CONSTRAINT subscriptions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT subscriptions_number_key UNIQUE (tenant_id, subscription_number),
  CONSTRAINT subscriptions_dates_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT subscriptions_license_check CHECK (license_type IN ('subscription', 'perpetual', 'trial')),
  CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'expired', 'cancelled', 'suspended')),
  CONSTRAINT subscriptions_limits_check CHECK (
    (user_limit IS NULL OR user_limit > 0) AND (branch_limit IS NULL OR branch_limit > 0)
  )
);
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON licensing.subscriptions
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE licensing.subscription_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  item_type text NOT NULL,
  product_id uuid REFERENCES licensing.product_catalogue (id),
  module_id uuid REFERENCES licensing.module_catalogue (id),
  quantity integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_items_sub_fk FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES licensing.subscriptions (tenant_id, id),
  CONSTRAINT subscription_items_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT subscription_items_type_check CHECK (item_type IN ('product', 'module')),
  CONSTRAINT subscription_items_shape CHECK (
    (item_type = 'product' AND product_id IS NOT NULL AND module_id IS NULL)
    OR (item_type = 'module' AND module_id IS NOT NULL AND product_id IS NULL)
  ),
  CONSTRAINT subscription_items_quantity_check CHECK (quantity > 0)
);

CREATE TABLE licensing.module_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  product_instance_id uuid NOT NULL,
  product_id uuid NOT NULL,
  module_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  activated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  activated_by uuid,
  deactivated_by uuid,
  CONSTRAINT module_activations_instance_fk FOREIGN KEY (tenant_id, product_instance_id)
    REFERENCES licensing.product_instances (tenant_id, id),
  CONSTRAINT module_activations_module_fk FOREIGN KEY (product_id, module_id)
    REFERENCES licensing.module_catalogue (product_id, id),
  CONSTRAINT module_activations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT module_activations_unique UNIQUE (tenant_id, product_instance_id, module_id),
  CONSTRAINT module_activations_status_check CHECK (status IN ('active', 'locked', 'deactivated'))
);

CREATE TABLE licensing.license_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  product_instance_id uuid,
  module_id uuid,
  event_type text NOT NULL,
  actor_user_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT license_events_type_check CHECK (
    event_type IN ('activated', 'deactivated', 'renewed', 'expired', 'suspended', 'reactivated', 'offline_validated')
  )
);
CREATE INDEX idx_license_events_tenant ON licensing.license_events (tenant_id, occurred_at DESC);
CREATE TRIGGER license_events_append_only BEFORE UPDATE OR DELETE ON licensing.license_events
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

-- Signed offline licence tokens for self-hosted installations that must run
-- without connectivity to the vendor. The token itself is stored hashed.
CREATE TABLE licensing.offline_license_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  payload jsonb NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  validated_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT offline_tokens_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT offline_tokens_hash_key UNIQUE (token_hash),
  CONSTRAINT offline_tokens_expiry_check CHECK (expires_at > issued_at)
);

-- Single source of truth for "may this tenant use this module right now".
CREATE OR REPLACE FUNCTION licensing_is_module_licensed(p_tenant_id uuid, p_module_code text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM licensing.module_activations ma
    JOIN licensing.product_instances pi
      ON pi.id = ma.product_instance_id AND pi.tenant_id = ma.tenant_id
    JOIN licensing.module_catalogue mc
      ON mc.id = ma.module_id AND mc.product_id = ma.product_id
    JOIN licensing.product_catalogue pc ON pc.id = ma.product_id
    WHERE ma.tenant_id = p_tenant_id
      AND mc.module_code = p_module_code
      AND ma.status = 'active'
      AND pi.status = 'active'
      AND pc.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM licensing.subscriptions s
        WHERE s.tenant_id = pi.tenant_id
          AND s.organization_id = pi.organization_id
          AND s.status = 'active'
          AND s.starts_on <= current_date
          AND (s.ends_on IS NULL OR s.ends_on >= current_date)
      )
  )
$$;

CREATE OR REPLACE VIEW licensing.tenant_entitlements AS
SELECT
  ma.tenant_id,
  pc.product_code,
  pc.product_name,
  mc.module_code,
  mc.module_name,
  mc.module_category,
  ma.status AS activation_status,
  pi.status AS instance_status,
  licensing_is_module_licensed(ma.tenant_id, mc.module_code) AS is_licensed
FROM licensing.module_activations ma
JOIN licensing.product_instances pi ON pi.id = ma.product_instance_id
JOIN licensing.product_catalogue pc ON pc.id = ma.product_id
JOIN licensing.module_catalogue mc ON mc.id = ma.module_id;
