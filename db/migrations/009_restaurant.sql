-- 009: restaurant product schema (standalone, no hotel dependency).

CREATE TABLE restaurant.outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  outlet_code varchar(40) NOT NULL,
  outlet_name varchar(150) NOT NULL,
  outlet_type text NOT NULL DEFAULT 'dine_in',
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  tax_rate numeric(6,4) NOT NULL DEFAULT 0.0750,
  service_charge_rate numeric(6,4) NOT NULL DEFAULT 0.1000,
  accepts_qr_orders boolean NOT NULL DEFAULT true,
  pay_before_order boolean NOT NULL DEFAULT false,
  allow_charge_to_room boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outlets_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT outlets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT outlets_code_key UNIQUE (tenant_id, branch_id, outlet_code),
  CONSTRAINT outlets_type_check CHECK (
    outlet_type IN ('dine_in', 'qsr', 'cafe', 'food_court', 'takeaway', 'delivery', 'cloud_kitchen')
  ),
  CONSTRAINT outlets_rates_check CHECK (tax_rate >= 0 AND tax_rate < 1 AND service_charge_rate >= 0 AND service_charge_rate < 1),
  CONSTRAINT outlets_status_check CHECK (status IN ('active', 'inactive', 'suspended'))
);
CREATE TRIGGER outlets_touch BEFORE UPDATE ON restaurant.outlets
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE restaurant.dining_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  area_name varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dining_areas_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT dining_areas_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT dining_areas_name_key UNIQUE (tenant_id, outlet_id, area_name)
);

CREATE TABLE restaurant.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  area_id uuid,
  table_code varchar(30) NOT NULL,
  seats smallint NOT NULL DEFAULT 4,
  status text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tables_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT tables_area_fk FOREIGN KEY (tenant_id, area_id)
    REFERENCES restaurant.dining_areas (tenant_id, id),
  CONSTRAINT tables_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tables_code_key UNIQUE (tenant_id, outlet_id, table_code),
  CONSTRAINT tables_status_check CHECK (status IN ('free', 'occupied', 'reserved', 'cleaning')),
  CONSTRAINT tables_seats_check CHECK (seats > 0)
);

CREATE TABLE restaurant.kitchen_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  station_code varchar(40) NOT NULL,
  station_name varchar(120) NOT NULL,
  printer_target varchar(120),
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT stations_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT stations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT stations_code_key UNIQUE (tenant_id, outlet_id, station_code)
);

CREATE TABLE restaurant.menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  menu_name varchar(150) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  available_from time,
  available_to time,
  days_of_week smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT menus_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT menus_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT menus_name_key UNIQUE (tenant_id, outlet_id, menu_name)
);

CREATE TABLE restaurant.menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  menu_id uuid NOT NULL,
  category_name varchar(120) NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  CONSTRAINT menu_categories_menu_fk FOREIGN KEY (tenant_id, menu_id)
    REFERENCES restaurant.menus (tenant_id, id),
  CONSTRAINT menu_categories_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT menu_categories_name_key UNIQUE (tenant_id, menu_id, category_name)
);

CREATE TABLE restaurant.menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  menu_id uuid NOT NULL,
  category_id uuid,
  sku varchar(60) NOT NULL,
  item_name varchar(180) NOT NULL,
  description text,
  price numeric(18,4) NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  tax_rate numeric(6,4) NOT NULL DEFAULT 0.0750,
  kitchen_station_id uuid,
  prep_minutes integer NOT NULL DEFAULT 15,
  is_available boolean NOT NULL DEFAULT true,
  is_alcoholic boolean NOT NULL DEFAULT false,
  allergens text[] NOT NULL DEFAULT '{}',
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT menu_items_menu_fk FOREIGN KEY (tenant_id, menu_id)
    REFERENCES restaurant.menus (tenant_id, id),
  CONSTRAINT menu_items_category_fk FOREIGN KEY (tenant_id, category_id)
    REFERENCES restaurant.menu_categories (tenant_id, id),
  CONSTRAINT menu_items_station_fk FOREIGN KEY (tenant_id, kitchen_station_id)
    REFERENCES restaurant.kitchen_stations (tenant_id, id),
  CONSTRAINT menu_items_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT menu_items_sku_key UNIQUE (tenant_id, menu_id, sku),
  CONSTRAINT menu_items_price_check CHECK (price >= 0),
  CONSTRAINT menu_items_tax_check CHECK (tax_rate >= 0 AND tax_rate < 1)
);
CREATE TRIGGER menu_items_touch BEFORE UPDATE ON restaurant.menu_items
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE restaurant.menu_item_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  variant_name varchar(120) NOT NULL,
  price_delta numeric(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT item_variants_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES restaurant.menu_items (tenant_id, id),
  CONSTRAINT item_variants_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT item_variants_name_key UNIQUE (tenant_id, item_id, variant_name)
);

