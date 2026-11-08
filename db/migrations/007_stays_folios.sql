-- 007: stays, guest folios and the append-only folio ledger.

CREATE TABLE hotel.stays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  room_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  check_in_at timestamptz NOT NULL DEFAULT now(),
  expected_check_out date NOT NULL,
  check_out_at timestamptz,
  adults smallint NOT NULL DEFAULT 1,
  children smallint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'in_house',
  checked_in_by uuid,
  checked_out_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stays_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT stays_reservation_fk FOREIGN KEY (tenant_id, hotel_id, reservation_id)
    REFERENCES hotel.reservations (tenant_id, hotel_id, id),
  CONSTRAINT stays_room_fk FOREIGN KEY (tenant_id, hotel_id, room_id)
    REFERENCES hotel.rooms (tenant_id, hotel_id, id),
  CONSTRAINT stays_guest_fk FOREIGN KEY (tenant_id, guest_id)
    REFERENCES hotel.guests (tenant_id, id),
  CONSTRAINT stays_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT stays_hotel_key UNIQUE (tenant_id, hotel_id, id),
  CONSTRAINT stays_status_check CHECK (status IN ('in_house', 'checked_out', 'cancelled'))
);
-- One in-house stay per room at any time.
CREATE UNIQUE INDEX uq_stays_active_room ON hotel.stays (tenant_id, room_id) WHERE status = 'in_house';

CREATE TABLE hotel.folios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  folio_number varchar(40) NOT NULL,
  stay_id uuid,
  guest_id uuid NOT NULL,
  reservation_id uuid,
  status text NOT NULL DEFAULT 'open',
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  balance numeric(18,4) NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid,
  CONSTRAINT folios_hotel_fk FOREIGN KEY (tenant_id, hotel_id)
    REFERENCES hotel.hotels (tenant_id, id),
  CONSTRAINT folios_stay_fk FOREIGN KEY (tenant_id, hotel_id, stay_id)
    REFERENCES hotel.stays (tenant_id, hotel_id, id),
  CONSTRAINT folios_guest_fk FOREIGN KEY (tenant_id, guest_id)
    REFERENCES hotel.guests (tenant_id, id),
  CONSTRAINT folios_reservation_fk FOREIGN KEY (tenant_id, hotel_id, reservation_id)
    REFERENCES hotel.reservations (tenant_id, hotel_id, id),
  CONSTRAINT folios_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT folios_number_key UNIQUE (tenant_id, folio_number),
  CONSTRAINT folios_status_check CHECK (status IN ('open', 'closed', 'void'))
);
CREATE INDEX idx_folios_open ON hotel.folios (tenant_id, hotel_id, status) WHERE status = 'open';

-- Append-only guest ledger. Posted entries are never updated or deleted:
-- corrections are new reversal/adjustment rows that reference the original.
CREATE TABLE hotel.folio_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hotel_id uuid NOT NULL,
  folio_id uuid NOT NULL,
  entry_type text NOT NULL,
  description text NOT NULL,
  amount numeric(18,4) NOT NULL,
  tax_amount numeric(18,4) NOT NULL DEFAULT 0,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  source_type text,
  source_id text,
  reverses_entry_id uuid,
  journal_entry_id uuid,
  business_date date NOT NULL,
  posted_by uuid,
  posted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folio_entries_folio_fk FOREIGN KEY (tenant_id, folio_id)
    REFERENCES hotel.folios (tenant_id, id),
  CONSTRAINT folio_entries_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT folio_entries_reversal_fk FOREIGN KEY (tenant_id, reverses_entry_id)
    REFERENCES hotel.folio_entries (tenant_id, id),
  CONSTRAINT folio_entries_type_check CHECK (
    entry_type IN ('room_charge', 'restaurant_charge', 'bar_charge', 'tax', 'service_charge',
                   'payment', 'adjustment', 'reversal', 'discount')
  ),
  CONSTRAINT folio_entries_amount_check CHECK (amount <> 0)
);
CREATE INDEX idx_folio_entries_folio ON hotel.folio_entries (tenant_id, folio_id, posted_at);
-- A given external document may only be charged to a folio once.
CREATE UNIQUE INDEX uq_folio_entries_source ON hotel.folio_entries (tenant_id, source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL AND entry_type <> 'reversal';
CREATE TRIGGER folio_entries_append_only BEFORE UPDATE OR DELETE ON hotel.folio_entries
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

-- Maintain the folio balance inside the same transaction as the posting.
CREATE OR REPLACE FUNCTION hotel_apply_folio_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM hotel.folios WHERE id = NEW.folio_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Folio % not found', NEW.folio_id;
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'Folio % is % and cannot accept postings', NEW.folio_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE hotel.folios SET balance = balance + NEW.amount WHERE id = NEW.folio_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER folio_entries_apply AFTER INSERT ON hotel.folio_entries
  FOR EACH ROW EXECUTE FUNCTION hotel_apply_folio_entry();

-- Guard the folio lifecycle: closed or void folios cannot be reopened casually.
CREATE OR REPLACE FUNCTION hotel_guard_folio_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'Folio % cannot be reopened from %', OLD.folio_number, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER folios_status_guard BEFORE UPDATE ON hotel.folios
  FOR EACH ROW EXECUTE FUNCTION hotel_guard_folio_status();
