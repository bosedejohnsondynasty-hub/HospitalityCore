import { useState } from 'react';
import { api, formatMoney, type Row } from '../api.js';
import {
  Button,
  Card,
  Field,
  FormRow,
  Input,
  Notice,
  Select,
  Table,
  useAction,
  useAsync,
} from '../components.js';

export function InventoryPage() {
  const stores = useAsync(() => api<{ stores: Row[] }>('GET', '/api/v1/inventory/stores'), []);
  const items = useAsync(() => api<{ items: Row[] }>('GET', '/api/v1/inventory/items'), []);
  const suppliers = useAsync(() => api<{ suppliers: Row[] }>('GET', '/api/v1/procurement/suppliers'), []);
  const [storeId, setStoreId] = useState('');
  const action = useAction();
  const [itemId, setItemId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');

  const activeStore = storeId || (stores.data?.stores[0]?.id ?? '');
  const balances = useAsync(
    () =>
      activeStore
        ? api<{ balances: Row[] }>('GET', `/api/v1/inventory/balances?storeId=${activeStore}`)
        : Promise.resolve({ balances: [] }),
    [activeStore],
  );

  async function receive() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/inventory/receipts', {
          storeId: activeStore,
          supplierId: supplierId || undefined,
          items: [{ itemId, quantity: Number(quantity), unitCost: Number(unitCost) }],
        }),
      'Stock received and posted to inventory',
    );
    if (ok) {
      setQuantity('');
      balances.reload();
    }
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />

      <Card title="Receive stock" subtitle="A goods receipt posts inventory and the supplier liability together">
        <FormRow>
          <Field label="Store">
            <Select
              value={activeStore}
              onChange={setStoreId}
              placeholder="Select store"
              options={(stores.data?.stores ?? []).map((store) => ({
                value: store.id,
                label: store.store_name ?? store.store_code,
              }))}
            />
          </Field>
          <Field label="Item">
            <Select
              value={itemId}
              onChange={setItemId}
              placeholder="Select item"
              options={(items.data?.items ?? []).map((item) => ({
                value: item.id,
                label: `${item.name} (${item.sku})`,
              }))}
            />
          </Field>
          <Field label="Supplier">
            <Select
              value={supplierId}
              onChange={setSupplierId}
              placeholder="Optional"
              options={(suppliers.data?.suppliers ?? []).map((supplier) => ({
                value: supplier.id,
                label: supplier.name,
              }))}
            />
          </Field>
          <Field label="Quantity"><Input value={quantity} onChange={setQuantity} type="number" /></Field>
          <Field label="Unit cost"><Input value={unitCost} onChange={setUnitCost} type="number" /></Field>
          <Button onClick={receive} disabled={action.busy || !activeStore || !itemId || !quantity || !unitCost}>
            Receive
          </Button>
        </FormRow>
      </Card>

      <div className="grid grid-2">
        <Card
          title="Stock balances"
          actions={
            <Select
              value={activeStore}
              onChange={setStoreId}
              placeholder="Select store"
              options={(stores.data?.stores ?? []).map((store) => ({
                value: store.id,
                label: store.store_name ?? store.store_code,
              }))}
            />
          }
        >
          <Table
            rows={balances.data?.balances}
            loading={balances.loading}
            columns={[
              { key: 'item_name', header: 'Item', render: (row) => row.item_name ?? row.sku ?? '—' },
              { key: 'quantity', header: 'Quantity', align: 'right' },
              { key: 'base_unit', header: 'Unit', render: (row) => row.base_unit ?? row.unit ?? '—' },
            ]}
            empty="No stock in this store yet."
          />
        </Card>

        <Card title="Item catalogue">
          <Table
            rows={items.data?.items}
            loading={items.loading}
            columns={[
              { key: 'sku', header: 'SKU' },
              { key: 'name', header: 'Item' },
              { key: 'category', header: 'Category' },
              { key: 'standard_cost', header: 'Standard cost', align: 'right', render: (row) => formatMoney(row.standard_cost) },
            ]}
            empty="No inventory items."
          />
        </Card>
      </div>
    </div>
  );
}
