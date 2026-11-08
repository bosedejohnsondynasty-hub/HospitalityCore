import { useMemo, useState } from 'react';
import { addDays, api, formatDate, formatMoney, today, type Row } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Field,
  FormRow,
  Input,
  Notice,
  Select,
  Table,
  Tabs,
  statusTone,
  useAction,
  useAsync,
} from '../components.js';

type Tab = 'rooms' | 'guests' | 'reservations' | 'folios' | 'housekeeping' | 'audit';

export function HotelPage() {
  const [tab, setTab] = useState<Tab>('rooms');
  const hotels = useAsync(() => api<{ hotels: Row[] }>('GET', '/api/v1/hotel/hotels'), []);
  const hotel = hotels.data?.hotels[0];
  const hotelId: string | undefined = hotel?.id;
  const rooms = useAsync(
    () => (hotelId ? api<{ rooms: Row[] }>('GET', `/api/v1/hotel/rooms?hotelId=${hotelId}`) : Promise.resolve({ rooms: [] })),
    [hotelId],
  );

  if (hotels.loading) return <p className="subtle">Loading hotel configuration…</p>;
  if (!hotel) return <p className="empty">No hotel is configured for this tenant. License the Hotel product first.</p>;

  return (
    <>
      <Card
        title={hotel.hotel_name ?? hotel.name ?? 'Hotel'}
        subtitle={`${hotel.hotel_code ?? ''} · ${rooms.data?.rooms.length ?? 0} rooms · ${hotel.address_city ?? 'on-premises'}`}
      >
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'rooms', label: 'Rooms' },
            { key: 'guests', label: 'Guests' },
            { key: 'reservations', label: 'Reservations & front desk' },
            { key: 'folios', label: 'Folios & cashiering' },
            { key: 'housekeeping', label: 'Housekeeping' },
            { key: 'audit', label: 'Night audit' },
          ]}
        />
        <div style={{ paddingTop: '1rem' }}>
          {tab === 'rooms' && <RoomsTab rooms={rooms.data?.rooms} loading={rooms.loading} />}
          {tab === 'guests' && <GuestsTab />}
          {tab === 'reservations' && (
            <ReservationsTab hotelId={hotel.id} rooms={rooms.data?.rooms ?? []} reloadRooms={rooms.reload} />
          )}
          {tab === 'folios' && <FoliosTab currency={hotel.currency_code ?? 'NGN'} />}
          {tab === 'housekeeping' && <HousekeepingTab hotelId={hotel.id} rooms={rooms.data?.rooms ?? []} />}
          {tab === 'audit' && <NightAuditTab hotelId={hotel.id} />}
        </div>
      </Card>
    </>
  );
}

function RoomsTab({ rooms, loading }: { rooms: Row[] | undefined; loading: boolean }) {
  return (
    <Table
      rows={rooms}
      loading={loading}
      columns={[
        { key: 'room_number', header: 'Room' },
        { key: 'room_type_name', header: 'Type' },
        { key: 'floor', header: 'Floor', align: 'center' },
        {
          key: 'occupancy_status',
          header: 'Occupancy',
          render: (row) => <Badge tone={statusTone(row.occupancy_status)}>{row.occupancy_status}</Badge>,
        },
        {
          key: 'housekeeping_status',
          header: 'Housekeeping',
          render: (row) => (
            <Badge tone={row.housekeeping_status === 'inspected' ? 'ok' : 'warn'}>{row.housekeeping_status}</Badge>
          ),
        },
        {
          key: 'is_out_of_order',
          header: 'Out of order',
          align: 'center',
          render: (row) => (row.is_out_of_order ? <Badge tone="bad">yes</Badge> : '—'),
        },
      ]}
      empty="No rooms configured."
    />
  );
}