CREATE TABLE restaurant.menu_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  modifier_name varchar(120) NOT NULL,
  price_delta numeric(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT item_modifiers_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES restaurant.menu_items (tenant_id, id),
  CONSTRAINT item_modifiers_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT item_modifiers_name_key UNIQUE (tenant_id, item_id, modifier_name)
);

-- QR tokens: table specific when table_id is set, otherwise a general outlet code.
CREATE TABLE restaurant.qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  table_id uuid,
  token varchar(64) NOT NULL,
  label varchar(120),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qr_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT qr_table_fk FOREIGN KEY (tenant_id, table_id)
    REFERENCES restaurant.tables (tenant_id, id),
  CONSTRAINT qr_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT qr_token_key UNIQUE (token)
);
CREATE INDEX idx_qr_tokens_outlet ON restaurant.qr_tokens (tenant_id, outlet_id, is_active);

CREATE TABLE restaurant.table_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  table_id uuid NOT NULL,
  guests_count smallint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT table_sessions_table_fk FOREIGN KEY (tenant_id, table_id)
    REFERENCES restaurant.tables (tenant_id, id),
  CONSTRAINT table_sessions_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT table_sessions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT table_sessions_status_check CHECK (status IN ('open', 'closed'))
);
CREATE UNIQUE INDEX uq_table_session_open ON restaurant.table_sessions (tenant_id, table_id) WHERE status = 'open';

CREATE TABLE restaurant.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  order_number varchar(40) NOT NULL,
  channel text NOT NULL,
  table_id uuid,
  table_session_id uuid,
  guest_id uuid,
  customer_name varchar(150),
  customer_phone varchar(40),
  customer_email varchar(254),
  delivery_address text,
  status text NOT NULL DEFAULT 'placed',
  payment_status text NOT NULL DEFAULT 'unpaid',
  payment_timing text NOT NULL DEFAULT 'pay_after',
  subtotal numeric(18,4) NOT NULL DEFAULT 0,
  tax_total numeric(18,4) NOT NULL DEFAULT 0,
  service_charge_total numeric(18,4) NOT NULL DEFAULT 0,
  discount_total numeric(18,4) NOT NULL DEFAULT 0,
  total_amount numeric(18,4) NOT NULL DEFAULT 0,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  qr_token_id uuid,
  waiter_user_id uuid,
  folio_id uuid,
  placed_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_by uuid,
  CONSTRAINT orders_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT orders_table_fk FOREIGN KEY (tenant_id, table_id)
    REFERENCES restaurant.tables (tenant_id, id),
  CONSTRAINT orders_session_fk FOREIGN KEY (tenant_id, table_session_id)
    REFERENCES restaurant.table_sessions (tenant_id, id),
  CONSTRAINT orders_qr_fk FOREIGN KEY (tenant_id, qr_token_id)
    REFERENCES restaurant.qr_tokens (tenant_id, id),
  CONSTRAINT orders_folio_fk FOREIGN KEY (tenant_id, folio_id)
    REFERENCES hotel.folios (tenant_id, id),
  CONSTRAINT orders_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT orders_number_key UNIQUE (tenant_id, outlet_id, order_number),
  CONSTRAINT orders_channel_check CHECK (
    channel IN ('dine_in', 'qr_table', 'qr_general', 'takeaway', 'delivery', 'website', 'phone', 'pos')
  ),
  CONSTRAINT orders_status_check CHECK (
    status IN ('draft', 'placed', 'accepted', 'preparing', 'ready', 'served', 'completed', 'cancelled')
  ),
  CONSTRAINT orders_payment_status_check CHECK (
    payment_status IN ('unpaid', 'pending', 'paid', 'partially_refunded', 'refunded', 'failed')
  ),
  CONSTRAINT orders_payment_timing_check CHECK (payment_timing IN ('pay_before', 'pay_after')),
  CONSTRAINT orders_totals_check CHECK (
    subtotal >= 0 AND tax_total >= 0 AND service_charge_total >= 0 AND discount_total >= 0
    AND total_amount >= 0 AND total_amount = subtotal + tax_total + service_charge_total - discount_total
  )
);
CREATE INDEX idx_orders_board ON restaurant.orders (tenant_id, outlet_id, status, placed_at DESC);
CREATE INDEX idx_orders_guest ON restaurant.orders (tenant_id, guest_id) WHERE guest_id IS NOT NULL;

