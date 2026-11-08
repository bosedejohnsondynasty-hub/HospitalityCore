import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';
import { GL, money } from './finance.js';
import { postJournal, reverseJournal } from './finance.js';

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Rooms and guests
// ---------------------------------------------------------------------------
export async function listRooms(db: Queryable, hotelId: string) {
  const { rows } = await db.query(
    `SELECT r.id, r.room_number, r.floor_label, r.occupancy_status, r.housekeeping_status,
            r.is_out_of_order, rt.room_type_code, rt.room_type_name, rt.base_rate
       FROM hotel.rooms r
       JOIN hotel.room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = $1
      ORDER BY r.room_number`,
    [hotelId],
  );
  return rows;
}

export async function createGuest(
  db: Queryable,
  ctx: AuthContext,
  input: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    nationality?: string;
    idType?: string;
    idNumber?: string;
    dateOfBirth?: string;
    isVip?: boolean;
    marketingConsent?: boolean;
    notes?: string;
  },
) {
  if (!input.firstName?.trim() || !input.lastName?.trim()) {
    throw badRequest('First name and last name are required');
  }
  const number = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'guest', 'G-') AS number",
    [ctx.tenantId],
  );
  const { rows } = await db.query<{ id: string; guest_number: string }>(
    `INSERT INTO hotel.guests
       (tenant_id, guest_number, first_name, last_name, email, phone, nationality, id_type, id_number,
        date_of_birth, is_vip, marketing_consent, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, guest_number`,
    [
      ctx.tenantId,
      number.rows[0]!.number,
      input.firstName.trim(),
      input.lastName.trim(),
      input.email?.toLowerCase() ?? null,
      input.phone ?? null,
      input.nationality?.toUpperCase() ?? null,
      input.idType ?? null,
      input.idNumber ?? null,
      input.dateOfBirth ?? null,
      input.isVip ?? false,
      input.marketingConsent ?? false,
      input.notes ?? null,
    ],
  );
  await auditAction(db, ctx, 'guest.created', 'guest', rows[0]!.id, { after: { ...input } });
  return rows[0]!;
}

export async function listGuests(db: Queryable, search?: string) {
  const { rows } = await db.query(
    `SELECT id, guest_number, first_name, last_name, email, phone, is_vip, loyalty_points
       FROM hotel.guests
      WHERE ($1::text IS NULL OR first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)
      ORDER BY created_at DESC
      LIMIT 100`,
    [search ? `%${search}%` : null],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Reservations and allocation
// ---------------------------------------------------------------------------
export async function checkAvailability(
  db: Queryable,
  hotelId: string,
  from: string,
  to: string,
): Promise<Array<{ room_id: string; room_number: string; room_type_code: string; base_rate: number; available: boolean }>> {
  if (new Date(to) <= new Date(from)) throw badRequest('Departure must be after arrival');
  const { rows } = await db.query<{
    room_id: string;
    room_number: string;
    room_type_code: string;
    base_rate: string;
    available: boolean;
  }>(
    `SELECT r.id AS room_id, r.room_number, rt.room_type_code, rt.base_rate,
            NOT EXISTS (
              SELECT 1 FROM hotel.room_allocations ra
               WHERE ra.room_id = r.id
                 AND ra.status = 'active'
                 AND ra.stay_period && tstzrange($2::timestamptz, $3::timestamptz, '[)')
            ) AND NOT r.is_out_of_order AS available
       FROM hotel.rooms r
       JOIN hotel.room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = $1
      ORDER BY r.room_number`,
    [hotelId, `${from}T14:00:00Z`, `${to}T12:00:00Z`],
  );
  return rows.map((r) => ({ ...r, base_rate: Number(r.base_rate) }));
}

/** Normalises a date column (pg returns `date` as a JS Date) to YYYY-MM-DD. */
const isoDay = (value: string | Date): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export async function createReservation(
  db: Queryable,
  ctx: AuthContext,
  input: {
    hotelId: string;
    guestId: string;
    roomTypeId: string;
    arrivalDate: string;
    departureDate: string;
    adults?: number;
    children?: number;
    source?: string;
    roomRate?: number;
    specialRequests?: string;
  },
) {
  const arrival = new Date(input.arrivalDate);
  const departure = new Date(input.departureDate);
  if (!(departure > arrival)) throw badRequest('Departure date must be after arrival date');

  const roomType = await db.query<{ base_rate: string; capacity_adults: number }>(
    'SELECT base_rate, capacity_adults FROM hotel.room_types WHERE id = $1 AND hotel_id = $2',
    [input.roomTypeId, input.hotelId],
  );
  const rt = roomType.rows[0];
  if (!rt) throw notFound('Room type not found for this hotel');
  if ((input.adults ?? 1) > rt.capacity_adults) {
    throw badRequest(`Room type allows at most ${rt.capacity_adults} adults`);
  }

  const nights = Math.round((departure.getTime() - arrival.getTime()) / 86_400_000);
  const rate = money(input.roomRate ?? Number(rt.base_rate));
  const total = money(rate * nights);

  const number = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'reservation', 'RSV-') AS number",
    [ctx.tenantId],
  );
  const { rows } = await db.query<{ id: string; reservation_number: string }>(
    `INSERT INTO hotel.reservations
       (tenant_id, hotel_id, reservation_number, primary_guest_id, room_type_id, arrival_date,
        departure_date, adults, children, status, source, room_rate, total_amount, special_requests, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,$14)
     RETURNING id, reservation_number`,
    [
      ctx.tenantId,
      input.hotelId,
      number.rows[0]!.number,
      input.guestId,
      input.roomTypeId,
      input.arrivalDate,
      input.departureDate,
      input.adults ?? 1,
      input.children ?? 0,
      input.source ?? 'direct',
      rate,
      total,
      input.specialRequests ?? null,
      ctx.userId,
    ],
  );
  const reservationId = rows[0]!.id;
  await db.query(
    `INSERT INTO hotel.reservation_guests (tenant_id, reservation_id, guest_id, is_primary)
     VALUES ($1,$2,$3,true)`,
    [ctx.tenantId, reservationId, input.guestId],
  );
  await emitEvent(db, ctx.tenantId, 'reservation.created', 'reservation', reservationId, {
    hotelId: input.hotelId,
    arrival: input.arrivalDate,
    departure: input.departureDate,
  });
  await auditAction(db, ctx, 'reservation.created', 'reservation', reservationId, {
    after: { ...input, total },
    branchId: null,
  });
  return { id: reservationId, reservationNumber: rows[0]!.reservation_number, nights, total };
}