function GuestsTab() {
  const guests = useAsync(() => api<{ guests: Row[] }>('GET', '/api/v1/hotel/guests'), []);
  const action = useAction();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  async function create() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/hotel/guests', {
          firstName,
          lastName,
          email: email || undefined,
          phone: phone || undefined,
        }),
      'Guest created',
    );
    if (ok) {
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      guests.reload();
    }
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <FormRow>
        <Field label="First name"><Input value={firstName} onChange={setFirstName} required /></Field>
        <Field label="Last name"><Input value={lastName} onChange={setLastName} required /></Field>
        <Field label="Email"><Input value={email} onChange={setEmail} type="email" /></Field>
        <Field label="Phone"><Input value={phone} onChange={setPhone} /></Field>
        <Button onClick={create} disabled={action.busy || !firstName || !lastName}>Add guest</Button>
      </FormRow>
      <Table
        rows={guests.data?.guests}
        loading={guests.loading}
        columns={[
          { key: 'guest_number', header: 'Guest no.' },
          { key: 'first_name', header: 'First name' },
          { key: 'last_name', header: 'Last name' },
          { key: 'email', header: 'Email' },
          { key: 'phone', header: 'Phone' },
          { key: 'vip_status', header: 'VIP', render: (row) => (row.vip_status ? <Badge tone="info">{row.vip_status}</Badge> : '—') },
        ]}
        empty="No guests registered yet."
      />
    </div>
  );
}

function ReservationsTab({ hotelId, rooms, reloadRooms }: { hotelId: string; rooms: Row[]; reloadRooms: () => void }) {
  const reservations = useAsync(() => api<{ reservations: Row[] }>('GET', `/api/v1/hotel/reservations?hotelId=${hotelId}`), [hotelId]);
  const guests = useAsync(() => api<{ guests: Row[] }>('GET', '/api/v1/hotel/guests'), []);
  const action = useAction();
  const [guestId, setGuestId] = useState('');
  const [roomTypeName, setRoomTypeName] = useState('');
  const [arrival, setArrival] = useState(today());
  const [departure, setDeparture] = useState(addDays(today(), 1));
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const availability = useAsync(
    () =>
      api<{ rooms: Row[] }>(
        'GET',
        `/api/v1/hotel/availability?hotelId=${hotelId}&from=${arrival}&to=${departure}`,
      ),
    [hotelId, arrival, departure],
  );

  const roomTypes = useMemo(() => {
    const seen = new Map<string, { value: string; label: string }>();
    for (const room of availability.data?.rooms ?? []) {
      const key = String(room.room_type_name ?? room.room_type_id ?? '');
      if (key && !seen.has(key)) {
        seen.set(key, {
          value: key,
          label: `${room.room_type_name ?? key}${room.base_rate ? ` · ${formatMoney(room.base_rate)}` : ''}`,
        });
      }
    }
    return [...seen.values()];
  }, [availability.data]);

  const roomTypeId = useMemo(() => {
    const match = (availability.data?.rooms ?? []).find(
      (room) => String(room.room_type_name ?? room.room_type_id ?? '') === roomTypeName,
    );
    return match?.room_type_id as string | undefined;
  }, [availability.data, roomTypeName]);

  async function createReservation() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/hotel/reservations', {
          hotelId,
          guestId,
          roomTypeId,
          arrivalDate: arrival,
          departureDate: departure,
        }),
      'Reservation created',
    );
    if (ok) reservations.reload();
  }

  async function allocate(reservationId: string) {
    const roomId = allocations[reservationId];
    if (!roomId) return;
    const ok = await action.run(
      () => api('POST', `/api/v1/hotel/reservations/${reservationId}/allocate`, { roomId }),
      'Room allocated',
    );
    if (ok) {
      reservations.reload();
      reloadRooms();
    }
  }

  async function checkIn(reservationId: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/hotel/reservations/${reservationId}/checkin`, {}),
      'Guest checked in',
    );
    if (ok) {
      reservations.reload();
      reloadRooms();
    }
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <FormRow>
        <Field label="Guest">
          <Select
            value={guestId}
            onChange={setGuestId}
            placeholder="Select guest"
            options={(guests.data?.guests ?? []).map((guest) => ({
              value: guest.id,
              label: `${guest.first_name} ${guest.last_name} (${guest.guest_number})`,
            }))}
          />
        </Field>
        <Field label="Room type" hint={`${availability.data?.rooms?.length ?? 0} rooms in availability window`}>
          <Select value={roomTypeName} onChange={setRoomTypeName} placeholder="Select type" options={roomTypes} />
        </Field>
        <Field label="Arrival"><Input value={arrival} onChange={setArrival} type="date" /></Field>
        <Field label="Departure"><Input value={departure} onChange={setDeparture} type="date" /></Field>
        <Button onClick={createReservation} disabled={action.busy || !guestId || !roomTypeId}>
          Create reservation
        </Button>
      </FormRow>

      <Table
        rows={reservations.data?.reservations}
        loading={reservations.loading}
        columns={[
          { key: 'reservation_number', header: 'Reservation' },
          {
            key: 'guest',
            header: 'Guest',
            render: (row) => `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
          },
          { key: 'room_type_name', header: 'Type' },
          { key: 'arrival_date', header: 'Arrival', render: (row) => formatDate(row.arrival_date) },
          { key: 'departure_date', header: 'Departure', render: (row) => formatDate(row.departure_date) },
          { key: 'rooms', header: 'Room', render: (row) => row.rooms ?? '—' },
          { key: 'status', header: 'Status', render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge> },
          {
            key: 'actions',
            header: 'Action',
            render: (row) => {
              if (row.status === 'checked_in') return <span className="subtle">In house</span>;
              if (!row.rooms) {
                return (
                  <div className="form-row" style={{ gap: '0.3rem' }}>
                    <select
                      value={allocations[row.id] ?? ''}
                      onChange={(event) => setAllocations({ ...allocations, [row.id]: event.target.value })}
                      style={{ minWidth: 110 }}
                    >
                      <option value="">Room…</option>
                      {rooms
                        .filter((room) => !room.is_out_of_order)
                        .map((room) => (
                          <option key={room.id} value={room.id}>
                            {room.room_number}
                          </option>
                        ))}
                    </select>
                    <Button size="sm" variant="ghost" onClick={() => allocate(row.id)} disabled={action.busy}>
                      Allocate
                    </Button>
                  </div>
                );
              }
              return (
                <Button size="sm" onClick={() => checkIn(row.id)} disabled={action.busy}>
                  Check in
                </Button>
              );
            },
          },
        ]}
        empty="No reservations yet."
      />
    </div>
  );
}

