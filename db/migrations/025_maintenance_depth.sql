-- 025: Maintenance & Engineering depth.
--
-- The v2.5 dedicated Maintenance specification requires more than a ticket log:
-- a guest-room location category, configurable Electrical/Plumbing teams, an
-- admin-configurable checklist engine with weekly/monthly/custom recurrence,
-- housekeeping-to-maintenance fault handoff, SLA classification, authorised
-- verification and a room-readiness gate. This migration adds that structure.
--
-- Existing tables are extended, not replaced: maintenance.requests stays the
-- fault intake, maintenance.work_orders stays the job record.

CREATE TABLE maintenance.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  team_code varchar(40) NOT NULL,
  team_name varchar(120) NOT NULL,
  trade text NOT NULL DEFAULT 'general',
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_teams_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT maint_teams_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT maint_teams_code_key UNIQUE (tenant_id, hotel_id, team_code),
  CONSTRAINT maint_teams_trade_check CHECK (trade IN ('electrical', 'plumbing', 'hvac', 'general', 'other'))
);
CREATE TRIGGER maint_teams_touch BEFORE UPDATE ON maintenance.teams
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Guest Rooms are a dedicated first-class category, not free-text locations.
-- Physical rooms stay owned by hotel.rooms; this table adds every other area.
CREATE TABLE maintenance.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  location_code varchar(40) NOT NULL,
  location_name varchar(150) NOT NULL,
  category text NOT NULL,
  floor_label varchar(40),
  room_id uuid,
  parent_location_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_locations_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT maint_locations_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT maint_locations_parent_fk FOREIGN KEY (tenant_id, parent_location_id)
    REFERENCES maintenance.locations (tenant_id, id),
  CONSTRAINT maint_locations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT maint_locations_code_key UNIQUE (tenant_id, hotel_id, location_code),
  CONSTRAINT maint_locations_category_check CHECK (
    category IN ('guest_room', 'public_area', 'food_beverage', 'back_of_house', 'plant', 'external')
  ),
  CONSTRAINT maint_locations_room_category_check CHECK (room_id IS NULL OR category = 'guest_room')
);
CREATE TRIGGER maint_locations_touch BEFORE UPDATE ON maintenance.locations
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE INDEX idx_maint_locations_category ON maintenance.locations (tenant_id, hotel_id, category);

-- Read-only projection that makes every physical room selectable as a location.
CREATE OR REPLACE VIEW maintenance.guest_room_locations AS
SELECT r.tenant_id,
       r.hotel_id,
       r.id AS room_id,
       r.room_number AS location_code,
       ('Room ' || r.room_number) AS location_name,
       'guest_room'::text AS category,
       r.floor_label,
       r.housekeeping_status,
       r.is_out_of_order
FROM hotel.rooms r;

