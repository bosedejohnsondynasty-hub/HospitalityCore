-- 011: inventory, stock ledger and procurement.

CREATE TABLE inventory.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  sku varchar(80) NOT NULL,
  item_name varchar(200) NOT NULL,
  category text NOT NULL DEFAULT 'food',
  base_unit varchar(30) NOT NULL DEFAULT 'unit',
  valuation_method text NOT NULL DEFAULT 'weighted_average',
  is_batch_tracked boolean NOT NULL DEFAULT false,
  track_expiry boolean NOT NULL DEFAULT false,
  reorder_level numeric(14,3) NOT NULL DEFAULT 0,
  standard_cost numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT items_sku_key UNIQUE (tenant_id, sku),
  CONSTRAINT items_category_check CHECK (
    category IN ('food', 'beverage', 'linen', 'amenity', 'cleaning', 'engineering', 'packaging', 'other')
  ),
  CONSTRAINT items_valuation_check CHECK (valuation_method IN ('weighted_average', 'fifo', 'standard')),
  CONSTRAINT items_cost_check CHECK (standard_cost >= 0 AND reorder_level >= 0)
);
CREATE TRIGGER items_touch BEFORE UPDATE ON inventory.items
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE inventory.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  store_code varchar(40) NOT NULL,
  store_name varchar(150) NOT NULL,
  store_type text NOT NULL DEFAULT 'main',
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT stores_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT stores_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT stores_code_key UNIQUE (tenant_id, branch_id, store_code),
  CONSTRAINT stores_type_check CHECK (
    store_type IN ('main', 'kitchen', 'bar', 'housekeeping', 'engineering', 'retail')
  )
);

CREATE TABLE inventory.stock_balances (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(16,4) NOT NULL DEFAULT 0,
  average_cost numeric(18,4) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id, item_id),
  CONSTRAINT stock_balances_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT stock_balances_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES inventory.items (tenant_id, id)
);

-- Append-only stock ledger. Every movement has a defined inventory effect and a
-- source reference; the unique index makes duplicate postings impossible.
CREATE TABLE inventory.movements (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  store_id uuid NOT NULL,
  item_id uuid NOT NULL,
  movement_type text NOT NULL,
  quantity numeric(16,4) NOT NULL,
  unit_cost numeric(18,4) NOT NULL DEFAULT 0,
  total_cost numeric(18,4) NOT NULL DEFAULT 0,
  reference_type text,
  reference_id text,
  batch_no varchar(80),
  expiry_date date,
  notes text,
  business_date date NOT NULL DEFAULT current_date,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movements_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT movements_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT movements_type_check CHECK (
    movement_type IN ('receipt', 'issue', 'transfer_in', 'transfer_out', 'adjustment',
                      'wastage', 'return_to_supplier', 'count_variance', 'production')
  ),
  CONSTRAINT movements_quantity_check CHECK (quantity <> 0),
  CONSTRAINT movements_cost_check CHECK (unit_cost >= 0)
);
CREATE UNIQUE INDEX uq_movements_source ON inventory.movements
  (tenant_id, reference_type, reference_id, item_id, movement_type)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
CREATE INDEX idx_movements_item ON inventory.movements (tenant_id, item_id, created_at DESC);
CREATE TRIGGER movements_append_only BEFORE UPDATE OR DELETE ON inventory.movements
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

-- Maintain stock balances atomically with the ledger.
CREATE OR REPLACE FUNCTION inventory_apply_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO inventory.stock_balances AS sb (tenant_id, store_id, item_id, quantity, average_cost)
  VALUES (NEW.tenant_id, NEW.store_id, NEW.item_id, NEW.quantity, NEW.unit_cost)
  ON CONFLICT (tenant_id, store_id, item_id)
  DO UPDATE SET
    quantity = sb.quantity + NEW.quantity,
    average_cost = CASE
      WHEN NEW.quantity > 0 AND sb.quantity + NEW.quantity > 0
        THEN ((sb.quantity * sb.average_cost) + (NEW.quantity * NEW.unit_cost)) / (sb.quantity + NEW.quantity)
      ELSE sb.average_cost
    END,
    updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER movements_apply AFTER INSERT ON inventory.movements
  FOR EACH ROW EXECUTE FUNCTION inventory_apply_movement();