function FoliosTab({ currency }: { currency: string }) {
  const [folioId, setFolioId] = useState('');
  const [loadedId, setLoadedId] = useState('');
  const folio = useAsync(
    () => (loadedId ? api<Row>('GET', `/api/v1/hotel/folios/${loadedId}`) : Promise.resolve(null)),
    [loadedId],
  );
  const action = useAction();
  const [entryType, setEntryType] = useState('misc');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [payAmount, setPayAmount] = useState('');
  const [reference, setReference] = useState('');

  const data = folio.data;
  const entries: Row[] = data?.entries ?? [];

  async function postCharge() {
    const ok = await action.run(
      () =>
        api('POST', `/api/v1/hotel/folios/${loadedId}/charges`, {
          entryType,
          description,
          amount: Number(amount),
        }),
      'Charge posted to the folio',
    );
    if (ok) {
      setDescription('');
      setAmount('');
      folio.reload();
    }
  }

  async function settle() {
    const value = Number(payAmount || data?.balance || 0);
    const ok = await action.run(
      () =>
        api('POST', `/api/v1/hotel/folios/${loadedId}/settle`, {
          amount: value,
          method,
          reference: reference || undefined,
        }),
      'Folio settled',
    );
    if (ok) {
      setPayAmount('');
      setReference('');
      folio.reload();
    }
  }

  async function reverse(entryId: string) {
    const ok = await action.run(
      () =>
        api('POST', `/api/v1/hotel/folio-entries/${entryId}/reverse`, {
          reason: 'Reversed from front desk with manager authorisation',
        }),
      'Entry reversed',
    );
    if (ok) folio.reload();
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <FormRow>
        <Field label="Folio id" hint="Open a guest folio to post charges or settle.">
          <Input value={folioId} onChange={setFolioId} placeholder="folio uuid" />
        </Field>
        <Button variant="ghost" onClick={() => setLoadedId(folioId.trim())} disabled={!folioId.trim()}>
          Load folio
        </Button>
      </FormRow>

      {data && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="stat-label">Folio</span>
              <strong className="stat-value" style={{ fontSize: '1.1rem' }}>{data.folio_number}</strong>
              <span className="stat-hint">{data.status}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Balance</span>
              <strong className="stat-value">{formatMoney(data.balance, currency)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Entries</span>
              <strong className="stat-value">{entries.length}</strong>
            </div>
          </div>

          <Table
            rows={entries}
            columns={[
              { key: 'posted_at', header: 'Posted', render: (row) => formatDate(row.posted_at) },
              { key: 'entry_type', header: 'Type' },
              { key: 'description', header: 'Description' },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatMoney(row.amount, currency) },
              {
                key: 'reverse',
                header: '',
                align: 'right',
                render: (row) =>
                  row.entry_type === 'reversal' ? null : (
                    <Button size="sm" variant="danger" onClick={() => reverse(row.id)} disabled={action.busy}>
                      Reverse
                    </Button>
                  ),
              },
            ]}
            empty="No entries on this folio."
          />

          <FormRow>
            <Field label="Charge type">
              <Select
                value={entryType}
                onChange={setEntryType}
                options={[
                  { value: 'misc', label: 'Miscellaneous' },
                  { value: 'room_charge', label: 'Room charge' },
                  { value: 'restaurant_charge', label: 'Restaurant charge' },
                  { value: 'bar_charge', label: 'Bar charge' },
                  { value: 'laundry', label: 'Laundry' },
                  { value: 'minibar', label: 'Minibar' },
                ]}
              />
            </Field>
            <Field label="Description"><Input value={description} onChange={setDescription} /></Field>
            <Field label={`Amount (${currency})`}><Input value={amount} onChange={setAmount} type="number" /></Field>
            <Button onClick={postCharge} disabled={action.busy || !description || !amount}>
              Post charge
            </Button>
          </FormRow>

          <FormRow>
            <Field label="Settlement amount">
              <Input value={payAmount} onChange={setPayAmount} type="number" placeholder={String(data.balance ?? '')} />
            </Field>
            <Field label="Method">
              <Select
                value={method}
                onChange={setMethod}
                options={[
                  { value: 'cash', label: 'Cash' },
                  { value: 'bank_transfer', label: 'Bank transfer' },
                  { value: 'pos_terminal', label: 'POS terminal' },
                ]}
              />
            </Field>
            <Field label="Reference"><Input value={reference} onChange={setReference} /></Field>
            <Button onClick={settle} disabled={action.busy || Number(data.balance) <= 0}>
              Settle folio
            </Button>
          </FormRow>
        </>
      )}
    </div>
  );
}