const AMENDABLE_RESERVATION = ['held', 'confirmed'];

/**
 * Amends dates, occupancy, room type or rate on a reservation that has not started.
 *
 * A live room allocation pins the stay to a physical room; changing the dates or the
 * room type underneath it would silently invalidate that allocation, so the caller is
 * told to release it first instead of the server guessing a new room.
 */
export async function amendReservation(
  db: Queryable,
  ctx: AuthContext,
  reservationId: string,
  input: {
    arrivalDate?: string;
    departureDate?: string;
    adults?: number;
    children?: number;
    roomTypeId?: string;
    roomRate?: number;
    specialRequests?: string;
  },
) {
  const { rows } = await db.query<{
    id: string;
    hotel_id: string;
    room_type_id: string;
    arrival_date: string;
    departure_date: string;
    adults: number;
    children: number;
    room_rate: string;
    total_amount: string;
    status: string;
    special_requests: string | null;
  }>('SELECT * FROM hotel.reservations WHERE id = $1 FOR UPDATE', [reservationId]);
  const res = rows[0];
  if (!res) throw notFound('Reservation not found');
  if (!AMENDABLE_RESERVATION.includes(res.status)) {
    throw conflict(
      'RESERVATION_NOT_AMENDABLE',
      `A ${res.status} reservation cannot be amended`,
    );
  }

  const arrivalDate = input.arrivalDate ?? isoDay(res.arrival_date);
  const departureDate = input.departureDate ?? isoDay(res.departure_date);
  const arrival = new Date(`${arrivalDate}T00:00:00Z`);
  const departure = new Date(`${departureDate}T00:00:00Z`);
  if (!(departure > arrival)) throw badRequest('Departure date must be after arrival date');

  const roomTypeId = input.roomTypeId ?? res.room_type_id;
  const roomType = await db.query<{ base_rate: string; capacity_adults: number }>(
    'SELECT base_rate, capacity_adults FROM hotel.room_types WHERE id = $1 AND hotel_id = $2',
    [roomTypeId, res.hotel_id],
  );
  const rt = roomType.rows[0];
  if (!rt) throw notFound('Room type not found for this hotel');
  const adults = input.adults ?? res.adults;
  if (adults > rt.capacity_adults) {
    throw badRequest(`Room type allows at most ${rt.capacity_adults} adults`);
  }

  const allocation = await db.query<{ room_id: string }>(
    "SELECT room_id FROM hotel.room_allocations WHERE reservation_id = $1 AND status = 'active'",
    [reservationId],
  );
  const datesChanged =
    arrivalDate !== isoDay(res.arrival_date) || departureDate !== isoDay(res.departure_date);
  const typeChanged = roomTypeId !== res.room_type_id;
  if (allocation.rowCount && (datesChanged || typeChanged)) {
    throw conflict(
      'RESERVATION_HAS_ALLOCATION',
      'Release the current room allocation before changing the dates or room type',
    );
  }

  const nights = Math.round((departure.getTime() - arrival.getTime()) / 86_400_000);
  const rate = money(input.roomRate ?? (typeChanged ? Number(rt.base_rate) : Number(res.room_rate)));
  const total = money(rate * nights);

  await db.query(
    `UPDATE hotel.reservations
        SET arrival_date = $2, departure_date = $3, adults = $4, children = $5,
            room_type_id = $6, room_rate = $7, total_amount = $8, special_requests = $9
      WHERE id = $1`,
    [
      reservationId,
      arrivalDate,
      departureDate,
      adults,
      input.children ?? res.children,
      roomTypeId,
      rate,
      total,
      input.specialRequests ?? res.special_requests,
    ],
  );
  await emitEvent(db, ctx.tenantId, 'reservation.amended', 'reservation', reservationId, {
    before: {
      arrivalDate: isoDay(res.arrival_date),
      departureDate: isoDay(res.departure_date),
      roomTypeId: res.room_type_id,
      total: res.total_amount,
    },
    after: { arrivalDate, departureDate, roomTypeId, total },
  });
  await auditAction(db, ctx, 'reservation.amended', 'reservation', reservationId, {
    before: { arrivalDate: isoDay(res.arrival_date), departureDate: isoDay(res.departure_date) },
    after: { arrivalDate, departureDate, total },
  });
  return { id: reservationId, nights, rate, total, arrivalDate, departureDate };
}

