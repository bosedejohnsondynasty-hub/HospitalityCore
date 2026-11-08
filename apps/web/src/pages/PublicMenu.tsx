import { useState } from 'react';
import { api, formatMoney, type Row } from '../api.js';
import { Badge, Button, Card, Input, Notice, useAction, useAsync } from '../components.js';

export function PublicMenuPage({ token }: { token: string }) {
  const menu = useAsync(() => api<Row>('GET', `/api/v1/public/qr/${token}/menu`), [token]);
  const action = useAction();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [customerName, setCustomerName] = useState('');
  const [order, setOrder] = useState<Row | null>(null);

  const items: Row[] = menu.data?.menu?.items ?? menu.data?.items ?? [];
  const outlet = menu.data?.outlet ?? menu.data?.menu?.outlet ?? {};
  const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0);
  const subtotal = lines.reduce((sum, [id, quantity]) => {
    const item = items.find((row) => row.id === id);
    return sum + Number(item?.price ?? 0) * quantity;
  }, 0);

  async function submit() {
    const ok = await action.run(
      () =>
        api<Row>('POST', `/api/v1/public/qr/${token}/orders`, {
          items: lines.map(([itemId, quantity]) => ({ itemId, quantity })),
          customerName: customerName || 'Guest',
        }).then((result) => {
          setOrder(result);
          return result;
        }),
      'Order received',
    );
    if (ok) setCart({});
  }

  if (menu.loading) return <div className="qr-page"><p className="subtle">Loading menu…</p></div>;
  if (menu.error) {
    return (
      <div className="qr-page">
        <Card title="Menu unavailable">
          <p className="subtle">{menu.error}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="qr-page">
      <div className="qr-card">
        <Card
          title={outlet.outlet_name ?? outlet.name ?? 'Order online'}
          subtitle={outlet.branch_name ? `${outlet.branch_name} · table service` : 'Scan, choose and send your order to the kitchen'}
        >
          {order ? (
            <div className="grid" style={{ gap: '0.8rem' }}>
              <Badge tone="ok">Order {order.orderNumber ?? order.order_number}</Badge>
              <p>
                Your order has been sent to the kitchen. Total{' '}
                <strong>{formatMoney(order.total)}</strong>.
              </p>
              <p className="subtle">
                Payment: {String(order.paymentTiming ?? order.payment_timing ?? 'pay_after').replace('_', ' ')}.
                {order.status ? ` Status: ${order.status}.` : ''}
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  setOrder(null);
                  setCart({});
                }}
              >
                Start another order
              </Button>
            </div>
          ) : (
            <>
              <Notice error={action.error} />
              {items.map((item) => (
                <div className="qr-item" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.description ?? ''}</small>
                    <small>{formatMoney(item.price)}</small>
                  </div>
                  <div className="qr-qty">
                    <button
                      type="button"
                      onClick={() => setCart({ ...cart, [item.id]: Math.max(0, (cart[item.id] ?? 0) - 1) })}
                    >
                      −
                    </button>
                    <span>{cart[item.id] ?? 0}</span>
                    <button type="button" onClick={() => setCart({ ...cart, [item.id]: (cart[item.id] ?? 0) + 1 })}>
                      +
                    </button>
                  </div>
                </div>
              ))}
              {items.length === 0 && <p className="empty">This menu has no available items right now.</p>}
              <div className="qr-total">
                <span>Items subtotal</span>
                <span>{formatMoney(subtotal)}</span>
              </div>
              <p className="subtle">Tax and service charge are added by the restaurant when the order is placed.</p>
              <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.8rem' }}>
                <Input value={customerName} onChange={setCustomerName} placeholder="Your name (optional)" />
                <Button onClick={submit} disabled={action.busy || lines.length === 0}>
                  Send order to the kitchen
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