function HousekeepingTab({ hotelId, rooms }: { hotelId: string; rooms: Row[] }) {
  const tasks = useAsync(
    () => api<{ tasks: Row[] }>('GET', `/api/v1/hotel/housekeeping/tasks?hotelId=${hotelId}`),
    [hotelId],
  );
  const action = useAction();
  const [roomId, setRoomId] = useState('');
  const [taskCode, setTaskCode] = useState('CHECKOUT_CLEAN');

  async function create() {
    const ok = await action.run(
      () => api('POST', '/api/v1/hotel/housekeeping/tasks', { hotelId, roomId, taskCode }),
      'Task assigned',
    );
    if (ok) tasks.reload();
  }

  async function complete(taskId: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/hotel/housekeeping/tasks/${taskId}/complete`, { notes: 'Completed on web' }),
      'Task completed',
    );
    if (ok) tasks.reload();
  }

  async function inspect(taskId: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/hotel/housekeeping/tasks/${taskId}/inspect`, { result: 'passed', score: 95 }),
      'Room inspected and released',
    );
    if (ok) tasks.reload();
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <FormRow>
        <Field label="Room">
          <Select
            value={roomId}
            onChange={setRoomId}
            placeholder="Select room"
            options={rooms.map((room) => ({ value: room.id, label: room.room_number }))}
          />
        </Field>
        <Field label="Task">
          <Select
            value={taskCode}
            onChange={setTaskCode}
            options={[
              { value: 'CHECKOUT_CLEAN', label: 'Checkout clean' },
              { value: 'STAYOVER_CLEAN', label: 'Stayover clean' },
              { value: 'DEEP_CLEAN', label: 'Deep clean' },
              { value: 'TURNDOWN', label: 'Turndown' },
            ]}
          />
        </Field>
        <Button onClick={create} disabled={action.busy || !roomId}>Assign task</Button>
      </FormRow>

      <Table
        rows={tasks.data?.tasks}
        loading={tasks.loading}
        columns={[
          { key: 'room_number', header: 'Room' },
          { key: 'task_code', header: 'Task' },
          { key: 'status', header: 'Status', render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge> },
          { key: 'assigned_name', header: 'Assigned', render: (row) => row.assigned_name ?? '—' },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (row) => (
              <div className="form-row" style={{ justifyContent: 'flex-end', gap: '0.3rem' }}>
                {['pending', 'assigned', 'in_progress'].includes(row.status) && (
                  <Button size="sm" variant="ghost" onClick={() => complete(row.id)} disabled={action.busy}>
                    Complete
                  </Button>
                )}
                {row.status === 'completed' && (
                  <Button size="sm" onClick={() => inspect(row.id)} disabled={action.busy}>
                    Inspect
                  </Button>
                )}
              </div>
            ),
          },
        ]}
        empty="No housekeeping tasks."
      />
    </div>
  );
}