CREATE TABLE maintenance.sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid,
  priority text NOT NULL,
  acknowledge_hours integer NOT NULL,
  resolve_hours integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_sla_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT maint_sla_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT maint_sla_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT maint_sla_hours_check CHECK (acknowledge_hours > 0 AND resolve_hours >= acknowledge_hours)
);
CREATE UNIQUE INDEX maint_sla_scope_key ON maintenance.sla_policies (
  tenant_id,
  coalesce(hotel_id, '00000000-0000-0000-0000-000000000000'::uuid),
  priority
);
CREATE TRIGGER maint_sla_touch BEFORE UPDATE ON maintenance.sla_policies
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE maintenance.checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  template_code varchar(40) NOT NULL,
  template_name varchar(180) NOT NULL,
  department text NOT NULL DEFAULT 'maintenance',
  team_id uuid,
  location_category text,
  room_type_id uuid,
  room_id uuid,
  location_id uuid,
  frequency text NOT NULL DEFAULT 'daily',
  days_of_week smallint[],
  interval_weeks integer,
  due_time time NOT NULL DEFAULT '09:00',
  grace_hours integer NOT NULL DEFAULT 4,
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,
  version integer NOT NULL DEFAULT 1,
  requires_verification boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_tpl_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT maint_tpl_team_fk FOREIGN KEY (tenant_id, team_id)
    REFERENCES maintenance.teams (tenant_id, id),
  CONSTRAINT maint_tpl_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT maint_tpl_location_fk FOREIGN KEY (tenant_id, location_id)
    REFERENCES maintenance.locations (tenant_id, id),
  CONSTRAINT maint_tpl_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT maint_tpl_code_key UNIQUE (tenant_id, hotel_id, template_code),
  CONSTRAINT maint_tpl_department_check CHECK (department IN ('housekeeping', 'maintenance')),
  CONSTRAINT maint_tpl_category_check CHECK (
    location_category IS NULL
    OR location_category IN ('guest_room', 'public_area', 'food_beverage', 'back_of_house', 'plant', 'external')
  ),
  CONSTRAINT maint_tpl_frequency_check CHECK (
    frequency IN ('daily', 'selected_days', 'weekly', 'every_n_weeks', 'monthly', 'quarterly', 'annually', 'one_off')
  ),
  CONSTRAINT maint_tpl_schedule_check CHECK (
    (frequency IN ('selected_days', 'weekly') AND days_of_week IS NOT NULL AND array_length(days_of_week, 1) > 0)
    OR (frequency = 'every_n_weeks' AND interval_weeks IS NOT NULL AND interval_weeks > 0
        AND days_of_week IS NOT NULL AND array_length(days_of_week, 1) > 0)
    OR frequency IN ('daily', 'monthly', 'quarterly', 'annually', 'one_off')
  ),
  CONSTRAINT maint_tpl_days_check CHECK (
    days_of_week IS NULL OR days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
  ),
  CONSTRAINT maint_tpl_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE TRIGGER maint_tpl_touch BEFORE UPDATE ON maintenance.checklist_templates
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE maintenance.checklist_template_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  position integer NOT NULL DEFAULT 0,
  item_code varchar(40) NOT NULL,
  prompt varchar(300) NOT NULL,
  input_type text NOT NULL DEFAULT 'pass_fail',
  unit varchar(30),
  is_mandatory boolean NOT NULL DEFAULT true,
  fault_category text,
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_tpl_item_tpl_fk FOREIGN KEY (tenant_id, template_id)
    REFERENCES maintenance.checklist_templates (tenant_id, id),
  CONSTRAINT maint_tpl_item_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT maint_tpl_item_code_key UNIQUE (tenant_id, template_id, item_code),
  CONSTRAINT maint_tpl_item_input_check CHECK (input_type IN ('pass_fail', 'yes_no', 'numeric', 'text')),
  CONSTRAINT maint_tpl_item_fault_check CHECK (
    fault_category IS NULL
    OR fault_category IN ('electrical', 'plumbing', 'hvac', 'general', 'safety')
  )
);
CREATE TRIGGER maint_tpl_item_touch BEFORE UPDATE ON maintenance.checklist_template_items
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- One row per scheduled occurrence. The unique key is the duplicate-prevention
-- guarantee the specification asks for: regenerating a date cannot double-create.
CREATE TABLE maintenance.checklist_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version integer NOT NULL,
  scope_key text NOT NULL,
  room_id uuid,
  location_id uuid,
  scheduled_for date NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  assigned_team_id uuid,
  assigned_user_id uuid,
  completed_at timestamptz,
  completed_by uuid,
  completion_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_inst_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT maint_inst_tpl_fk FOREIGN KEY (tenant_id, template_id)
    REFERENCES maintenance.checklist_templates (tenant_id, id),
  CONSTRAINT maint_inst_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT maint_inst_location_fk FOREIGN KEY (tenant_id, location_id)
    REFERENCES maintenance.locations (tenant_id, id),
  CONSTRAINT maint_inst_team_fk FOREIGN KEY (tenant_id, assigned_team_id)
    REFERENCES maintenance.teams (tenant_id, id),
  CONSTRAINT maint_inst_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT maint_inst_once_key UNIQUE (tenant_id, template_id, scheduled_for, scope_key),
  CONSTRAINT maint_inst_status_check CHECK (
    status IN ('pending', 'in_progress', 'completed', 'missed', 'skipped')
  )
);
CREATE TRIGGER maint_inst_touch BEFORE UPDATE ON maintenance.checklist_instances
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE INDEX idx_maint_inst_due ON maintenance.checklist_instances (tenant_id, hotel_id, status, due_at);

CREATE TABLE maintenance.checklist_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  template_item_id uuid NOT NULL,
  result text NOT NULL,
  numeric_value numeric(14,3),
  remark text,
  fault_request_id uuid,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_result_inst_fk FOREIGN KEY (tenant_id, instance_id)
    REFERENCES maintenance.checklist_instances (tenant_id, id),
  CONSTRAINT maint_result_item_fk FOREIGN KEY (tenant_id, template_item_id)
    REFERENCES maintenance.checklist_template_items (tenant_id, id),
  CONSTRAINT maint_result_fault_fk FOREIGN KEY (tenant_id, fault_request_id)
    REFERENCES maintenance.requests (tenant_id, id),
  CONSTRAINT maint_result_unique UNIQUE (tenant_id, instance_id, template_item_id),
  CONSTRAINT maint_result_value_check CHECK (result IN ('pass', 'fail', 'na', 'unable')),
  CONSTRAINT maint_result_remark_check CHECK (result IN ('pass', 'fail') OR remark IS NOT NULL)
);

