import { useMemo, useState } from 'react';
import { api, formatMoney, type Row } from '../api.js';
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

type Tab = 'menu' | 'orders' | 'kitchen' | 'qr';

const NEXT_STATUS: Record<string, string> = {
  placed: 'accepted',
  accepted: 'preparing',
  preparing: 'ready',
  ready: 'served',
  served: 'completed',
};

export function RestaurantPage() {
  const [tab, setTab] = useState<Tab>('menu');
  const outlets = useAsync(() => api<{ outlets: Row[] }>('GET', '/api/v1/restaurant/outlets'), []);
  const [outletId, setOutletId] = useState('');
  const outlet = outlets.data?.outlets.find((row) => row.id === outletId) ?? outlets.data?.outlets[0];

  if (outlets.loading) return <p className="subtle">Loading restaurant outlets…</p>;
  if (!outlet) return <p className="empty">No restaurant outlet is configured. License the Restaurant product first.</p>;

  const menu = useAsync(() => api<Row>('GET', `/api/v1/restaurant/outlets/${outlet.id}/menu`), [outlet.id]);
  const menuItems: Row[] = useMemo(() => {
    if (!menu.data) return [];
    if (Array.isArray(menu.data.items)) return menu.data.items;
    if (Array.isArray(menu.data.categories)) {
      return menu.data.categories.flatMap((category: Row) => category.items ?? []);
    }
    return [];
  }, [menu.data]);

  return (
    <Card
      title={outlet.outlet_name ?? outlet.name ?? 'Restaurant'}
      subtitle={`${outlet.outlet_code ?? ''} · service charge ${Math.round(Number(outlet.service_charge_rate ?? 0) * 100)}%`}
      actions={
        outlets.data && outlets.data.outlets.length > 1 ? (
          <Select
            value={outlet.id}
            onChange={setOutletId}
            options={outlets.data.outlets.map((row) => ({ value: row.id, label: row.outlet_name ?? row.name }))}
          />
        ) : null
      }
    >
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'menu', label: 'Menu' },
          { key: 'orders', label: 'Orders & POS' },
          { key: 'kitchen', label: 'Kitchen display' },
          { key: 'qr', label: 'QR ordering' },
        ]}
      />
      <div style={{ paddingTop: '1rem' }}>
        {tab === 'menu' && <MenuTab outletId={outlet.id} items={menuItems} loading={menu.loading} reload={menu.reload} />}
        {tab === 'orders' && <OrdersTab outletId={outlet.id} items={menuItems} />}
        {tab === 'kitchen' && <KitchenTab outletId={outlet.id} />}
        {tab === 'qr' && <QrTab outletId={outlet.id} />}
      </div>
    </Card>
  );
}

function MenuTab(props: { outletId: string; items: Row[]; loading: boolean; reload: () => void }) {
  const stations = useAsync(
    () => api<{ stations: Row[] }>('GET', `/api/v1/restaurant/outlets/${props.outletId}/stations`),
    [props.outletId],
  );
  const menuId = useAsync(() => api<Row>('GET', `/api/v1/restaurant/outlets/${props.outletId}/menu`), [props.outletId]);
  const action = useAction();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [taxRate, setTaxRate] = useState('0.075');
  const [stationId, setStationId] = useState('');

  const resolvedMenuId = menuId.data?.menu?.id ?? menuId.data?.id ?? '';

  async function create() {
    const ok = await action.run(
      () =>
        api('POST', `/api/v1/restaurant/menus/${resolvedMenuId}/items`, {
          sku,
          name,
          price: Number(price),
          taxRate: Number(taxRate),
          kitchenStationId: stationId || undefined,
        }),
      'Menu item added',
    );
    if (ok) {
      setSku('');
      setName('');
      setPrice('');
      props.reload();
    }
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <FormRow>
        <Field label="SKU"><Input value={sku} onChange={setSku} placeholder="JOL" /></Field>
        <Field label="Name"><Input value={name} onChange={setName} placeholder="Jollof Rice" /></Field>
        <Field label="Price"><Input value={price} onChange={setPrice} type="number" /></Field>
        <Field label="Tax rate" hint="0.075 = 7.5% VAT"><Input value={taxRate} onChange={setTaxRate} type="number" step="0.001" /></Field>
        <Field label="Kitchen station">
          <Select
            value={stationId}
            onChange={setStationId}
            placeholder="Default"
            options={(stations.data?.stations ?? []).map((station) => ({
              value: station.id,
              label: station.station_name ?? station.name ?? station.station_code,
            }))}
          />
        </Field>
        <Button onClick={create} disabled={action.busy || !sku || !name || !price || !resolvedMenuId}>
          Add item
        </Button>
      </FormRow>

      <Table
        rows={props.items}
        loading={props.loading}
        columns={[
          { key: 'sku', header: 'SKU' },
          { key: 'name', header: 'Item' },
          { key: 'price', header: 'Price', align: 'right', render: (row) => formatMoney(row.price) },
          {
            key: 'tax_rate',
            header: 'Tax',
            align: 'right',
            render: (row) => `${(Number(row.tax_rate ?? 0) * 100).toFixed(1)}%`,
          },
          {
            key: 'is_available',
            header: 'Available',
            align: 'center',
            render: (row) => (row.is_available === false ? <Badge tone="bad">no</Badge> : <Badge tone="ok">yes</Badge>),
          },
          { key: 'prep_minutes', header: 'Prep', align: 'right', render: (row) => `${row.prep_minutes ?? 0} min` },
        ]}
        empty="The menu has no items yet. Add one above."
      />
    </div>
  );
}

