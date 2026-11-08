-- 006: guests, reservations and concurrency-safe room allocation.

CREATE TABLE hotel.guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  guest_number varchar(40) NOT NULL,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  email varchar(254),
  phone varchar(40),
  nationality char(2),
  id_type text,
  id_number varchar(80),
  date_of_birth date,
  address_line text,
  city varchar(120),
  country_code char(2),
  is_vip boolean NOT NULL DEFAULT false,
  marketing_consent boolean NOT NULL DEFAULT false,
  notes text,
  loyalty_points integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guests_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT guests_number_key UNIQUE (tenant_id, guest_number)
);
CREATE INDEX idx_guests_email ON hotel.guests (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_guests_phone ON hotel.guests (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE TRIGGER guests_touch BEFORE UPDATE ON hotel.guests
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE hotel.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  reservation_number varchar(40) NOT NULL,
  primary_guest_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  rate_plan_id uuid,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  adults smallint NOT NULL DEFAULT 1,
  children smallint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'confirmed',
  source text NOT NULL DEFAULT 'direct',
  room_rate numeric(18,4) NOT NULL DEFAULT 0,
  total_amount numeric(18,4) NOT NULL DEFAULT 0,
  deposit_amount numeric(18,4) NOT NULL DEFAULT 0,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  special_requests text,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservations_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT reservations_guest_fk FOREIGN KEY (tenant_id, primary_guest_id)
    REFERENCES hotel.guests (tenant_id, id),
  CONSTRAINT reservations_room_type_fk FOREIGN KEY (tenant_id, hotel_id, room_type_id)
    REFERENCES hotel.room_types (tenant_id, hotel_id, id),
  CONSTRAINT reservations_rate_plan_fk FOREIGN KEY (tenant_id, hotel_id, rate_plan_id)
    REFERENCES hotel.rate_plans (tenant_id, hotel_id, id),
  CONSTRAINT reservations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT reservations_hotel_key UNIQUE (tenant_id, hotel_id, id),
  CONSTRAINT reservations_number_key UNIQUE (tenant_id, reservation_number),
  CONSTRAINT reservations_dates_check CHECK (departure_date > arrival_date),
  CONSTRAINT reservations_occupancy_check CHECK (adults > 0 AND children >= 0),
  CONSTRAINT reservations_amount_check CHECK (
    room_rate >= 0 AND total_amount >= 0 AND deposit_amount >= 0 AND deposit_amount <= total_amount
  ),
  CONSTRAINT reservations_status_check CHECK (
    status IN ('enquiry', 'held', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show')
  ),
  CONSTRAINT reservations_source_check CHECK (
    source IN ('direct', 'website', 'phone', 'walk_in', 'channel', 'corporate', 'travel_agent')
  )
);
CREATE INDEX idx_reservations_arrival ON hotel.reservations (tenant_id, hotel_id, arrival_date);
CREATE TRIGGER reservations_touch BEFORE UPDATE ON hotel.reservations
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE hotel.reservation_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_guests_res_fk FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES hotel.reservations (tenant_id, id),
  CONSTRAINT reservation_guests_guest_fk FOREIGN KEY (tenant_id, guest_id)
    REFERENCES hotel.guests (tenant_id, id),
  CONSTRAINT reservation_guests_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT reservation_guests_unique UNIQUE (tenant_id, reservation_id, guest_id)
);

-- Room allocation with database-enforced double-booking prevention.
-- An active allocation reserves a half-open time range for one room; the GiST
-- exclusion constraint rejects any overlapping active allocation for that room
-- even when two transactions race.
CREATE TABLE hotel.room_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  room_id uuid NOT NULL,
  stay_period tstzrange NOT NULL,
  status text NOT NULL DEFAULT 'active',
  allocated_by uuid,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text,
  CONSTRAINT room_allocations_res_fk FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES hotel.reservations (tenant_id, id),
  CONSTRAINT room_allocations_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT room_allocations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT room_allocations_period_check CHECK (NOT isempty(stay_period)),
  CONSTRAINT room_allocations_status_check CHECK (status IN ('active', 'released')),
  CONSTRAINT room_allocations_no_overlap EXCLUDE USING gist (
    room_id WITH =,
    stay_period WITH &&
  ) WHERE (status = 'active')
);
CREATE INDEX idx_room_allocations_res ON hotel.room_allocations (tenant_id, reservation_id);

CREATE OR REPLACE VIEW hotel.reservation_rooms AS
SELECT
  ra.tenant_id,
  ra.reservation_id,
  ra.room_id,
  lower(ra.stay_period) AS from_at,
  upper(ra.stay_period) AS to_at,
  ra.status
FROM hotel.room_allocations ra;
