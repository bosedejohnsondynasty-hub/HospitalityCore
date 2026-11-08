-- 008: housekeeping and maintenance.

CREATE TABLE housekeeping.checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  template_code varchar(40) NOT NULL,
  template_name varchar(150) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hk_templates_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT hk_templates_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_templates_code_key UNIQUE (tenant_id, hotel_id, template_code)
);

CREATE TABLE housekeeping.checklist_template_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  item_text varchar(300) NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  requires_photo boolean NOT NULL DEFAULT false,
  CONSTRAINT hk_template_items_template_fk FOREIGN KEY (tenant_id, template_id)
    REFERENCES housekeeping.checklist_templates (tenant_id, id),
  CONSTRAINT hk_template_items_tenant_key UNIQUE (tenant_id, id)
);

CREATE TABLE housekeeping.task_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  task_code varchar(40) NOT NULL,
  task_name varchar(150) NOT NULL,
  default_minutes integer NOT NULL DEFAULT 30,
  checklist_template_id uuid,
  CONSTRAINT hk_task_types_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT hk_task_types_template_fk FOREIGN KEY (tenant_id, checklist_template_id)
    REFERENCES housekeeping.checklist_templates (tenant_id, id),
  CONSTRAINT hk_task_types_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_task_types_code_key UNIQUE (tenant_id, hotel_id, task_code)
);

CREATE TABLE housekeeping.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  room_id uuid NOT NULL,
  task_type_id uuid NOT NULL,
  assigned_to uuid,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'normal',
  scheduled_for date NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hk_tasks_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT hk_tasks_type_fk FOREIGN KEY (tenant_id, task_type_id)
    REFERENCES housekeeping.task_types (tenant_id, id),
  CONSTRAINT hk_tasks_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_tasks_status_check CHECK (
    status IN ('pending', 'assigned', 'in_progress', 'completed', 'inspected', 'rejected')
  ),
  CONSTRAINT hk_tasks_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);
CREATE INDEX idx_hk_tasks_board ON housekeeping.tasks (tenant_id, hotel_id, status, scheduled_for);
CREATE TRIGGER hk_tasks_touch BEFORE UPDATE ON housekeeping.tasks
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE housekeeping.task_checklist_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  template_item_id uuid NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  note text,
  photo_ref text,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hk_results_task_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES housekeeping.tasks (tenant_id, id),
  CONSTRAINT hk_results_item_fk FOREIGN KEY (tenant_id, template_item_id)
    REFERENCES housekeeping.checklist_template_items (tenant_id, id),
  CONSTRAINT hk_results_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_results_unique UNIQUE (tenant_id, task_id, template_item_id)
);

CREATE TABLE housekeeping.inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  room_id uuid NOT NULL,
  inspected_by uuid,
  result text NOT NULL,
  score integer,
  notes text,
  inspected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hk_inspections_task_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES housekeeping.tasks (tenant_id, id),
  CONSTRAINT hk_inspections_room_fk FOREIGN KEY (tenant_id, room_id)
    REFERENCES hotel.rooms (tenant_id, id),
  CONSTRAINT hk_inspections_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_inspections_result_check CHECK (result IN ('passed', 'failed', 'rework')),
  CONSTRAINT hk_inspections_score_check CHECK (score IS NULL OR score BETWEEN 0 AND 100)
);

CREATE TABLE housekeeping.room_status_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  room_id uuid NOT NULL,
  previous_status text,
  new_status text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_room_status_log ON housekeeping.room_status_log (tenant_id, room_id, changed_at DESC);

CREATE TABLE housekeeping.linen_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  linen_code varchar(60) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  direction text NOT NULL,
  reference text,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hk_linen_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT hk_linen_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_linen_direction_check CHECK (direction IN ('issued', 'returned', 'discarded', 'laundry_out', 'laundry_in')),
  CONSTRAINT hk_linen_quantity_check CHECK (quantity > 0)
);

CREATE TABLE housekeeping.minibar_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  room_id uuid NOT NULL,
  stay_id uuid,
  item_code varchar(80) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  charge_amount numeric(18,4) NOT NULL DEFAULT 0,
  folio_entry_id uuid,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hk_minibar_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT hk_minibar_stay_fk FOREIGN KEY (tenant_id, hotel_id, stay_id)
    REFERENCES hotel.stays (tenant_id, hotel_id, id),
  CONSTRAINT hk_minibar_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_minibar_folio_fk FOREIGN KEY (tenant_id, folio_entry_id)
    REFERENCES hotel.folio_entries (tenant_id, id),
  CONSTRAINT hk_minibar_quantity_check CHECK (quantity > 0)
);