function OrdersTab({ outletId, items }: { outletId: string; items: Row[] }) {
  const orders = useAsync(
    () => api<{ orders: Row[] }>('GET', `/api/v1/restaurant/orders?outletId=${outletId}`),
    [outletId],
  );
  const action = useAction();
  const [channel, setChannel] = useState('dine_in');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [folioId, setFolioId] = useState('');

  const cartLines = Object.entries(cart).filter(([, quantity]) => quantity > 0);
  const total = cartLines.reduce((sum, [itemId, quantity]) => {
    const item = items.find((row) => row.id === itemId);
    return sum + Number(item?.price ?? 0) * quantity;
  }, 0);

  async function createOrder() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/restaurant/orders', {
          outletId,
          channel,
          items: cartLines.map(([itemId, quantity]) => ({ itemId, quantity })),
        }),
      'Order placed',
    );
    if (ok) {
      setCart({});
      orders.reload();
    }
  }

  async function advance(orderId: string, status: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/restaurant/orders/${orderId}/status`, { status }),
      `Order moved to ${status}`,
    );
    if (ok) orders.reload();
  }

  async function chargeToFolio(orderId: string) {
    if (!folioId.trim()) return;
    const ok = await action.run(
      () => api('POST', `/api/v1/restaurant/orders/${orderId}/charge-to-folio`, { folioId: folioId.trim() }),
      'Charge posted to the guest folio',
    );
    if (ok) orders.reload();
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />

      <div className="grid grid-2">
        <Card title="New POS order" subtitle="Prices, tax and service charge are calculated on the server">
          <div className="grid" style={{ gap: '0.7rem' }}>
            {items.slice(0, 12).map((item) => (
              <div className="qr-item" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{formatMoney(item.price)}</small>
                </div>
                <div className="qr-qty">
                  <button type="button" onClick={() => setCart({ ...cart, [item.id]: Math.max(0, (cart[item.id] ?? 0) - 1) })}>−</button>
                  <span>{cart[item.id] ?? 0}</span>
                  <button type="button" onClick={() => setCart({ ...cart, [item.id]: (cart[item.id] ?? 0) + 1 })}>+</button>
                </div>
              </div>
            ))}
            {items.length === 0 && <p className="empty">Add menu items before taking orders.</p>}
            <FormRow>
              <Field label="Channel">
                <Select
                  value={channel}
                  onChange={setChannel}
                  options={[
                    { value: 'dine_in', label: 'Dine in' },
                    { value: 'takeaway', label: 'Takeaway' },
                    { value: 'delivery', label: 'Delivery' },
                    { value: 'pos', label: 'Counter POS' },
                  ]}
                />
              </Field>
              <Button onClick={createOrder} disabled={action.busy || cartLines.length === 0}>
                Place order · {formatMoney(total)}
              </Button>
            </FormRow>
          </div>
        </Card>

        <Card title="Charge to a guest folio" subtitle="Recognises revenue once and moves the liability to the guest ledger">
          <Field label="Folio id">
            <Input value={folioId} onChange={setFolioId} placeholder="Paste the folio uuid from the hotel desk" />
          </Field>
          <p className="subtle" style={{ marginTop: '0.6rem' }}>
            After the charge is posted the folio shows the amount due and the restaurant keeps the revenue.
            Charging the same order twice is refused by the posting link.
          </p>
        </Card>
      </div>

      <Table
        rows={orders.data?.orders}
        loading={orders.loading}
        columns={[
          { key: 'order_number', header: 'Order' },
          { key: 'channel', header: 'Channel' },
          { key: 'status', header: 'Status', render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge> },
          {
            key: 'payment_status',
            header: 'Payment',
            render: (row) => <Badge tone={statusTone(row.payment_status)}>{row.payment_status}</Badge>,
          },
          { key: 'total_amount', header: 'Total', align: 'right', render: (row) => formatMoney(row.total_amount) },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (row) => (
              <div className="form-row" style={{ justifyContent: 'flex-end', gap: '0.3rem' }}>
                {NEXT_STATUS[row.status] && (
                  <Button size="sm" variant="ghost" onClick={() => advance(row.id, NEXT_STATUS[row.status]!)} disabled={action.busy}>
                    {NEXT_STATUS[row.status]}
                  </Button>
                )}
                {row.payment_status !== 'paid' && !row.folio_id && (
                  <Button size="sm" onClick={() => chargeToFolio(row.id)} disabled={action.busy || !folioId.trim()}>
                    To folio
                  </Button>
                )}
              </div>
            ),
          },
        ]}
        empty="No restaurant orders yet."
      />
    </div>
  );
}

function KitchenTab({ outletId }: { outletId: string }) {
  const tickets = useAsync(
    () => api<{ tickets: Row[] }>('GET', `/api/v1/restaurant/kitchen?outletId=${outletId}`),
    [outletId],
  );
  const action = useAction();

  async function advance(orderId: string, status: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/restaurant/orders/${orderId}/status`, { status }),
      `Ticket moved to ${status}`,
    );
    if (ok) tickets.reload();
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <p className="subtle">
        Orders are routed to the kitchen station configured on each menu item. Completing an order issues its
        recipe ingredients from stock exactly once.
      </p>
      <div className="grid grid-3">
        {(tickets.data?.tickets ?? []).map((ticket) => (
          <div className="card" key={ticket.id} style={{ padding: '0.9rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{ticket.order_number}</strong>
              <Badge tone={statusTone(ticket.status)}>{ticket.status}</Badge>
            </div>
            <p className="subtle" style={{ marginTop: '0.35rem' }}>
              {ticket.station_name ?? ticket.station_code ?? 'Kitchen'} · {ticket.items ?? ticket.item_count ?? '—'} items
            </p>
            <div className="form-row" style={{ marginTop: '0.7rem', gap: '0.3rem' }}>
              {ticket.order_id && ticket.status !== 'completed' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => advance(ticket.order_id, ticket.status === 'queued' ? 'preparing' : 'ready')}
                  disabled={action.busy}
                >
                  {ticket.status === 'queued' ? 'Start' : 'Mark ready'}
                </Button>
              )}
            </div>
          </div>
        ))}
        {(tickets.data?.tickets ?? []).length === 0 && <p className="empty">No open kitchen tickets.</p>}
      </div>
    </div>
  );
}

