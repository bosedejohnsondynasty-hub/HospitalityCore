-- 004: Role definitions and permission mappings
-- Defines tenant-scoped roles with their permission sets

-- Create role definitions (if not exist)
CREATE TABLE IF NOT EXISTS access.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  role_code varchar(80) NOT NULL,
  role_name varchar(150) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT roles_code_key UNIQUE (tenant_id, role_code)
);

-- Insert default roles if they don't exist
INSERT INTO access.roles (tenant_id, role_code, role_name, description, is_system)
SELECT 
  u.tenant_id,
  'guest' AS role_code,
  'Guest' AS role_name,
  'Read-only access to public content' AS description,
  false AS is_system
FROM identity.users u
WHERE u.tenant_id = current_setting('app.tenant_id') AND u.status = 'active';

-- Insert additional roles
INSERT INTO access.roles (tenant_id, role_code, role_name, description, is_system)
SELECT 
  u.tenant_id,
  'staff' AS role_code,
  'Staff Member' AS role_name,
  'Full access to hotel operations, reservations, and basic management' AS description,
  false AS is_system
FROM identity.users u
WHERE u.tenant_id = current_setting('app.tenant_id') AND u.status = 'active';

INSERT INTO access.roles (tenant_id, role_code, role_name, description, is_system)
SELECT 
  u.tenant_id,
  'manager' AS role_code,
  'Store Manager' AS role_name,
  'Manage staff, reservations, pricing, and inventory for the hotel' AS description,
  false AS is_system
FROM identity.users u
WHERE u.tenant_id = current_setting('app.tenant_id') AND u.status = 'active';

INSERT INTO access.roles (tenant_id, role_code, role_name, description, is_system)
SELECT 
  u.tenant_id,
  'admin' AS role_code,
  'Administrator' AS role_name,
  'Full system access: all modules, billing, reporting, and user management' AS description,
  false AS is_system
FROM identity.users u
WHERE u.tenant_id = current_setting('app.tenant_id') AND u.status = 'active';

-- Create permission catalogue (if not exist)
CREATE TABLE IF NOT EXISTS access.permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_code varchar(150) NOT NULL,
  product_code varchar(50),
  module_code varchar(80),
  resource varchar(120) NOT NULL,
  action varchar(60) NOT NULL,
  description text,
  is_privileged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_code_key UNIQUE (permission_code),
  CONSTRAINT permissions_code_shape CHECK (permission_code ~ '^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$')
);

-- Insert core permissions
INSERT INTO access.permissions (id, permission_code, product_code, module_code, resource, action, description, is_privileged)
VALUES
  ('p_hotel_view', 'hotel_view', 'hotel', 'hotel_view', 'hotel_view', 'view hotel details', true),
  ('p_hotel_book', 'hotel_book', 'hotel', 'hotel_book', 'hotel_book', 'create/modify/delete reservations', true),
  ('p_hotel_manage', 'hotel_manage', 'hotel', 'hotel_manage', 'hotel_manage', 'manage hotel operations', true),
  ('p_restaurant_view', 'restaurant_view', 'restaurant', 'restaurant_view', 'restaurant_view', 'view restaurant details', true),
  ('p_restaurant_book', 'restaurant_book', 'restaurant', 'restaurant_book', 'restaurant_book', 'create/modify/delete restaurant reservations', true),
  ('p_bar_view', 'bar_view', 'bar', 'bar_view', 'bar_view', 'view bar details', true),
  ('p_bar_book', 'bar_book', 'bar', 'bar_book', 'bar_book', 'create/modify/delete bar reservations', true),
  ('p_finance_view', 'finance_view', 'finance', 'finance_view', 'finance_view', 'view financial reports', true),
  ('p_finance_manage', 'finance_manage', 'finance', 'finance_manage', 'finance_manage', 'manage finances', true),
  ('p_inventory_view', 'inventory_view', 'inventory', 'inventory_view', 'inventory_view', 'view inventory', true),
  ('p_inventory_manage', 'inventory_manage', 'inventory', 'inventory_manage', 'inventory_manage', 'manage inventory', true),
  ('p_payments_view', 'payments_view', 'payments', 'payments_view', 'payments_view', 'view payment records', true),
  ('p_payments_manage', 'payments_manage', 'payments', 'payments_manage', 'payments_manage', 'manage payments', true),
  ('p_asset_view', 'asset_view', 'asset', 'asset_view', 'asset_view', 'view assets', true),
  ('p_asset_manage', 'asset_manage', 'asset', 'asset_manage', 'asset_manage', 'manage assets', true),
  ('p_workforce_view', 'workforce_view', 'workforce', 'workforce_view', 'workforce_view', 'view workforce data', true),
  ('p_workforce_manage', 'workforce_manage', 'workforce', 'workforce_manage', 'workforce_manage', 'manage workforce', true),
  ('p_notification_view', 'notification_view', 'notification', 'notification_view', 'notification_view', 'view notifications', true),
  ('p_notification_manage', 'notification_manage', 'notification', 'notification_manage', 'notification_manage', 'manage notifications', true);

-- Create role-permission mappings (if not exist)
CREATE TABLE IF NOT EXISTS access.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_role_fk FOREIGN KEY (tenant_id, role_id)
    REFERENCES access.roles (tenant_id, id),
  CONSTRAINT role_permissions_permission_fk FOREIGN KEY (permission_id)
    REFERENCES access.permissions (id),
  CONSTRAINT role_permissions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT role_permissions_unique UNIQUE (tenant_id, role_id, permission_id)
);

-- Map roles to permissions
INSERT INTO access.role_permissions (tenant_id, role_id, permission_id)
SELECT 
  current_setting('app.tenant_id') AS tenant_id,
  r.id AS role_id,
  p.id AS permission_id
FROM access.roles r
JOIN access.permissions p ON r.role_code = p.permission_code
WHERE r.tenant_id = current_setting('app.tenant_id')
  AND r.role_code IN ('guest', 'staff', 'manager', 'admin')
  AND p.permission_code IN (
    'p_hotel_view', 'p_hotel_book', 'p_hotel_manage',
    'p_restaurant_view', 'p_restaurant_book',
    'p_bar_view', 'p_bar_book',
    'p_finance_view', 'p_finance_manage',
    'p_inventory_view', 'p_inventory_manage',
    'p_payments_view', 'p_payments_manage',
    'p_asset_view', 'p_asset_manage',
    'p_workforce_view', 'p_workforce_manage',
    'p_notification_view', 'p_notification_manage'
  );