async function releaseAllocations(
  db: Queryable,
  reservationId: string,
  reason: string,
) {
  await db.query(
    `UPDATE hotel.room_allocations
        SET status = 'released', released_at = now(), release_reason = $2
      WHERE reservation_id = $1 AND status = 'active'`,
    [reservationId, reason],
  );
}

/** Cancels a reservation before arrival and frees its room allocation. */
export async function cancelReservation(
  db: Queryable,
  ctx: AuthContext,
  reservationId: string,
  reason: string,
) {
  const trimmed = reason?.trim();
  if (!trimmed) throw badRequest('A cancellation reason is required');

  const { rows } = await db.query<{ id: string; status: string; arrival_date: string }>(
    'SELECT id, status, arrival_date FROM hotel.reservations WHERE id = $1 FOR UPDATE',
    [reservationId],
  );
  const res = rows[0];
  if (!res) throw notFound('Reservation not found');
  if (res.status === 'cancelled') {
    throw conflict('ALREADY_CANCELLED', 'Reservation is already cancelled');
  }
  if (['checked_in', 'checked_out'].includes(res.status)) {
    throw conflict(
      'RESERVATION_NOT_CANCELLABLE',
      `A ${res.status} stay cannot be cancelled; use checkout or a folio adjustment`,
    );
  }

  await releaseAllocations(db, reservationId, `Reservation cancelled: ${trimmed}`);
  await db.query(
    `UPDATE hotel.reservations
        SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $2
      WHERE id = $1`,
    [reservationId, trimmed],
  );
  await emitEvent(db, ctx.tenantId, 'reservation.cancelled', 'reservation', reservationId, {
    reason: trimmed,
    arrivalDate: isoDay(res.arrival_date),
  });
  await auditAction(db, ctx, 'reservation.cancelled', 'reservation', reservationId, {
    before: { status: res.status },
    after: { status: 'cancelled', reason: trimmed },
  });
  return { id: reservationId, status: 'cancelled', reason: trimmed };
}

/**
 * Records a no-show. Only valid once the hotel's business date has reached the
 * arrival date, so a guest cannot be marked absent before the day begins.
 */
export async function markNoShow(
  db: Queryable,
  ctx: AuthContext,
  reservationId: string,
) {
  const { rows } = await db.query<{
    id: string;
    hotel_id: string;
    status: string;
    arrival_date: string;
  }>('SELECT id, hotel_id, status, arrival_date FROM hotel.reservations WHERE id = $1 FOR UPDATE', [
    reservationId,
  ]);
  const res = rows[0];
  if (!res) throw notFound('Reservation not found');
  if (res.status === 'no_show') throw conflict('ALREADY_NO_SHOW', 'Reservation is already a no-show');
  if (!AMENDABLE_RESERVATION.includes(res.status)) {
    throw conflict('RESERVATION_NOT_DUE', `A ${res.status} reservation cannot be marked no-show`);
  }

  const current = await businessDate(db, res.hotel_id);
  const today = current?.business_date ?? new Date().toISOString().slice(0, 10);
  if (today < isoDay(res.arrival_date)) {
    throw conflict(
      'RESERVATION_NOT_DUE',
      `The business date (${today}) has not reached the arrival date`,
    );
  }

  await releaseAllocations(db, reservationId, 'No-show');
  await db.query("UPDATE hotel.reservations SET status = 'no_show' WHERE id = $1", [reservationId]);
  await emitEvent(db, ctx.tenantId, 'reservation.no_show', 'reservation', reservationId, {
    arrivalDate: isoDay(res.arrival_date),
  });
  await auditAction(db, ctx, 'reservation.no_show', 'reservation', reservationId, {
    before: { status: res.status },
    after: { status: 'no_show' },
  });
  return { id: reservationId, status: 'no_show' };
}