function QrTab({ outletId }: { outletId: string }) {
  const tokens = useAsync(
    () => api<{ tokens: Row[] }>('GET', `/api/v1/restaurant/outlets/${outletId}/qr`),
    [outletId],
  );
  const tables = useAsync(
    () => api<{ tables: Row[] }>('GET', `/api/v1/restaurant/outlets/${outletId}/tables`),
    [outletId],
  );
  const action = useAction();
  const [tableId, setTableId] = useState('');
  const [label, setLabel] = useState('');

  async function create() {
    const ok = await action.run(
      () =>
        api('POST', `/api/v1/restaurant/outlets/${outletId}/qr`, {
          tableId: tableId || undefined,
          label: label || undefined,
        }),
      'QR code generated',
    );
    if (ok) {
      setLabel('');
      tokens.reload();
    }
  }

  const link = (token: string) => `${window.location.origin}${window.location.pathname}#/qr/${token}`;

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <FormRow>
        <Field label="Table">
          <Select
            value={tableId}
            onChange={setTableId}
            placeholder="No table (general QR)"
            options={(tables.data?.tables ?? []).map((table) => ({
              value: table.id,
              label: `Table ${table.table_code}`,
            }))}
          />
        </Field>
        <Field label="Label"><Input value={label} onChange={setLabel} placeholder="Terrace table 4" /></Field>
        <Button onClick={create} disabled={action.busy}>Generate QR code</Button>
      </FormRow>

      <Table
        rows={tokens.data?.tokens}
        loading={tokens.loading}
        columns={[
          { key: 'label', header: 'Label', render: (row) => row.label ?? '—' },
          { key: 'table_id', header: 'Table', render: (row) => row.table_code ?? '—' },
          {
            key: 'is_active',
            header: 'Active',
            render: (row) => (row.is_active ? <Badge tone="ok">yes</Badge> : <Badge tone="bad">no</Badge>),
          },
          {
            key: 'link',
            header: 'Guest link',
            render: (row) => (
              <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <a href={`#/qr/${row.token}`} target="_blank" rel="noreferrer">
                  Open menu
                </a>
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  onClick={() => void navigator.clipboard?.writeText(link(row.token))}
                >
                  Copy
                </button>
              </span>
            ),
          },
        ]}
        empty="No QR codes yet."
      />
    </div>
  );
}