CREATE TABLE restaurant.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  item_id uuid NOT NULL,
  item_name_snapshot varchar(180) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  line_total numeric(18,4) NOT NULL,
  tax_amount numeric(18,4) NOT NULL DEFAULT 0,
  notes text,
  status text NOT NULL DEFAULT 'placed',
  kitchen_station_id uuid,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_lines_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES restaurant.orders (tenant_id, id),
  CONSTRAINT order_lines_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES restaurant.menu_items (tenant_id, id),
  CONSTRAINT order_lines_station_fk FOREIGN KEY (tenant_id, kitchen_station_id)
    REFERENCES restaurant.kitchen_stations (tenant_id, id),
  CONSTRAINT order_lines_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT order_lines_qty_check CHECK (quantity > 0),
  CONSTRAINT order_lines_total_check CHECK (line_total >= 0 AND unit_price >= 0),
  CONSTRAINT order_lines_status_check CHECK (status IN ('placed', 'preparing', 'ready', 'served', 'void'))
);
CREATE INDEX idx_order_lines_order ON restaurant.order_lines (tenant_id, order_id);

CREATE TABLE restaurant.kitchen_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  order_id uuid NOT NULL,
  station_id uuid,
  ticket_number varchar(40) NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  item_summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  CONSTRAINT tickets_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES restaurant.orders (tenant_id, id),
  CONSTRAINT tickets_station_fk FOREIGN KEY (tenant_id, station_id)
    REFERENCES restaurant.kitchen_stations (tenant_id, id),
  CONSTRAINT tickets_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT tickets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tickets_status_check CHECK (status IN ('queued', 'in_progress', 'ready', 'served', 'recalled'))
);
CREATE INDEX idx_tickets_board ON restaurant.kitchen_tickets (tenant_id, outlet_id, status);

CREATE TABLE restaurant.recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  yield_quantity numeric(14,3) NOT NULL DEFAULT 1,
  yield_unit varchar(30) NOT NULL DEFAULT 'portion',
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipes_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES restaurant.menu_items (tenant_id, id),
  CONSTRAINT recipes_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT recipes_item_unique UNIQUE (tenant_id, item_id),
  CONSTRAINT recipes_yield_check CHECK (yield_quantity > 0)
);

CREATE TABLE restaurant.recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  item_sku varchar(80) NOT NULL,
  quantity numeric(14,4) NOT NULL,
  unit varchar(30) NOT NULL DEFAULT 'kg',
  wastage_percent numeric(6,2) NOT NULL DEFAULT 0,
  CONSTRAINT recipe_ingredients_recipe_fk FOREIGN KEY (tenant_id, recipe_id)
    REFERENCES restaurant.recipes (tenant_id, id),
  CONSTRAINT recipe_ingredients_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT recipe_ingredients_unique UNIQUE (tenant_id, recipe_id, item_sku),
  CONSTRAINT recipe_ingredients_qty_check CHECK (quantity > 0),
  CONSTRAINT recipe_ingredients_wastage_check CHECK (wastage_percent >= 0 AND wastage_percent < 100)
);

CREATE TABLE restaurant.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  table_id uuid,
  customer_name varchar(150) NOT NULL,
  customer_phone varchar(40),
  party_size smallint NOT NULL,
  reservation_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'booked',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rest_res_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT rest_res_table_fk FOREIGN KEY (tenant_id, table_id)
    REFERENCES restaurant.tables (tenant_id, id),
  CONSTRAINT rest_res_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT rest_res_party_check CHECK (party_size > 0),
  CONSTRAINT rest_res_status_check CHECK (status IN ('booked', 'seated', 'cancelled', 'no_show', 'completed'))
);

CREATE TABLE restaurant.waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  customer_name varchar(150) NOT NULL,
  customer_phone varchar(40),
  party_size smallint NOT NULL,
  quoted_minutes integer NOT NULL DEFAULT 15,
  status text NOT NULL DEFAULT 'waiting',
  queued_at timestamptz NOT NULL DEFAULT now(),
  seated_at timestamptz,
  CONSTRAINT waitlist_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT waitlist_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT waitlist_party_check CHECK (party_size > 0),
  CONSTRAINT waitlist_status_check CHECK (status IN ('waiting', 'seated', 'abandoned'))
);

CREATE TABLE restaurant.pos_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  opened_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  opening_float numeric(18,4) NOT NULL DEFAULT 0,
  closing_count numeric(18,4),
  expected_cash numeric(18,4),
  variance numeric(18,4),
  status text NOT NULL DEFAULT 'open',
  CONSTRAINT pos_sessions_outlet_fk FOREIGN KEY (tenant_id, outlet_id)
    REFERENCES restaurant.outlets (tenant_id, id),
  CONSTRAINT pos_sessions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT pos_sessions_status_check CHECK (status IN ('open', 'closed'))
);
CREATE UNIQUE INDEX uq_pos_session_open ON restaurant.pos_sessions (tenant_id, outlet_id) WHERE status = 'open';