-- ---------------------------------------------------------------------------
-- Procurement
-- ---------------------------------------------------------------------------
CREATE TABLE procurement.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_code varchar(40) NOT NULL,
  supplier_name varchar(200) NOT NULL,
  contact_name varchar(150),
  email varchar(254),
  phone varchar(40),
  address_line text,
  payment_terms_days integer NOT NULL DEFAULT 30,
  tax_identification_number varchar(80),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT suppliers_code_key UNIQUE (tenant_id, supplier_code),
  CONSTRAINT suppliers_terms_check CHECK (payment_terms_days >= 0)
);

CREATE TABLE procurement.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  po_number varchar(40) NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  order_date date NOT NULL DEFAULT current_date,
  expected_date date,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  subtotal numeric(18,4) NOT NULL DEFAULT 0,
  tax_total numeric(18,4) NOT NULL DEFAULT 0,
  total_amount numeric(18,4) NOT NULL DEFAULT 0,
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES procurement.suppliers (tenant_id, id),
  CONSTRAINT po_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT po_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT po_number_key UNIQUE (tenant_id, po_number),
  CONSTRAINT po_status_check CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'partially_received', 'received', 'cancelled')
  ),
  CONSTRAINT po_totals_check CHECK (subtotal >= 0 AND tax_total >= 0 AND total_amount >= 0)
);

CREATE TABLE procurement.purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_cost numeric(18,4) NOT NULL,
  line_total numeric(18,4) NOT NULL,
  received_quantity numeric(14,3) NOT NULL DEFAULT 0,
  CONSTRAINT po_lines_po_fk FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES procurement.purchase_orders (tenant_id, id),
  CONSTRAINT po_lines_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT po_lines_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT po_lines_qty_check CHECK (quantity > 0 AND received_quantity >= 0),
  CONSTRAINT po_lines_cost_check CHECK (unit_cost >= 0 AND line_total >= 0)
);

CREATE TABLE procurement.goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  store_id uuid NOT NULL,
  purchase_order_id uuid,
  supplier_id uuid NOT NULL,
  grn_number varchar(40) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid,
  supplier_invoice_number varchar(80),
  status text NOT NULL DEFAULT 'posted',
  notes text,
  CONSTRAINT grn_po_fk FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES procurement.purchase_orders (tenant_id, id),
  CONSTRAINT grn_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES procurement.suppliers (tenant_id, id),
  CONSTRAINT grn_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES inventory.stores (tenant_id, id),
  CONSTRAINT grn_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT grn_number_key UNIQUE (tenant_id, grn_number),
  CONSTRAINT grn_status_check CHECK (status IN ('draft', 'posted', 'cancelled'))
);

CREATE TABLE procurement.goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  goods_receipt_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_cost numeric(18,4) NOT NULL,
  batch_no varchar(80),
  expiry_date date,
  CONSTRAINT grn_lines_grn_fk FOREIGN KEY (tenant_id, goods_receipt_id)
    REFERENCES procurement.goods_receipts (tenant_id, id),
  CONSTRAINT grn_lines_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES inventory.items (tenant_id, id),
  CONSTRAINT grn_lines_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT grn_lines_qty_check CHECK (quantity > 0),
  CONSTRAINT grn_lines_cost_check CHECK (unit_cost >= 0)
);

CREATE TABLE procurement.supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  purchase_order_id uuid,
  goods_receipt_id uuid,
  invoice_number varchar(80) NOT NULL,
  invoice_date date NOT NULL,
  due_date date,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  amount numeric(18,4) NOT NULL,
  tax_amount numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  match_status text NOT NULL DEFAULT 'unmatched',
  discrepancy_note text,
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoices_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES procurement.suppliers (tenant_id, id),
  CONSTRAINT supplier_invoices_po_fk FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES procurement.purchase_orders (tenant_id, id),
  CONSTRAINT supplier_invoices_grn_fk FOREIGN KEY (tenant_id, goods_receipt_id)
    REFERENCES procurement.goods_receipts (tenant_id, id),
  CONSTRAINT supplier_invoices_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT supplier_invoices_number_key UNIQUE (tenant_id, supplier_id, invoice_number),
  CONSTRAINT supplier_invoices_amount_check CHECK (amount >= 0 AND tax_amount >= 0),
  CONSTRAINT supplier_invoices_status_check CHECK (status IN ('open', 'approved', 'paid', 'disputed', 'void')),
  CONSTRAINT supplier_invoices_match_check CHECK (match_status IN ('unmatched', 'matched', 'exception'))
);
