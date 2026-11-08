import { api, formatMoney, today, type Row } from '../api.js';
import { Badge, Card, Stat, Table, useAsync } from '../components.js';

export function DashboardPage() {
  const hotels = useAsync(() => api<{ hotels: Row[] }>('GET', '/api/v1/hotel/hotels'), []);
  const hotelId = hotels.data?.hotels[0]?.id as string | undefined;
  const dashboard = useAsync(
    () => (hotelId ? api<Row>('GET', `/api/v1/reports/dashboard?hotelId=${hotelId}`) : Promise.resolve(null)),
    [hotelId],
  );
  const sales = useAsync(() => api<Row>('GET', `/api/v1/reports/daily-sales?from=${today()}&to=${today()}`), []);

  const data = dashboard.data ?? {};
  const rooms = data.rooms ?? {};
  const ledger = data.ledger ?? {};

  return (
    <>
      <div className="stats">
        <Stat label="Rooms" value={rooms.total ?? 0} hint={`${rooms.available ?? 0} available`} />
        <Stat label="Occupied" value={rooms.occupied ?? 0} hint={`${data.inHouse ?? 0} guests in house`} tone="warn" />
        <Stat
          label="Trial balance"
          value={ledger.balanced ? 'Balanced' : 'Review'}
          hint={ledger.balanced ? 'Debits equal credits' : 'Ledger out of balance'}
          tone={ledger.balanced ? 'ok' : 'bad'}
        />
        <Stat
          label="Restaurant sales today"
          value={formatMoney((sales.data?.restaurant ?? []).reduce((sum: number, row: Row) => sum + Number(row.total ?? 0), 0))}
        />
        <Stat
          label="Bar sales today"
          value={formatMoney((sales.data?.bar ?? []).reduce((sum: number, row: Row) => sum + Number(row.total ?? 0), 0))}
        />
      </div>

      <div className="grid grid-2">
        <Card title="Front office snapshot" subtitle="Live counts from the operational database">
          <Table
            rows={[
              { id: 'in-house', label: 'In-house stays', value: data.inHouse ?? 0 },
              { id: 'arrivals', label: 'Arrivals today', value: data.arrivals ?? data.arrivalsToday ?? 0 },
              { id: 'departures', label: 'Departures today', value: data.departures ?? data.departuresToday ?? 0 },
              { id: 'dirty', label: 'Rooms not yet clean', value: rooms.dirty ?? 0 },
              { id: 'oo', label: 'Out of order', value: rooms.outOfOrder ?? rooms.out_of_order ?? 0 },
            ]}
            columns={[
              { key: 'label', header: 'Measure' },
              { key: 'value', header: 'Value', align: 'right' },
            ]}
            loading={dashboard.loading}
          />
        </Card>

        <Card
          title="Today's revenue"
          subtitle="Recognised from posted journals, not from open orders"
          actions={sales.data?.finance?.balanced ? <Badge tone="ok">Ledger balanced</Badge> : null}
        >
          <Table
            rows={[
              ...(sales.data?.restaurant ?? []).map((row: Row, index: number) => ({ id: `r-${index}`, stream: 'Restaurant', ...row })),
              ...(sales.data?.bar ?? []).map((row: Row, index: number) => ({ id: `b-${index}`, stream: 'Bar', ...row })),
            ]}
            columns={[
              { key: 'stream', header: 'Outlet' },
              { key: 'orders', header: 'Orders', align: 'right' },
              { key: 'total', header: 'Sales', align: 'right', render: (row) => formatMoney(row.total) },
            ]}
            empty="No paid sales recorded today yet."
            loading={sales.loading}
          />
        </Card>
      </div>

      <Card title="Daily sales" subtitle={`Business date ${today()}`}>
        <Table
          rows={sales.data?.hotel ?? []}
          columns={[
            { key: 'business_date', header: 'Date' },
            { key: 'source', header: 'Stream' },
            { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatMoney(row.amount) },
          ]}
          empty="Hotel revenue for today appears here once night audit posts room charges."
          loading={sales.loading}
        />
      </Card>
    </>
  );
}
