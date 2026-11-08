-- Reference data: permission catalogue.
-- Every permission the API enforces server side is declared here. Role templates
-- in the API are resolved against these codes at tenant onboarding.
-- Format: <product>.<module>.<action>

INSERT INTO access.permissions (permission_code, product_code, module_code, resource, action, description, is_privileged)
SELECT v.permission_code, v.product_code, v.module_code, v.resource, v.action, v.description, v.is_privileged
FROM (VALUES
  -- platform
  ('platform.tenants.manage', 'platform', 'platform', 'tenants', 'manage', 'Create and configure the tenant.', true),
  ('platform.users.view', 'platform', 'platform', 'users', 'view', 'View users and roles.', false),
  ('platform.users.manage', 'platform', 'platform', 'users', 'manage', 'Create, update and disable users.', true),
  ('platform.roles.manage', 'platform', 'platform', 'roles', 'manage', 'Create roles and assign permissions.', true),
  ('platform.branches.view', 'platform', 'platform', 'branches', 'view', 'View branches and departments.', false),
  ('platform.branches.manage', 'platform', 'platform', 'branches', 'manage', 'Create and configure branches.', true),
  ('platform.audit.view', 'platform', 'platform', 'audit', 'view', 'Read the audit trail.', false),
  ('platform.licensing.view', 'platform', 'platform', 'licensing', 'view', 'View module entitlements.', false),
  ('platform.licensing.manage', 'platform', 'platform', 'licensing', 'manage', 'Activate and deactivate modules.', true),
  ('platform.sync.execute', 'platform', 'platform', 'sync', 'execute', 'Submit offline mobile commands.', false),
  -- hotel operations
  ('hotel.hotels.view', 'hotel', 'hotels', 'hotels', 'view', 'View hotel configuration.', false),
  ('hotel.hotels.manage', 'hotel', 'hotels', 'hotels', 'manage', 'Configure hotel and room inventory.', true),
  ('hotel.rooms.view', 'hotel', 'rooms', 'rooms', 'view', 'View rooms and room status.', false),
  ('hotel.rooms.manage', 'hotel', 'rooms', 'rooms', 'manage', 'Create and update rooms.', true),
  ('hotel.guests.view', 'hotel', 'guests', 'guests', 'view', 'View guest profiles.', false),
  ('hotel.guests.manage', 'hotel', 'guests', 'guests', 'manage', 'Create and update guest profiles.', false),
  ('hotel.reservations.view', 'hotel', 'reservations', 'reservations', 'view', 'View reservations and availability.', false),
  ('hotel.reservations.create', 'hotel', 'reservations', 'reservations', 'create', 'Create and amend reservations.', false),
  ('hotel.reservations.cancel', 'hotel', 'reservations', 'reservations', 'cancel', 'Cancel reservations.', false),
  ('hotel.frontdesk.checkin', 'hotel', 'front_office', 'checkin', 'execute', 'Check guests in.', false),
  ('hotel.frontdesk.checkout', 'hotel', 'front_office', 'checkout', 'execute', 'Check guests out.', false),
  ('hotel.folios.view', 'hotel', 'front_office', 'folios', 'view', 'View guest folios.', false),
  ('hotel.folios.post', 'hotel', 'front_office', 'folios', 'post', 'Post charges to guest folios.', false),
  ('hotel.folios.settle', 'hotel', 'cashiering', 'folios', 'settle', 'Settle folio balances.', false),
  ('hotel.folios.reverse', 'hotel', 'cashiering', 'folios', 'reverse', 'Reverse posted folio entries.', true),
  ('hotel.nightaudit.run', 'hotel', 'night_audit', 'nightaudit', 'run', 'Run the night audit.', true),
  ('hotel.nightaudit.override', 'hotel', 'night_audit', 'nightaudit', 'override', 'Override night audit exceptions.', true),
  ('hotel.housekeeping.view', 'hotel', 'housekeeping', 'tasks', 'view', 'View housekeeping board.', false),
  ('hotel.housekeeping.assign', 'hotel', 'housekeeping', 'tasks', 'assign', 'Assign cleaning tasks.', false),
  ('hotel.housekeeping.complete', 'hotel', 'housekeeping', 'tasks', 'complete', 'Complete cleaning tasks.', false),
  ('hotel.housekeeping.inspect', 'hotel', 'housekeeping', 'inspections', 'execute', 'Inspect cleaned rooms.', false),
  ('hotel.maintenance.view', 'hotel', 'maintenance', 'workorders', 'view', 'View maintenance work.', false),
  ('hotel.maintenance.request', 'hotel', 'maintenance', 'requests', 'create', 'Raise maintenance requests.', false),
  ('hotel.maintenance.approve', 'hotel', 'maintenance', 'requests', 'approve', 'Approve maintenance requests.', true),
  ('hotel.maintenance.complete', 'hotel', 'maintenance', 'workorders', 'complete', 'Complete work orders.', false),
  ('hotel.maintenance.config', 'hotel', 'maintenance', 'teams', 'config', 'Configure trades, locations, checklists and SLA policies.', true),
  ('hotel.maintenance.verify', 'hotel', 'maintenance', 'workorders', 'verify', 'Verify and sign off completed maintenance work.', true),
  ('hotel.reports.view', 'hotel', 'management_reporting', 'reports', 'view', 'View hotel reports.', false),
  -- restaurant
  ('restaurant.outlets.view', 'restaurant', 'core', 'outlets', 'view', 'View restaurant outlets.', false),
  ('restaurant.outlets.manage', 'restaurant', 'core', 'outlets', 'manage', 'Configure restaurant outlets.', true),
  ('restaurant.menu.view', 'restaurant', 'menu_qr', 'menu', 'view', 'View menus.', false),
  ('restaurant.menu.manage', 'restaurant', 'menu_qr', 'menu', 'manage', 'Manage menus and QR codes.', true),
  ('restaurant.orders.view', 'restaurant', 'ordering', 'orders', 'view', 'View restaurant orders.', false),
  ('restaurant.orders.create', 'restaurant', 'ordering', 'orders', 'create', 'Create restaurant orders.', false),
  ('restaurant.orders.update', 'restaurant', 'ordering', 'orders', 'update', 'Advance and serve orders.', false),
  ('restaurant.orders.void', 'restaurant', 'ordering', 'orders', 'void', 'Void orders and lines.', true),
  ('restaurant.kitchen.view', 'restaurant', 'kitchen', 'tickets', 'view', 'View kitchen tickets.', false),
  ('restaurant.kitchen.update', 'restaurant', 'kitchen', 'tickets', 'update', 'Advance kitchen tickets.', false),
  ('restaurant.payments.initiate', 'restaurant', 'pos', 'payments', 'initiate', 'Take payments.', false),
  ('restaurant.payments.refund', 'restaurant', 'pos', 'refunds', 'approve', 'Approve refunds.', true),
  ('restaurant.reports.view', 'restaurant', 'analytics', 'reports', 'view', 'View restaurant reports.', false),
  -- bar
  ('bar.outlets.view', 'bar', 'core', 'outlets', 'view', 'View bar outlets.', false),
  ('bar.outlets.manage', 'bar', 'core', 'outlets', 'manage', 'Configure bar outlets.', true),
  ('bar.beverages.view', 'bar', 'beverages', 'beverages', 'view', 'View beverage menu.', false),
  ('bar.beverages.manage', 'bar', 'beverages', 'beverages', 'manage', 'Manage beverage menu and recipes.', true),
  ('bar.orders.view', 'bar', 'orders', 'orders', 'view', 'View bar orders and tabs.', false),
  ('bar.orders.create', 'bar', 'orders', 'orders', 'create', 'Create bar orders.', false),
  ('bar.orders.void', 'bar', 'security', 'orders', 'void', 'Void bar orders and lines.', true),
  ('bar.payments.initiate', 'bar', 'pos', 'payments', 'initiate', 'Take bar payments.', false),
  ('bar.payments.refund', 'bar', 'pos', 'refunds', 'approve', 'Approve bar refunds.', true),
  ('bar.reports.view', 'bar', 'analytics', 'reports', 'view', 'View bar reports.', false),
  -- shared finance / inventory / procurement
  ('finance.accounts.view', 'finance', 'accounts', 'accounts', 'view', 'View chart of accounts.', false),
  ('finance.journals.view', 'finance', 'journals', 'journals', 'view', 'View journal entries.', false),
  ('finance.journals.post', 'finance', 'journals', 'journals', 'post', 'Post manual journals.', true),
  ('finance.periods.manage', 'finance', 'periods', 'periods', 'manage', 'Open and close fiscal periods.', true),
  ('finance.reports.view', 'finance', 'reports', 'reports', 'view', 'View financial statements.', false),
  ('inventory.items.view', 'inventory', 'items', 'items', 'view', 'View inventory items.', false),
  ('inventory.items.manage', 'inventory', 'items', 'items', 'manage', 'Manage inventory items.', true),
  ('inventory.stock.view', 'inventory', 'stock', 'stock', 'view', 'View stock balances and movements.', false),
  ('inventory.stock.receive', 'inventory', 'stock', 'stock', 'receive', 'Receive stock.', false),
  ('inventory.stock.issue', 'inventory', 'stock', 'stock', 'issue', 'Issue stock to departments.', false),
  ('inventory.stock.adjust', 'inventory', 'stock', 'stock', 'adjust', 'Record stock adjustments.', false),
  ('inventory.stock.adjust.approve', 'inventory', 'stock', 'stock', 'approve', 'Approve stock adjustments.', true),
  ('procurement.suppliers.manage', 'procurement', 'suppliers', 'suppliers', 'manage', 'Manage suppliers.', true),
  ('procurement.purchaseorders.view', 'procurement', 'purchasing', 'purchaseorders', 'view', 'View purchase orders.', false),
  ('procurement.purchaseorders.create', 'procurement', 'purchasing', 'purchaseorders', 'create', 'Create purchase orders.', false),
  ('procurement.purchaseorders.approve', 'procurement', 'purchasing', 'purchaseorders', 'approve', 'Approve purchase orders.', true),
  ('procurement.goodsreceipts.create', 'procurement', 'receiving', 'goodsreceipts', 'create', 'Receive goods.', false),
  ('procurement.invoices.manage', 'procurement', 'invoices', 'invoices', 'manage', 'Match and process supplier invoices.', true)
) AS v(permission_code, product_code, module_code, resource, action, description, is_privileged)
ON CONFLICT (permission_code) DO UPDATE
  SET product_code = EXCLUDED.product_code,
      module_code = EXCLUDED.module_code,
      resource = EXCLUDED.resource,
      action = EXCLUDED.action,
      description = EXCLUDED.description,
      is_privileged = EXCLUDED.is_privileged;

-- Every licensed module also gets generic view/manage entitlements so the
-- catalogue stays consistent as modules are added.
INSERT INTO access.permissions (permission_code, product_code, module_code, resource, action, description, is_privileged)
SELECT p.product_code || '.' || m.module_code || '.' || a.action,
       p.product_code,
       m.module_code,
       m.module_code,
       a.action,
       m.module_name || ' - ' || a.action,
       a.action = 'manage'
FROM licensing.module_catalogue m
JOIN licensing.product_catalogue p ON p.id = m.product_id
CROSS JOIN (VALUES ('view'), ('manage')) AS a(action)
ON CONFLICT (permission_code) DO NOTHING;