/** Allocates a room; overlapping active allocations are rejected by the database. */
export async function allocateRoom(
  db: Queryable,
  ctx: AuthContext,
  reservationId: string,
  roomId: string,
) {
  const reservation = await db.query<{
    id: string;
    hotel_id: string;
    arrival_date: string;
    departure_date: string;
    status: string;
    room_type_id: string;
  }>(
    'SELECT id, hotel_id, arrival_date, departure_date, status, room_type_id FROM hotel.reservations WHERE id = $1',
    [reservationId],
  );
  const res = reservation.rows[0];
  if (!res) throw notFound('Reservation not found');
  if (['cancelled', 'checked_out', 'no_show'].includes(res.status)) {
    throw conflict('RESERVATION_NOT_ALLOCATABLE', `Reservation is ${res.status}`);
  }

  const room = await db.query<{ id: string; room_type_id: string; is_out_of_order: boolean }>(
    'SELECT id, room_type_id, is_out_of_order FROM hotel.rooms WHERE id = $1 AND hotel_id = $2',
    [roomId, res.hotel_id],
  );
  const roomRow = room.rows[0];
  if (!roomRow) throw notFound('Room not found');
  if (roomRow.is_out_of_order) throw conflict('ROOM_OUT_OF_ORDER', 'Room is out of order');

  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO hotel.room_allocations
         (tenant_id, hotel_id, reservation_id, room_id, stay_period, status, allocated_by)
       VALUES ($1,$2,$3,$4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), 'active', $7)
       RETURNING id`,
      [
        ctx.tenantId,
        res.hotel_id,
        reservationId,
        roomId,
        `${isoDay(res.arrival_date)}T14:00:00Z`,
        `${isoDay(res.departure_date)}T12:00:00Z`,
        ctx.userId,
      ],
    );
    await db.query(
      `UPDATE hotel.reservations SET status = CASE WHEN status = 'held' THEN 'confirmed' ELSE status END
        WHERE id = $1`,
      [reservationId],
    );
    await auditAction(db, ctx, 'reservation.room_allocated', 'room_allocation', rows[0]!.id, {
      after: { reservationId, roomId },
    });
    return { id: rows[0]!.id, reservationId, roomId };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23P01') {
      throw conflict(
        'ROOM_UNAVAILABLE',
        'That room is already allocated for the requested dates (double booking prevented)',
      );
    }
    throw err;
  }
}

export async function allocateBestAvailable(
  db: Queryable,
  ctx: AuthContext,
  reservationId: string,
) {
  const res = await db.query<{ hotel_id: string; room_type_id: string; arrival_date: string; departure_date: string }>(
    'SELECT hotel_id, room_type_id, arrival_date, departure_date FROM hotel.reservations WHERE id = $1',
    [reservationId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('Reservation not found');
  const candidates = await db.query<{ id: string }>(
    `SELECT r.id FROM hotel.rooms r
      WHERE r.hotel_id = $1 AND r.room_type_id = $2 AND NOT r.is_out_of_order
        AND NOT EXISTS (
          SELECT 1 FROM hotel.room_allocations ra
           WHERE ra.room_id = r.id AND ra.status = 'active'
             AND ra.stay_period && tstzrange($3::timestamptz, $4::timestamptz, '[)')
        )
      ORDER BY r.room_number
      LIMIT 1`,
    [
      row.hotel_id,
      row.room_type_id,
      `${isoDay(row.arrival_date)}T14:00:00Z`,
      `${isoDay(row.departure_date)}T12:00:00Z`,
    ],
  );
  if (!candidates.rows[0]) throw conflict('NO_AVAILABILITY', 'No room of the requested type is available');
  return allocateRoom(db, ctx, reservationId, candidates.rows[0].id);
}

// ---------------------------------------------------------------------------
// Check-in / check-out
// ---------------------------------------------------------------------------
export async function checkIn(
  db: Queryable,
  ctx: AuthContext,
  input: { reservationId: string; roomId?: string },
) {
  const reservation = await db.query<{
    id: string;
    hotel_id: string;
    guest_id: string;
    room_type_id: string;
    arrival_date: string;
    departure_date: string;
    status: string;
    adults: number;
    children: number;
  }>(
    `SELECT id, hotel_id, primary_guest_id AS guest_id, room_type_id, arrival_date, departure_date,
            status, adults, children
       FROM hotel.reservations WHERE id = $1`,
    [input.reservationId],
  );
  const res = reservation.rows[0];
  if (!res) throw notFound('Reservation not found');
  if (res.status === 'checked_in') throw conflict('ALREADY_CHECKED_IN', 'Guest is already checked in');
  if (['cancelled', 'no_show', 'checked_out'].includes(res.status)) {
    throw conflict('RESERVATION_NOT_CHECKINABLE', `Reservation is ${res.status}`);
  }

  const allocation = await db.query<{ room_id: string }>(
    `SELECT room_id FROM hotel.room_allocations
      WHERE reservation_id = $1 AND status = 'active' ORDER BY allocated_at LIMIT 1`,
    [input.reservationId],
  );
  const roomId = input.roomId ?? allocation.rows[0]?.room_id;
  if (!roomId) throw badRequest('Allocate a room before checking in');
  if (allocation.rows[0] && allocation.rows[0].room_id !== roomId) {
    throw conflict('ALLOCATION_MISMATCH', 'Reservation is allocated to a different room');
  }
  if (!allocation.rows[0]) await allocateRoom(db, ctx, input.reservationId, roomId);

  const stay = await db.query<{ id: string }>(
    `INSERT INTO hotel.stays
       (tenant_id, hotel_id, reservation_id, room_id, guest_id, expected_check_out, adults, children, checked_in_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      ctx.tenantId,
      res.hotel_id,
      res.id,
      roomId,
      res.guest_id,
      res.departure_date,
      res.adults,
      res.children,
      ctx.userId,
    ],
  );
  const stayId = stay.rows[0]!.id;

  const folioNumber = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'folio', 'FOL-') AS number",
    [ctx.tenantId],
  );
  const folio = await db.query<{ id: string }>(
    `INSERT INTO hotel.folios
       (tenant_id, hotel_id, folio_number, stay_id, guest_id, reservation_id, currency_code)
     VALUES ($1,$2,$3,$4,$5,$6,(SELECT default_currency FROM platform.tenants WHERE id = $1))
     RETURNING id`,
    [ctx.tenantId, res.hotel_id, folioNumber.rows[0]!.number, stayId, res.guest_id, res.id],
  );

  await db.query("UPDATE hotel.reservations SET status = 'checked_in' WHERE id = $1", [res.id]);
  await db.query("UPDATE hotel.rooms SET occupancy_status = 'occupied' WHERE id = $1", [roomId]);
  await emitEvent(db, ctx.tenantId, 'stay.checked_in', 'stay', stayId, { reservationId: res.id });
  await auditAction(db, ctx, 'frontdesk.checked_in', 'stay', stayId, {
    after: { reservationId: res.id, roomId },
  });

  return { stayId, folioId: folio.rows[0]!.id, folioNumber: folioNumber.rows[0]!.number, roomId };
}

