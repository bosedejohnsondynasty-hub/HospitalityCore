-- 016: narrowly scoped SECURITY DEFINER lookups.
--
-- Row level security requires a tenant context, but three flows must resolve a
-- tenant before that context exists:
--   * sign-in (email -> user record)
--   * session resume (session token -> tenant)
--   * public QR ordering and payment webhooks (opaque token/reference -> tenant)
--
-- Only these purpose-built functions execute with elevated rights. Each returns
-- the minimum columns needed, pins search_path and is granted to the runtime role
-- explicitly. The API never receives broader access than this.

CREATE OR REPLACE FUNCTION identity_auth_lookup(p_email text)
RETURNS TABLE (
  user_id uuid,
  tenant_id uuid,
  tenant_code varchar,
  email varchar,
  password_hash text,
  status text,
  mfa_enabled boolean,
  mfa_secret text,
  failed_login_attempts integer,
  locked_until timestamptz,
  tenant_status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.tenant_id, t.tenant_code, u.email, u.password_hash, u.status,
         u.mfa_enabled, u.mfa_secret, u.failed_login_attempts, u.locked_until, t.status
  FROM identity.users u
  JOIN platform.tenants t ON t.id = u.tenant_id
  WHERE lower(u.email) = lower(p_email)
  ORDER BY u.created_at
$$;

CREATE OR REPLACE FUNCTION identity_session_lookup(p_token_hash text)
RETURNS TABLE (
  session_id uuid,
  tenant_id uuid,
  user_id uuid,
  mfa_verified boolean,
  issued_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.tenant_id, s.user_id, s.mfa_verified, s.issued_at, s.last_seen_at,
         s.expires_at, s.revoked_at
  FROM identity.sessions s
  WHERE s.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION platform_tenant_by_code(p_code text)
RETURNS TABLE (tenant_id uuid, tenant_code varchar, tenant_name varchar, status text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.tenant_code, t.tenant_name, t.status
  FROM platform.tenants t
  WHERE t.tenant_code = p_code
$$;

CREATE OR REPLACE FUNCTION restaurant_qr_lookup(p_token text)
RETURNS TABLE (
  tenant_id uuid,
  outlet_id uuid,
  table_id uuid,
  is_active boolean,
  expires_at timestamptz,
  accepts_qr_orders boolean,
  outlet_status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT q.tenant_id, q.outlet_id, q.table_id, q.is_active, q.expires_at,
         o.accepts_qr_orders, o.status
  FROM restaurant.qr_tokens q
  JOIN restaurant.outlets o ON o.id = q.outlet_id
  WHERE q.token = p_token
$$;

CREATE OR REPLACE FUNCTION payments_intent_lookup(p_reference text)
RETURNS TABLE (
  intent_id uuid,
  tenant_id uuid,
  amount numeric,
  currency_code char(3),
  status text,
  provider text,
  related_type text,
  related_id text,
  purpose text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.tenant_id, i.amount, i.currency_code, i.status, i.provider,
         i.related_type, i.related_id, i.purpose
  FROM payments.intents i
  WHERE i.reference = p_reference
$$;

GRANT EXECUTE ON FUNCTION identity_auth_lookup(text) TO hospitality_app;
GRANT EXECUTE ON FUNCTION identity_session_lookup(text) TO hospitality_app;
GRANT EXECUTE ON FUNCTION platform_tenant_by_code(text) TO hospitality_app;
GRANT EXECUTE ON FUNCTION restaurant_qr_lookup(text) TO hospitality_app;
GRANT EXECUTE ON FUNCTION payments_intent_lookup(text) TO hospitality_app;
