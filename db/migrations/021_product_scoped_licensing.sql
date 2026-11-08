-- 021: product-specific modules must not inherit another product's licence.
-- SECURITY INVOKER preserves the runtime role's tenant RLS policies.
CREATE FUNCTION licensing_is_module_licensed(
  p_tenant_id uuid, p_module_code text, p_product_code text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS (
    SELECT 1
      FROM licensing.module_activations ma
      JOIN licensing.product_instances pi
        ON pi.id = ma.product_instance_id AND pi.tenant_id = ma.tenant_id
       AND pi.product_id = ma.product_id
      JOIN licensing.module_catalogue mc
        ON mc.id = ma.module_id AND mc.product_id = ma.product_id
      JOIN licensing.product_catalogue pc ON pc.id = ma.product_id
     WHERE ma.tenant_id = p_tenant_id
       AND mc.module_code = p_module_code
       AND (p_product_code IS NULL OR pc.product_code = p_product_code)
       AND ma.status = 'active' AND pi.status = 'active'
       AND pc.status = 'active' AND mc.status = 'active'
       AND EXISTS (
         SELECT 1 FROM licensing.subscriptions s
         JOIN licensing.subscription_items si
           ON si.tenant_id = s.tenant_id AND si.subscription_id = s.id
          WHERE s.tenant_id = pi.tenant_id AND s.organization_id = pi.organization_id
            AND s.status = 'active' AND s.starts_on <= current_date
            AND (s.ends_on IS NULL OR s.ends_on >= current_date)
            AND ((si.item_type = 'product' AND si.product_id = ma.product_id)
              OR (si.item_type = 'module' AND si.module_id = ma.module_id))
       )
  )
$$;
REVOKE ALL ON FUNCTION licensing_is_module_licensed(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION licensing_is_module_licensed(uuid, text, text) TO hospitality_app;

-- Shared inventory/procurement capabilities may be supplied by any product.
CREATE OR REPLACE FUNCTION licensing_is_module_licensed(p_tenant_id uuid, p_module_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT licensing_is_module_licensed(p_tenant_id, p_module_code, NULL::text)
$$;

CREATE OR REPLACE VIEW licensing.tenant_entitlements WITH (security_invoker = true) AS
SELECT ma.tenant_id, pc.product_code, pc.product_name, mc.module_code, mc.module_name,
       mc.module_category, ma.status AS activation_status, pi.status AS instance_status,
       licensing_is_module_licensed(ma.tenant_id, mc.module_code, pc.product_code) AS is_licensed
  FROM licensing.module_activations ma
  JOIN licensing.product_instances pi
    ON pi.id = ma.product_instance_id AND pi.tenant_id = ma.tenant_id AND pi.product_id = ma.product_id
  JOIN licensing.product_catalogue pc ON pc.id = ma.product_id
  JOIN licensing.module_catalogue mc ON mc.id = ma.module_id AND mc.product_id = ma.product_id;