export async function checkOut(
  db: Queryable,
  ctx: AuthContext,
  input: { stayId: string; allowOutstandingBalance?: boolean },
) {
  const stay = await db.query<{
    id: string;
    hotel_id: string;
    room_id: string;
    reservation_id: string;
    guest_id: string;
    status: string;
    expected_check_out: string;
  }>(
    `SELECT id, hotel_id, room_id, reservation_id, guest_id, status, expected_check_out
       FROM hotel.stays WHERE id = $1`,
    [input.stayId],
  );
  const row = stay.rows[0];
  if (!row) throw notFound('Stay not found');
  if (row.status !== 'in_house') throw conflict('STAY_NOT_IN_HOUSE', `Stay is ${row.status}`);

  const folio = await db.query<{ id: string; balance: string; status: string }>(
    `SELECT id, balance, status FROM hotel.folios WHERE stay_id = $1 AND status = 'open' FOR UPDATE`,
    [row.id],
  );
  const f = folio.rows[0];
  if (f && Number(f.balance) !== 0 && !input.allowOutstandingBalance) {
    throw conflict(
      'FOLIO_BALANCE_OUTSTANDING',
      `Folio ${f.id} has an outstanding balance of ${Number(f.balance).toFixed(2)}. Settle it or transfer to the city ledger.`,
      { folioId: f.id, balance: Number(f.balance) },
    );
  }

  await db.query(
    `UPDATE hotel.stays SET status = 'checked_out', check_out_at = now(), checked_out_by = $2 WHERE id = $1`,
    [row.id, ctx.userId],
  );
  if (f) {
    await db.query("UPDATE hotel.folios SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1", [
      f.id,
      ctx.userId,
    ]);
  }
  await db.query("UPDATE hotel.rooms SET occupancy_status = 'vacant', housekeeping_status = 'dirty' WHERE id = $1", [
    row.room_id,
  ]);
  await db.query("UPDATE hotel.reservations SET status = 'checked_out' WHERE id = $1", [row.reservation_id]);
  await auditAction(db, ctx, 'frontdesk.checked_out', 'stay', row.id, {
    after: { outstandingBalance: f ? Number(f.balance) : 0, folioClosed: Boolean(f) },
  });
  await emitEvent(db, ctx.tenantId, 'stay.checked_out', 'stay', row.id, { roomId: row.room_id });
  return { stayId: row.id, folioId: f?.id ?? null, outstandingBalance: f ? Number(f.balance) : 0 };
}

// ---------------------------------------------------------------------------
// Folio ledger
// ---------------------------------------------------------------------------
export async function getFolio(db: Queryable, folioId: string) {
  const folio = await db.query(
    `SELECT f.id, f.folio_number, f.status, f.currency_code, f.balance, f.opened_at, f.closed_at,
            g.first_name, g.last_name, g.guest_number
       FROM hotel.folios f JOIN hotel.guests g ON g.id = f.guest_id
      WHERE f.id = $1`,
    [folioId],
  );
  if (!folio.rows[0]) throw notFound('Folio not found');
  const entries = await db.query(
    `SELECT id, entry_type, description, amount, tax_amount, source_type, source_id,
            reverses_entry_id, journal_entry_id, business_date, posted_at
       FROM hotel.folio_entries WHERE folio_id = $1 ORDER BY posted_at, id`,
    [folioId],
  );
  return { ...folio.rows[0], entries: entries.rows };
}

const REVENUE_ACCOUNT: Record<string, string> = {
  room_charge: GL.roomRevenue,
  restaurant_charge: GL.restaurantRevenue,
  bar_charge: GL.barRevenue,
  tax: GL.vatPayable,
  service_charge: GL.otherRevenue,
  adjustment: GL.otherRevenue,
  discount: GL.discounts,
};