function NightAuditTab({ hotelId }: { hotelId: string }) {
  const businessDate = useAsync(
    () => api<{ businessDate: Row | null }>('GET', `/api/v1/hotel/business-date?hotelId=${hotelId}`),
    [hotelId],
  );
  const action = useAction();
  const [overrideReason, setOverrideReason] = useState('');
  const [result, setResult] = useState<Row | null>(null);

  async function runAudit() {
    setResult(null);
    const ok = await action.run(
      () =>
        api<Row>('POST', '/api/v1/hotel/night-audit', {
          hotelId,
          ...(overrideReason ? { overrideReason } : {}),
        }).then((response) => {
          setResult(response);
          return response;
        }),
      'Night audit completed',
    );
    if (ok) businessDate.reload();
  }

  const exceptions: Row[] = result?.exceptions ?? [];

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <div className="stats">
        <div className="stat">
          <span className="stat-label">Business date</span>
          <strong className="stat-value" style={{ fontSize: '1.2rem' }}>
            {businessDate.data?.businessDate?.business_date ?? '—'}
          </strong>
          <span className="stat-hint">{businessDate.data?.businessDate?.status ?? 'no open date'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Room charges posted</span>
          <strong className="stat-value">{result?.roomChargesPosted ?? '—'}</strong>
        </div>
        <div className="stat">
          <span className="stat-label">Result</span>
          <strong className="stat-value" style={{ fontSize: '1.05rem' }}>{result?.status ?? 'not run'}</strong>
        </div>
      </div>

      <p className="subtle">
        Night audit posts the room charge for every in-house stay, closes the business date and opens the next one.
        Critical exceptions block the run unless an authorised override with a reason is supplied.
      </p>

      <FormRow>
        <Field label="Override reason" hint="Only for authorised exceptions; recorded in the audit trail.">
          <Input value={overrideReason} onChange={setOverrideReason} placeholder="Optional" />
        </Field>
        <Button onClick={runAudit} disabled={action.busy}>Run night audit</Button>
      </FormRow>

      {exceptions.length > 0 && (
        <Table
          rows={exceptions}
          columns={[
            { key: 'severity', header: 'Severity', render: (row) => <Badge tone={row.severity === 'critical' ? 'bad' : 'warn'}>{row.severity}</Badge> },
            { key: 'code', header: 'Code' },
            { key: 'message', header: 'Message' },
          ]}
        />
      )}
    </div>
  );
}
