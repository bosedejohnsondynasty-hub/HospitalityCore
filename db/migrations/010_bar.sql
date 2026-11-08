-- 010: bar product schema (standalone, no hotel or restaurant dependency).

CREATE TABLE bar.outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  bar_code varchar(40) NOT NULL,
  bar_name varchar(150) NOT NULL,
  bar_type text NOT NULL DEFAULT 'lounge',
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  tax_rate numeric(6,4) NOT NULL DEFAULT 0.0750,
  service_charge_rate numeric(6,4) NOT NULL DEFAULT 0.1000,
  allow_charge_to_room boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bar_outlets_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT bar_outlets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bar_outlets_code_key UNIQUE (tenant_id, branch_id, bar_code),
  CONSTRAINT bar_outlets_type_check CHECK (bar_type IN ('lounge', 'pub', 'nightclub', 'pool_bar', 'restaurant_bar', 'event_bar')),
  CONSTRAINT bar_outlets_rates_check CHECK (tax_rate >= 0 AND tax_rate < 1 AND service_charge_rate >= 0 AND service_charge_rate < 1),
  CONSTRAINT bar_outlets_status_check CHECK (status IN ('active', 'inactive', 'suspended'))
);
CREATE TRIGGER bar_outlets_touch BEFORE UPDATE ON bar.outlets
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE bar.beverages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  bar_id uuid NOT NULL,
  sku varchar(60) NOT NULL,
  beverage_name varchar(180) NOT NULL,
  category text NOT NULL DEFAULT 'beer',
  serving_size_ml integer,
  sale_price numeric(18,4) NOT NULL,
  cost_price numeric(18,4) NOT NULL DEFAULT 0,
  is_alcoholic boolean NOT NULL DEFAULT true,
  is_available boolean NOT NULL DEFAULT true,
  inventory_sku varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beverages_bar_fk FOREIGN KEY (tenant_id, bar_id)
    REFERENCES bar.outlets (tenant_id, id),
  CONSTRAINT beverages_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT beverages_sku_key UNIQUE (tenant_id, bar_id, sku),
  CONSTRAINT beverages_category_check CHECK (category IN ('beer', 'wine', 'spirit', 'cocktail', 'soft_drink', 'water', 'hot_drink', 'other')),
  CONSTRAINT beverages_price_check CHECK (sale_price >= 0 AND cost_price >= 0)
);
CREATE TRIGGER beverages_touch BEFORE UPDATE ON bar.beverages
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE bar.recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  beverage_id uuid NOT NULL,
  yield_servings numeric(14,3) NOT NULL DEFAULT 1,
  preparation text,
  CONSTRAINT bar_recipes_beverage_fk FOREIGN KEY (tenant_id, beverage_id)
    REFERENCES bar.beverages (tenant_id, id),
  CONSTRAINT bar_recipes_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bar_recipes_unique UNIQUE (tenant_id, beverage_id),
  CONSTRAINT bar_recipes_yield_check CHECK (yield_servings > 0)
);

CREATE TABLE bar.recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  item_sku varchar(80) NOT NULL,
  quantity numeric(14,4) NOT NULL,
  unit varchar(30) NOT NULL DEFAULT 'ml',
  CONSTRAINT bar_recipe_ingredients_fk FOREIGN KEY (tenant_id, recipe_id)
    REFERENCES bar.recipes (tenant_id, id),
  CONSTRAINT bar_recipe_ingredients_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bar_recipe_ingredients_unique UNIQUE (tenant_id, recipe_id, item_sku),
  CONSTRAINT bar_recipe_ingredients_qty_check CHECK (quantity > 0)
);

CREATE TABLE bar.tabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  bar_id uuid NOT NULL,
  tab_number varchar(40) NOT NULL,
  customer_name varchar(150),
  guest_id uuid,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT tabs_bar_fk FOREIGN KEY (tenant_id, bar_id)
    REFERENCES bar.outlets (tenant_id, id),
  CONSTRAINT tabs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tabs_number_key UNIQUE (tenant_id, bar_id, tab_number),
  CONSTRAINT tabs_status_check CHECK (status IN ('open', 'closed', 'void'))
);

CREATE TABLE bar.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  bar_id uuid NOT NULL,
  tab_id uuid,
  order_number varchar(40) NOT NULL,
  channel text NOT NULL DEFAULT 'counter',
  guest_id uuid,
  customer_name varchar(150),
  status text NOT NULL DEFAULT 'open',
  payment_status text NOT NULL DEFAULT 'unpaid',
  subtotal numeric(18,4) NOT NULL DEFAULT 0,
  tax_total numeric(18,4) NOT NULL DEFAULT 0,
  service_charge_total numeric(18,4) NOT NULL DEFAULT 0,
  total_amount numeric(18,4) NOT NULL DEFAULT 0,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  served_by uuid,
  folio_id uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_by uuid,
  CONSTRAINT bar_orders_outlet_fk FOREIGN KEY (tenant_id, bar_id)
    REFERENCES bar.outlets (tenant_id, id),
  CONSTRAINT bar_orders_tab_fk FOREIGN KEY (tenant_id, tab_id)
    REFERENCES bar.tabs (tenant_id, id),
  CONSTRAINT bar_orders_folio_fk FOREIGN KEY (tenant_id, folio_id)
    REFERENCES hotel.folios (tenant_id, id),
  CONSTRAINT bar_orders_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bar_orders_number_key UNIQUE (tenant_id, bar_id, order_number),
  CONSTRAINT bar_orders_channel_check CHECK (channel IN ('counter', 'table', 'tab', 'room_service', 'event')),
  CONSTRAINT bar_orders_status_check CHECK (status IN ('open', 'served', 'closed', 'cancelled')),
  CONSTRAINT bar_orders_payment_status_check CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'refunded', 'failed')),
  CONSTRAINT bar_orders_totals_check CHECK (
    subtotal >= 0 AND tax_total >= 0 AND service_charge_total >= 0 AND total_amount >= 0
    AND total_amount = subtotal + tax_total + service_charge_total
  )
);
CREATE INDEX idx_bar_orders_board ON bar.orders (tenant_id, bar_id, status, opened_at DESC);

CREATE TABLE bar.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  beverage_id uuid NOT NULL,
  beverage_name_snapshot varchar(180) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  line_total numeric(18,4) NOT NULL,
  status text NOT NULL DEFAULT 'served',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bar_lines_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES bar.orders (tenant_id, id),
  CONSTRAINT bar_lines_beverage_fk FOREIGN KEY (tenant_id, beverage_id)
    REFERENCES bar.beverages (tenant_id, id),
  CONSTRAINT bar_lines_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bar_lines_qty_check CHECK (quantity > 0),
  CONSTRAINT bar_lines_status_check CHECK (status IN ('ordered', 'served', 'void'))
);

CREATE TABLE bar.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  bar_id uuid NOT NULL,
  event_name varchar(180) NOT NULL,
  event_date date NOT NULL,
  starts_at time,
  capacity integer,
  ticket_price numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned',
  description text,
  CONSTRAINT bar_events_outlet_fk FOREIGN KEY (tenant_id, bar_id)
    REFERENCES bar.outlets (tenant_id, id),
  CONSTRAINT bar_events_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bar_events_status_check CHECK (status IN ('planned', 'on_sale', 'sold_out', 'completed', 'cancelled'))
);