/**
 * Posts a charge to an open folio.
 *
 * Every posted entry has a defined accounting effect: guest receivable is debited
 * and the matching revenue/liability credited. Posted entries are append-only at
 * the database level.
 */
export async function postFolioCharge(
  db: Queryable,
  ctx: AuthContext,
  input: {
    folioId: string;
    entryType: string;
    description: string;
    amount: number;
    taxAmount?: number;
    sourceType?: string;
    sourceId?: string;
    postJournal?: boolean;
    businessDate?: string;
  },
  options: { actorOverride?: string } = {},
) {
  if (!(input.amount > 0)) throw badRequest('Charge amount must be greater than zero');
  const folio = await db.query<{ id: string; hotel_id: string; status: string; currency_code: string }>(
    'SELECT id, hotel_id, status, currency_code FROM hotel.folios WHERE id = $1',
    [input.folioId],
  );
  const f = folio.rows[0];
  if (!f) throw notFound('Folio not found');
  if (f.status !== 'open') throw conflict('FOLIO_CLOSED', 'Folio is not open');

  let journalEntryId: string | null = null;
  if (input.postJournal !== false) {
    const revenueAccount = REVENUE_ACCOUNT[input.entryType] ?? GL.otherRevenue;
    journalEntryId = await postJournal(db, {
      tenantId: ctx.tenantId,
      entryDate: input.businessDate ?? today(),
      description: `Folio ${input.folioId}: ${input.description}`,
      sourceType: input.sourceType ?? 'folio_entry',
      sourceId: input.sourceId ?? `${input.folioId}:${Date.now()}`,
      purpose: 'charge',
      lines: [
        { accountCode: GL.guestReceivable, debit: money(input.amount), description: input.description },
        { accountCode: revenueAccount, credit: money(input.amount), description: input.description },
      ],
      postedBy: ctx.userId,
    });
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO hotel.folio_entries
       (tenant_id, hotel_id, folio_id, entry_type, description, amount, tax_amount, currency_code,
        source_type, source_id, journal_entry_id, business_date, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      ctx.tenantId,
      f.hotel_id,
      input.folioId,
      input.entryType,
      input.description,
      money(input.amount),
      money(input.taxAmount ?? 0),
      f.currency_code,
      input.sourceType ?? null,
      input.sourceId ?? null,
      journalEntryId,
      input.businessDate ?? today(),
      options.actorOverride ?? ctx.userId,
    ],
  );
  await auditAction(db, ctx, 'folio.charge_posted', 'folio_entry', rows[0]!.id, {
    after: { folioId: input.folioId, amount: input.amount, entryType: input.entryType },
  });
  return { entryId: rows[0]!.id, journalEntryId };
}

export async function settleFolio(
  db: Queryable,
  ctx: AuthContext,
  input: { folioId: string; amount: number; method: 'cash' | 'bank_transfer' | 'pos_terminal'; reference?: string },
) {
  if (!(input.amount > 0)) throw badRequest('Settlement amount must be greater than zero');
  const folio = await db.query<{ id: string; hotel_id: string; status: string; balance: string; currency_code: string }>(
    'SELECT id, hotel_id, status, balance, currency_code FROM hotel.folios WHERE id = $1 FOR UPDATE',
    [input.folioId],
  );
  const f = folio.rows[0];
  if (!f) throw notFound('Folio not found');
  if (f.status !== 'open') throw conflict('FOLIO_CLOSED', 'Folio is not open');

  const reference = input.reference ?? `FOLPAY-${Date.now()}`;
  const journalEntryId = await postJournal(db, {
    tenantId: ctx.tenantId,
    entryDate: today(),
    description: `Folio settlement ${reference}`,
    sourceType: 'folio_settlement',
    sourceId: reference,
    purpose: 'settlement',
    lines: [
      { accountCode: GL.cash, debit: money(input.amount) },
      { accountCode: GL.guestReceivable, credit: money(input.amount) },
    ],
    postedBy: ctx.userId,
  });

  const entry = await db.query<{ id: string }>(
    `INSERT INTO hotel.folio_entries
       (tenant_id, hotel_id, folio_id, entry_type, description, amount, currency_code,
        source_type, source_id, journal_entry_id, business_date, posted_by)
     VALUES ($1,$2,$3,'payment',$4,$5,$6,'folio_settlement',$7,$8,current_date,$9)
     RETURNING id`,
    [
      ctx.tenantId,
      f.hotel_id,
      input.folioId,
      `Payment received (${input.method})`,
      -money(input.amount),
      f.currency_code,
      reference,
      journalEntryId,
      ctx.userId,
    ],
  );

  const balance = await db.query<{ balance: string }>(
    'SELECT balance FROM hotel.folios WHERE id = $1',
    [input.folioId],
  );
  await auditAction(db, ctx, 'folio.settled', 'folio', input.folioId, {
    after: { amount: input.amount, method: input.method, reference },
  });
  return { entryId: entry.rows[0]!.id, journalEntryId, balance: Number(balance.rows[0]!.balance) };
}

