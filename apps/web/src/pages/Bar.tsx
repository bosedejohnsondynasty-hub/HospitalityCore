import { useState } from 'react';
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
  statusTone,
  useAction,
  useAsync,
} from '../components.js';

export function BarPage() {
  const outlets = useAsync(() => api<{ outlets: Row[] }>('GET', '/api/v1/bar/outlets'), []);
  const outlet = outlets.data?.outlets[0];
  if (outlets.loading) return <p className="subtle">Loading bar outlets…</p>;
  if (!outlet) return <p className="empty">No bar is configured. License the Bar product first.</p>;

  return (
    <Card
      title={outlet.outlet_name ?? outlet.name ?? 'Bar'}
      subtitle={`${outlet.outlet_code ?? ''} · beverage stock is deducted from the bar store on each sale`}
    >
      <div className="grid" style={{ gap: '1.2rem' }}>
        <BeveragesTab barId={outlet.id} />
        <OrdersTab barId={outlet.id} />
      </div>
    </Card>
  );
}

function BeveragesTab({ barId }: { barId: string }) {
  const beverages = useAsync(
    () => api<{ beverages: Row[] }>('GET', `/api/v1/bar/outlets/${barId}/beverages`),
    [barId],
  );
  const action = useAction();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('beer');
  const [salePrice, setSalePrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [inventorySku, setInventorySku] = useState('');

  async function create() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/bar/beverages', {
          barId,
          sku,
          name,
          category,
          salePrice: Number(salePrice),
          costPrice: Number(costPrice || 0),
          inventorySku: inventorySku || undefined,
        }),
      'Beverage added',
    );
    if (ok) {
      setSku('');
      setName('');
      setSalePrice('');
      setCostPrice('');
      setInventorySku('');
      beverages.reload();
    }
  }

  return (
    <div className="grid" style={{ gap: '0.9rem' }}>
      <h2>Beverage menu</h2>
      <Notice error={action.error} notice={action.notice} />
      <FormRow>
        <Field label="SKU"><Input value={sku} onChange={setSku} placeholder="BEER-BTL" /></Field>
        <Field label="Name"><Input value={name} onChange={setName} placeholder="Lager Bottle" /></Field>
        <Field label="Category">
          <Select
            value={category}
            onChange={setCategory}
            options={[
              { value: 'beer', label: 'Beer' },
              { value: 'wine', label: 'Wine' },
              { value: 'spirit', label: 'Spirit' },
              { value: 'cocktail', label: 'Cocktail' },
              { value: 'soft', label: 'Soft drink' },
            ]}
          />
        </Field>
        <Field label="Sale price"><Input value={salePrice} onChange={setSalePrice} type="number" /></Field>
        <Field label="Cost price"><Input value={costPrice} onChange={setCostPrice} type="number" /></Field>
        <Field label="Stock SKU" hint="Inventory item deducted per sale"><Input value={inventorySku} onChange={setInventorySku} /></Field>
        <Button onClick={create} disabled={action.busy || !sku || !name || !salePrice}>Add beverage</Button>
      </FormRow>

      <Table
        rows={beverages.data?.beverages}
        loading={beverages.loading}
        columns={[
          { key: 'sku', header: 'SKU' },
          { key: 'name', header: 'Beverage' },
          { key: 'category', header: 'Category' },
          { key: 'sale_price', header: 'Price', align: 'right', render: (row) => formatMoney(row.sale_price) },
          { key: 'cost_price', header: 'Cost', align: 'right', render: (row) => formatMoney(row.cost_price) },
          { key: 'inventory_sku', header: 'Stock item', render: (row) => row.inventory_sku ?? '—' },
        ]}
        empty="No beverages configured."
      />
    </div>
  );
}

function OrdersTab({ barId }: { barId: string }) {
  const orders = useAsync(() => api<{ orders: Row[] }>('GET', `/api/v1/bar/orders?barId=${barId}`), [barId]);
  const beverages = useAsync(
    () => api<{ beverages: Row[] }>('GET', `/api/v1/bar/outlets/${barId}/beverages`),
    [barId],
  );
  const action = useAction();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [folioId, setFolioId] = useState('');

  const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0);

  async function createOrder() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/bar/orders', {
          barId,
          items: lines.map(([beverageId, quantity]) => ({ beverageId, quantity })),
        }),
      'Bar order created',
    );
    if (ok) {
      setCart({});
      orders.reload();
    }
  }

  async function chargeToFolio(orderId: string) {
    if (!folioId.trim()) return;
    const ok = await action.run(
      () => api('POST', `/api/v1/bar/orders/${orderId}/charge-to-folio`, { folioId: folioId.trim() }),
      'Bar charge posted to the guest folio',
    );
    if (ok) orders.reload();
  }

  return (
    <div className="grid" style={{ gap: '0.9rem' }}>
      <h2>Bar orders</h2>
      <Notice error={action.error} notice={action.notice} />
      <div className="grid grid-2">
        <div>
          {(beverages.data?.beverages ?? []).slice(0, 10).map((beverage) => (
            <div className="qr-item" key={beverage.id}>
              <div>
                <strong>{beverage.name}</strong>
                <small>{formatMoney(beverage.sale_price)}</small>
              </div>
              <div className="qr-qty">
                <button type="button" onClick={() => setCart({ ...cart, [beverage.id]: Math.max(0, (cart[beverage.id] ?? 0) - 1) })}>−</button>
                <span>{cart[beverage.id] ?? 0}</span>
                <button type="button" onClick={() => setCart({ ...cart, [beverage.id]: (cart[beverage.id] ?? 0) + 1 })}>+</button>
              </div>
            </div>
          ))}
          <FormRow>
            <Button onClick={createOrder} disabled={action.busy || lines.length === 0}>
              Create order
            </Button>
          </FormRow>
        </div>
        <div>
          <Field label="Folio id for guest billing">
            <Input value={folioId} onChange={setFolioId} placeholder="Hotel folio uuid" />
          </Field>
          <p className="subtle" style={{ marginTop: '0.5rem' }}>
            Bar sales deduct beverage stock immediately. Charging to a folio records the guest liability without
            recognising bar revenue a second time.
          </p>
        </div>
      </div>

      <Table
        rows={orders.data?.orders}
        loading={orders.loading}
        columns={[
          { key: 'order_number', header: 'Order' },
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
            render: (row) =>
              row.payment_status !== 'paid' && !row.folio_id ? (
                <Button size="sm" onClick={() => chargeToFolio(row.id)} disabled={action.busy || !folioId.trim()}>
                  To folio
                </Button>
              ) : null,
          },
        ]}
        empty="No bar orders yet."
      />
    </div>
  );
}