-- Fault intake gains the routing, impact and SLA fields the handoff needs.
ALTER TABLE maintenance.requests
  ADD COLUMN IF NOT EXISTS location_id uuid,
  ADD COLUMN IF NOT EXISTS team_id uuid,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS severity text,
  ADD COLUMN IF NOT EXISTS affects_room_readiness boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sla_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS housekeeping_task_id uuid,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE maintenance.requests
  ADD CONSTRAINT maint_requests_location_fk FOREIGN KEY (tenant_id, location_id)
    REFERENCES maintenance.locations (tenant_id, id),
  ADD CONSTRAINT maint_requests_team_fk FOREIGN KEY (tenant_id, team_id)
    REFERENCES maintenance.teams (tenant_id, id),
  ADD CONSTRAINT maint_requests_hk_task_fk FOREIGN KEY (tenant_id, housekeeping_task_id)
    REFERENCES housekeeping.tasks (tenant_id, id),
  ADD CONSTRAINT maint_requests_category_check CHECK (
    category IS NULL OR category IN ('electrical', 'plumbing', 'hvac', 'general', 'safety')
  ),
  ADD CONSTRAINT maint_requests_source_check CHECK (
    source IN ('manual', 'housekeeping', 'front_office', 'guest', 'inspection', 'preventive', 'emergency')
  );

ALTER TABLE maintenance.work_orders
  ADD COLUMN IF NOT EXISTS team_id uuid,
  ADD COLUMN IF NOT EXISTS location_id uuid,
  ADD COLUMN IF NOT EXISTS affects_room_readiness boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_note text,
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS reopened_count integer NOT NULL DEFAULT 0;

ALTER TABLE maintenance.work_orders
  ADD CONSTRAINT wo_team_fk FOREIGN KEY (tenant_id, team_id)
    REFERENCES maintenance.teams (tenant_id, id),
  ADD CONSTRAINT wo_location_fk FOREIGN KEY (tenant_id, location_id)
    REFERENCES maintenance.locations (tenant_id, id);

-- Default trades and SLA policies for tenants that already exist. New tenants get
-- the same rows from onboarding.
INSERT INTO maintenance.teams (tenant_id, hotel_id, team_code, team_name, trade, description)
SELECT h.tenant_id, h.id, v.team_code, v.team_name, v.trade, v.description
FROM hotel.hotels h
CROSS JOIN (VALUES
  ('ELEC', 'Electrical', 'electrical', 'Lighting, sockets, distribution boards, emergency lighting.'),
  ('PLUMB', 'Plumbing', 'plumbing', 'Taps, showers, drainage, leaks and water pressure.'),
  ('HVAC', 'HVAC', 'hvac', 'Air conditioning, ventilation and refrigeration.'),
  ('GEN', 'General maintenance', 'general', 'Building fabric, furniture, carpentry and general repairs.')
) AS v (team_code, team_name, trade, description)
WHERE NOT EXISTS (
  SELECT 1 FROM maintenance.teams t
  WHERE t.tenant_id = h.tenant_id AND t.hotel_id = h.id AND t.team_code = v.team_code
);

INSERT INTO maintenance.sla_policies (tenant_id, hotel_id, priority, acknowledge_hours, resolve_hours)
SELECT h.tenant_id, NULL, v.priority, v.ack_hours, v.resolve_hours
FROM hotel.hotels h
CROSS JOIN (VALUES
  ('urgent', 1, 4),
  ('high', 2, 8),
  ('normal', 4, 24),
  ('low', 8, 72)
) AS v (priority, ack_hours, resolve_hours)
WHERE NOT EXISTS (
  SELECT 1 FROM maintenance.sla_policies p
  WHERE p.tenant_id = h.tenant_id AND p.hotel_id IS NULL AND p.priority = v.priority
);

INSERT INTO access.permissions (permission_code, product_code, module_code, resource, action, description, is_privileged)
SELECT v.permission_code, v.product_code, v.module_code, v.resource, v.action, v.description, v.is_privileged
FROM (VALUES
  ('hotel.maintenance.config', 'hotel', 'maintenance', 'teams', 'config', 'Configure trades, locations, checklists and SLA policies.', true),
  ('hotel.maintenance.verify', 'hotel', 'maintenance', 'workorders', 'verify', 'Verify and sign off completed maintenance work.', true)
) AS v (permission_code, product_code, module_code, resource, action, description, is_privileged)
WHERE NOT EXISTS (
  SELECT 1 FROM access.permissions p WHERE p.permission_code = v.permission_code
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  maintenance.teams,
  maintenance.locations,
  maintenance.sla_policies,
  maintenance.checklist_templates,
  maintenance.checklist_template_items,
  maintenance.checklist_instances,
  maintenance.checklist_results
TO hospitality_app;
GRANT SELECT ON maintenance.guest_room_locations TO hospitality_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA maintenance
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hospitality_app;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'maintenance'
      AND t.table_type = 'BASE TABLE'
      AND t.table_name IN ('teams', 'locations', 'sla_policies', 'checklist_templates',
                           'checklist_template_items', 'checklist_instances', 'checklist_results')
  LOOP
    EXECUTE format('ALTER TABLE maintenance.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON maintenance.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON maintenance.%I '
      'USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      r.table_name
    );
  END LOOP;
END $$;