CREATE TABLE housekeeping.room_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  room_id uuid NOT NULL,
  discrepancy_type text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  reported_by uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hk_disc_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT hk_disc_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hk_disc_type_check CHECK (discrepancy_type IN ('damage', 'lost_property', 'sleeps', 'maintenance', 'minibar', 'cleanliness', 'other')),
  CONSTRAINT hk_disc_status_check CHECK (status IN ('open', 'investigating', 'resolved', 'written_off'))
);

-- ---------------------------------------------------------------------------
-- Maintenance
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  asset_code varchar(60) NOT NULL,
  asset_name varchar(200) NOT NULL,
  category varchar(80) NOT NULL,
  location varchar(150),
  serial_number varchar(120),
  installed_on date,
  warranty_expires_on date,
  status text NOT NULL DEFAULT 'in_service',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT assets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT assets_code_key UNIQUE (tenant_id, branch_id, asset_code),
  CONSTRAINT assets_status_check CHECK (status IN ('in_service', 'under_maintenance', 'out_of_service', 'retired'))
);
CREATE TRIGGER assets_touch BEFORE UPDATE ON maintenance.assets
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE maintenance.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  room_id uuid,
  asset_id uuid,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'open',
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_requests_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT maint_requests_room_fk FOREIGN KEY (tenant_id, room_id)
    REFERENCES hotel.rooms (tenant_id, id),
  CONSTRAINT maint_requests_asset_fk FOREIGN KEY (tenant_id, asset_id)
    REFERENCES maintenance.assets (tenant_id, id),
  CONSTRAINT maint_requests_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT maint_requests_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT maint_requests_status_check CHECK (status IN ('open', 'approved', 'rejected', 'converted', 'closed'))
);

CREATE TABLE maintenance.work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  request_id uuid,
  asset_id uuid,
  room_id uuid,
  work_order_number varchar(40) NOT NULL,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'created',
  assigned_to uuid,
  sla_due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  verified_by uuid,
  verified_at timestamptz,
  labour_cost numeric(18,4) NOT NULL DEFAULT 0,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wo_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT wo_request_fk FOREIGN KEY (tenant_id, request_id)
    REFERENCES maintenance.requests (tenant_id, id),
  CONSTRAINT wo_asset_fk FOREIGN KEY (tenant_id, asset_id)
    REFERENCES maintenance.assets (tenant_id, id),
  CONSTRAINT wo_room_fk FOREIGN KEY (tenant_id, room_id)
    REFERENCES hotel.rooms (tenant_id, id),
  CONSTRAINT wo_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT wo_number_key UNIQUE (tenant_id, work_order_number),
  CONSTRAINT wo_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT wo_status_check CHECK (
    status IN ('created', 'assigned', 'in_progress', 'on_hold', 'completed', 'verified', 'cancelled')
  )
);
CREATE TRIGGER wo_touch BEFORE UPDATE ON maintenance.work_orders
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE maintenance.work_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  item_code varchar(80) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_cost numeric(18,4) NOT NULL DEFAULT 0,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wo_parts_wo_fk FOREIGN KEY (tenant_id, work_order_id)
    REFERENCES maintenance.work_orders (tenant_id, id),
  CONSTRAINT wo_parts_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT wo_parts_quantity_check CHECK (quantity > 0)
);

CREATE TABLE maintenance.pm_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  schedule_name varchar(150) NOT NULL,
  frequency_days integer NOT NULL,
  last_completed_on date,
  next_due_on date NOT NULL,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pm_asset_fk FOREIGN KEY (tenant_id, asset_id)
    REFERENCES maintenance.assets (tenant_id, id),
  CONSTRAINT pm_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT pm_frequency_check CHECK (frequency_days > 0)
);

CREATE TABLE maintenance.downtime_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  reason text NOT NULL,
  work_order_id uuid,
  CONSTRAINT downtime_asset_fk FOREIGN KEY (tenant_id, asset_id)
    REFERENCES maintenance.assets (tenant_id, id),
  CONSTRAINT downtime_wo_fk FOREIGN KEY (tenant_id, work_order_id)
    REFERENCES maintenance.work_orders (tenant_id, id),
  CONSTRAINT downtime_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT downtime_range_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);
