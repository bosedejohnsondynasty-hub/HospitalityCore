-- 005: hotel configuration - hotel profile, room types, rooms, rate plans,
--      business dates and night audit runs.

CREATE TABLE hotel.hotels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  hotel_code varchar(40) NOT NULL,
  hotel_name varchar(200) NOT NULL,
  star_rating smallint,
  check_in_time time NOT NULL DEFAULT '14:00',
  check_out_time time NOT NULL DEFAULT '12:00',
  default_currency char(3) NOT NULL DEFAULT 'NGN',
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  tax_rate numeric(6,4) NOT NULL DEFAULT 0.0750,
  service_charge_rate numeric(6,4) NOT NULL DEFAULT 0.1000,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hotels_branch_fk FOREIGN KEY (tenant_id, organization_id, branch_id)
    REFERENCES platform.branches (tenant_id, organization_id, id),
  CONSTRAINT hotels_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT hotels_branch_unique UNIQUE (tenant_id, branch_id),
  CONSTRAINT hotels_code_key UNIQUE (tenant_id, organization_id, hotel_code),
  CONSTRAINT hotels_rating_check CHECK (star_rating IS NULL OR star_rating BETWEEN 1 AND 5),
  CONSTRAINT hotels_rate_check CHECK (tax_rate >= 0 AND tax_rate < 1 AND service_charge_rate >= 0 AND service_charge_rate < 1)
);
CREATE TRIGGER hotels_touch BEFORE UPDATE ON hotel.hotels
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE hotel.room_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  room_type_code varchar(40) NOT NULL,
  room_type_name varchar(120) NOT NULL,
  description text,
  capacity_adults smallint NOT NULL DEFAULT 2,
  capacity_children smallint NOT NULL DEFAULT 0,
  base_rate numeric(18,4) NOT NULL,
  extra_bed_rate numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_types_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT room_types_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT room_types_hotel_key UNIQUE (tenant_id, hotel_id, id),
  CONSTRAINT room_types_code_key UNIQUE (tenant_id, hotel_id, room_type_code),
  CONSTRAINT room_types_capacity_check CHECK (capacity_adults > 0 AND capacity_children >= 0),
  CONSTRAINT room_types_rate_check CHECK (base_rate >= 0 AND extra_bed_rate >= 0)
);
CREATE TRIGGER room_types_touch BEFORE UPDATE ON hotel.room_types
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE hotel.rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  room_number varchar(20) NOT NULL,
  floor_label varchar(20),
  occupancy_status text NOT NULL DEFAULT 'vacant',
  housekeeping_status text NOT NULL DEFAULT 'clean',
  is_out_of_order boolean NOT NULL DEFAULT false,
  out_of_order_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_type_fk FOREIGN KEY (tenant_id, hotel_id, room_type_id)
    REFERENCES hotel.room_types (tenant_id, hotel_id, id),
  CONSTRAINT rooms_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT rooms_hotel_key UNIQUE (tenant_id, hotel_id, id),
  CONSTRAINT rooms_number_key UNIQUE (tenant_id, hotel_id, room_number),
  CONSTRAINT rooms_occupancy_check CHECK (occupancy_status IN ('vacant', 'occupied', 'reserved', 'blocked')),
  CONSTRAINT rooms_hk_check CHECK (housekeeping_status IN ('clean', 'dirty', 'inspected', 'in_progress'))
);
CREATE TRIGGER rooms_touch BEFORE UPDATE ON hotel.rooms
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE hotel.rate_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  room_type_id uuid,
  rate_plan_code varchar(40) NOT NULL,
  rate_plan_name varchar(120) NOT NULL,
  meal_plan text NOT NULL DEFAULT 'room_only',
  cancellation_policy text,
  is_refundable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_plans_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT rate_plans_type_fk FOREIGN KEY (tenant_id, hotel_id, room_type_id)
    REFERENCES hotel.room_types (tenant_id, hotel_id, id),
  CONSTRAINT rate_plans_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT rate_plans_hotel_key UNIQUE (tenant_id, hotel_id, id),
  CONSTRAINT rate_plans_code_key UNIQUE (tenant_id, hotel_id, rate_plan_code),
  CONSTRAINT rate_plans_meal_check CHECK (meal_plan IN ('room_only', 'breakfast', 'half_board', 'full_board', 'all_inclusive'))
);

CREATE TABLE hotel.rate_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rate_plan_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  amount numeric(18,4) NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_prices_plan_fk FOREIGN KEY (tenant_id, rate_plan_id)
    REFERENCES hotel.rate_plans (tenant_id, id),
  CONSTRAINT rate_prices_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT rate_prices_unique UNIQUE (tenant_id, rate_plan_id, valid_from),
  CONSTRAINT rate_prices_range_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT rate_prices_amount_check CHECK (amount >= 0)
);

CREATE TABLE hotel.business_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_dates_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT business_dates_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT business_dates_unique UNIQUE (tenant_id, hotel_id, business_date),
  CONSTRAINT business_dates_status_check CHECK (status IN ('open', 'closed'))
);

CREATE TABLE hotel.night_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  business_date date NOT NULL,
  run_number integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'in_progress',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  run_by uuid,
  exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  override_reason text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT night_audit_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT night_audit_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT night_audit_unique UNIQUE (tenant_id, hotel_id, business_date, run_number),
  CONSTRAINT night_audit_status_check CHECK (status IN ('in_progress', 'completed', 'completed_with_override', 'failed')),
  CONSTRAINT night_audit_override_check CHECK (
    status <> 'completed_with_override' OR override_reason IS NOT NULL
  )
);

CREATE OR REPLACE VIEW hotel.current_business_date AS
SELECT DISTINCT ON (tenant_id, hotel_id)
  tenant_id,
  hotel_id,
  business_date,
  status
FROM hotel.business_dates
ORDER BY tenant_id, hotel_id, business_date DESC;