export async function reverseFolioEntry(
  db: Queryable,
  ctx: AuthContext,
  input: { entryId: string; reason: string },
) {
  if (!input.reason?.trim()) throw badRequest('A reason is required to reverse a folio entry');
  const entry = await db.query<{
    id: string;
    folio_id: string;
    hotel_id: string;
    amount: string;
    description: string;
    journal_entry_id: string | null;
    entry_type: string;
    currency_code: string;
  }>(
    `SELECT id, folio_id, hotel_id, amount, description, journal_entry_id, entry_type, currency_code
       FROM hotel.folio_entries WHERE id = $1`,
    [input.entryId],
  );
  const original = entry.rows[0];
  if (!original) throw notFound('Folio entry not found');
  if (original.entry_type === 'reversal') throw conflict('ALREADY_A_REVERSAL', 'Cannot reverse a reversal');

  const reversal = await db.query<{ id: string }>(
    `INSERT INTO hotel.folio_entries
       (tenant_id, hotel_id, folio_id, entry_type, description, amount, currency_code,
        source_type, source_id, reverses_entry_id, business_date, posted_by)
     VALUES ($1,$2,$3,'reversal',$4,$5,$6,'folio_reversal',$7,$8,current_date,$9)
     RETURNING id`,
    [
      ctx.tenantId,
      original.hotel_id,
      original.folio_id,
      `Reversal: ${original.description} (${input.reason})`,
      -Number(original.amount),
      original.currency_code,
      input.entryId,
      input.entryId,
      ctx.userId,
    ],
  );

  if (original.journal_entry_id) {
    await reverseJournal(db, ctx.tenantId, original.journal_entry_id, input.reason, ctx.userId);
  }
  await auditAction(db, ctx, 'folio.entry_reversed', 'folio_entry', input.entryId, {
    metadata: { reversalId: reversal.rows[0]!.id, reason: input.reason },
  });
  return { reversalId: reversal.rows[0]!.id };
}

// ---------------------------------------------------------------------------
// Night audit and business date control
// ---------------------------------------------------------------------------
export async function nightAudit(
  db: Queryable,
  ctx: AuthContext,
  input: { hotelId: string; businessDate?: string; overrideReason?: string },
) {
  const openDate =
    input.businessDate ??
    (
      await db.query<{ business_date: string }>(
        "SELECT business_date FROM hotel.business_dates WHERE hotel_id = $1 AND status = 'open' ORDER BY business_date DESC LIMIT 1",
        [input.hotelId],
      )
    ).rows[0]?.business_date;
  if (!openDate) throw conflict('NO_OPEN_BUSINESS_DATE', 'No open business date for this hotel');
  const businessDate = isoDay(openDate);

  const exceptions: Array<{ code: string; severity: 'critical' | 'warning'; message: string; entityId?: string }> = [];

  const noFolio = await db.query<{ id: string; room_number: string }>(
    `SELECT s.id, r.room_number FROM hotel.stays s
       JOIN hotel.rooms r ON r.id = s.room_id
      WHERE s.hotel_id = $1 AND s.status = 'in_house'
        AND NOT EXISTS (SELECT 1 FROM hotel.folios f WHERE f.stay_id = s.id AND f.status = 'open')`,
    [input.hotelId],
  );
  for (const row of noFolio.rows) {
    exceptions.push({
      code: 'IN_HOUSE_WITHOUT_OPEN_FOLIO',
      severity: 'critical',
      message: `Room ${row.room_number} is in house without an open folio`,
      entityId: row.id,
    });
  }

  const negative = await db.query<{ id: string; folio_number: string; balance: string }>(
    "SELECT id, folio_number, balance FROM hotel.folios WHERE hotel_id = $1 AND status = 'open' AND balance < 0",
    [input.hotelId],
  );
  for (const row of negative.rows) {
    exceptions.push({
      code: 'NEGATIVE_FOLIO_BALANCE',
      severity: 'warning',
      message: `Folio ${row.folio_number} has a credit balance of ${Number(row.balance).toFixed(2)}`,
      entityId: row.id,
    });
  }

  const unallocated = await db.query<{ id: string; reservation_number: string }>(
    `SELECT id, reservation_number FROM hotel.reservations
      WHERE hotel_id = $1 AND status IN ('confirmed','held') AND arrival_date <= $2
        AND NOT EXISTS (SELECT 1 FROM hotel.room_allocations ra WHERE ra.reservation_id = hotel.reservations.id AND ra.status = 'active')`,
    [input.hotelId, businessDate],
  );
  for (const row of unallocated.rows) {
    exceptions.push({
      code: 'ARRIVAL_WITHOUT_ROOM',
      severity: 'warning',
      message: `Reservation ${row.reservation_number} arrives today without a room allocation`,
      entityId: row.id,
    });
  }

  const staleOrders = await db.query<{ id: string; order_number: string }>(
    `SELECT o.id, o.order_number FROM restaurant.orders o
       JOIN platform.branches b ON b.id = o.branch_id
      WHERE o.status NOT IN ('completed','cancelled') AND o.placed_at < now() - interval '24 hours'`,
  );
  for (const row of staleOrders.rows) {
    exceptions.push({
      code: 'STALE_RESTAURANT_ORDER',
      severity: 'warning',
      message: `Restaurant order ${row.order_number} has been open for more than 24 hours`,
      entityId: row.id,
    });
  }

  const critical = exceptions.filter((e) => e.severity === 'critical');
  if (critical.length > 0 && !input.overrideReason) {
    throw new AppError(
      409,
      'NIGHT_AUDIT_EXCEPTIONS',
      `${critical.length} critical night audit exception(s) must be resolved or overridden`,
      { exceptions },
    );
  }

  // Post nightly room charges for in-house stays (idempotent per stay and date).
  const stays = await db.query<{
    stay_id: string;
    folio_id: string;
    room_rate: string;
    reservation_number: string;
    room_number: string;
  }>(
    `SELECT s.id AS stay_id, f.id AS folio_id, rv.room_rate, rv.reservation_number, r.room_number
       FROM hotel.stays s
       JOIN hotel.reservations rv ON rv.id = s.reservation_id
       JOIN hotel.rooms r ON r.id = s.room_id
       JOIN hotel.folios f ON f.stay_id = s.id AND f.status = 'open'
      WHERE s.hotel_id = $1 AND s.status = 'in_house'
        AND s.check_in_at < ($2::date + interval '1 day')`,
    [input.hotelId, businessDate],
  );

  let roomChargesPosted = 0;
  for (const stay of stays.rows) {
    // The posting key includes the business date, so each night is posted once
    // and a re-run of the audit cannot double charge the guest.
    const postingSourceId = `${stay.stay_id}:${businessDate}`;
    const existing = await db.query(
      `SELECT 1 FROM finance.posting_links
        WHERE tenant_id = $1 AND source_type = 'stay' AND source_id = $2 AND purpose = 'charge'`,
      [ctx.tenantId, postingSourceId],
    );
    if (existing.rowCount) continue;
    try {
      await postFolioCharge(db, ctx, {
        folioId: stay.folio_id,
        entryType: 'room_charge',
        description: `Room ${stay.room_number} - ${businessDate}`,
        amount: Number(stay.room_rate),
        sourceType: 'stay',
        sourceId: postingSourceId,
        businessDate,
      });
      roomChargesPosted += 1;
    } catch (err) {
      // A concurrent run may win the unique posting link; treat that as done.
      if ((err as { code?: string }).code !== 'DUPLICATE_POSTING') throw err;
    }
  }

  const runNumber = await db.query<{ n: string }>(
    'SELECT coalesce(max(run_number), 0) + 1 AS n FROM hotel.night_audit_runs WHERE hotel_id = $1 AND business_date = $2',
    [input.hotelId, businessDate],
  );
  const status = critical.length > 0 ? 'completed_with_override' : 'completed';
  await db.query(
    `INSERT INTO hotel.night_audit_runs
       (tenant_id, hotel_id, business_date, run_number, status, completed_at, run_by, exceptions, override_reason, summary)
     VALUES ($1,$2,$3,$4,$5, now(), $6, $7::jsonb, $8, $9::jsonb)`,
    [
      ctx.tenantId,
      input.hotelId,
      businessDate,
      Number(runNumber.rows[0]!.n),
      status,
      ctx.userId,
      JSON.stringify(exceptions),
      input.overrideReason ?? null,
      JSON.stringify({ roomChargesPosted, staysInHouse: stays.rowCount }),
    ],
  );

  await db.query("UPDATE hotel.business_dates SET status = 'closed', closed_at = now(), closed_by = $3 WHERE hotel_id = $1 AND business_date = $2", [
    input.hotelId,
    businessDate,
    ctx.userId,
  ]);
  const nextDate = new Date(`${businessDate}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextBusinessDate = nextDate.toISOString().slice(0, 10);
  await db.query(
    `INSERT INTO hotel.business_dates (tenant_id, hotel_id, business_date, status)
     VALUES ($1,$2,$3,'open') ON CONFLICT (tenant_id, hotel_id, business_date) DO NOTHING`,
    [ctx.tenantId, input.hotelId, nextBusinessDate],
  );

  await auditAction(db, ctx, 'nightaudit.completed', 'hotel', input.hotelId, {
    after: { businessDate, status, exceptions: exceptions.length, roomChargesPosted },
  });
  await emitEvent(db, ctx.tenantId, 'night_audit.completed', 'hotel', input.hotelId, {
    businessDate,
    nextBusinessDate,
  });

  return { businessDate, nextBusinessDate, status, exceptions, roomChargesPosted };
}

export async function businessDate(db: Queryable, hotelId: string) {
  const { rows } = await db.query<{ business_date: string | Date; status: string }>(
    'SELECT business_date, status FROM hotel.business_dates WHERE hotel_id = $1 ORDER BY business_date DESC LIMIT 1',
    [hotelId],
  );
  const row = rows[0];
  return row ? { business_date: isoDay(row.business_date), status: row.status } : null;
}
