import { useState } from 'react';
import { api, formatDate, formatMoney, type Row } from '../api.js';
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

function monthStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function monthEnd(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}

export function AssetsPage() {
  const assets = useAsync(() => api<{ assets: Row[] }>('GET', '/api/v1/assets'), []);
  const runs = useAsync(
    () => api<{ runs: Row[] }>('GET', '/api/v1/assets/depreciation-runs'),
    [],
  );
  const action = useAction();

  const [assetCode, setAssetCode] = useState('');
  const [assetName, setAssetName] = useState('');
  const [category, setCategory] = useState('Equipment');
  const [acquisitionDate, setAcquisitionDate] = useState(new Date().toISOString().slice(0, 10));
  const [cost, setCost] = useState('');
  const [salvage, setSalvage] = useState('0');
  const [lifeMonths, setLifeMonths] = useState('60');
  const [periodStart, setPeriodStart] = useState(monthStart);
  const [periodEnd, setPeriodEnd] = useState(monthEnd);
  const [disposeId, setDisposeId] = useState('');
  const [proceeds, setProceeds] = useState('0');

  const activeAssets = (assets.data?.assets ?? []).filter((asset) => asset.status !== 'disposed');

  async function addAsset() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/assets', {
          assetCode,
          assetName,
          category,
          acquisitionDate,
          acquisitionCost: Number(cost),
          salvageValue: Number(salvage || 0),
          usefulLifeMonths: Number(lifeMonths),
        }),
      'Asset capitalised and posted to the ledger',
    );
    if (ok) {
      setAssetCode('');
      setAssetName('');
      setCost('');
      assets.reload();
    }
  }

  async function createRun() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/assets/depreciation-runs', {
          periodStart,
          periodEnd,
        }),
      'Depreciation calculated',
    );
    if (ok) runs.reload();
  }

  async function postRun(id: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/assets/depreciation-runs/${id}/post`, {}),
      'Depreciation posted',
    );
    if (ok) {
      runs.reload();
      assets.reload();
    }
  }

  async function dispose() {
    const ok = await action.run(
      () =>
        api('POST', `/api/v1/assets/${disposeId}/dispose`, {
          disposedOn: new Date().toISOString().slice(0, 10),
          proceeds: Number(proceeds || 0),
        }),
      'Asset disposed and gain/loss posted',
    );
    if (ok) {
      setDisposeId('');
      assets.reload();
    }
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />

      <Card
        title="Capitalise an asset"
        subtitle="Acquisition posts Dr fixed assets, Cr bank. Straight-line depreciation is monthly."
      >
        <FormRow>
          <Field label="Asset code">
            <Input value={assetCode} onChange={setAssetCode} placeholder="FA-1001" />
          </Field>
          <Field label="Name">
            <Input value={assetName} onChange={setAssetName} placeholder="Delivery van" />
          </Field>
          <Field label="Category">
            <Input value={category} onChange={setCategory} />
          </Field>
          <Field label="Acquired">
            <Input value={acquisitionDate} onChange={setAcquisitionDate} type="date" />
          </Field>
          <Field label="Cost">
            <Input value={cost} onChange={setCost} type="number" min="0" />
          </Field>
          <Field label="Salvage value">
            <Input value={salvage} onChange={setSalvage} type="number" min="0" />
          </Field>
          <Field label="Useful life (months)">
            <Input value={lifeMonths} onChange={setLifeMonths} type="number" min="1" />
          </Field>
          <Button onClick={addAsset} disabled={action.busy || !assetCode || !assetName || !cost}>
            Add asset
          </Button>
        </FormRow>
      </Card>

      <Card title="Asset register" subtitle="Net book value and remaining depreciable amount">
        <Table
          rows={assets.data?.assets}
          loading={assets.loading}
          columns={[
            { key: 'asset_code', header: 'Code' },
            { key: 'asset_name', header: 'Asset' },
            { key: 'category', header: 'Category' },
            {
              key: 'acquisition_cost',
              header: 'Cost',
              align: 'right',
              render: (row) => formatMoney(row.acquisition_cost),
            },
            {
              key: 'accumulated_depreciation',
              header: 'Accumulated',
              align: 'right',
              render: (row) => formatMoney(row.accumulated_depreciation),
            },
            {
              key: 'net_book_value',
              header: 'Net book value',
              align: 'right',
              render: (row) => formatMoney(row.net_book_value),
            },
            {
              key: 'monthly_depreciation',
              header: 'Monthly',
              align: 'right',
              render: (row) => formatMoney(row.monthly_depreciation),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
          ]}
          empty="No assets registered yet."
        />
      </Card>

      <Card
        title="Depreciation"
        subtitle="One run per calendar month. Posting debits depreciation expense and credits accumulated depreciation."
      >
        <FormRow>
          <Field label="Month start">
            <Input value={periodStart} onChange={setPeriodStart} type="date" />
          </Field>
          <Field label="Month end">
            <Input value={periodEnd} onChange={setPeriodEnd} type="date" />
          </Field>
          <Button onClick={createRun} disabled={action.busy || !periodStart || !periodEnd}>
            Calculate depreciation
          </Button>
        </FormRow>

        <Table
          rows={runs.data?.runs}
          loading={runs.loading}
          columns={[
            { key: 'run_number', header: 'Run' },
            {
              key: 'period',
              header: 'Month',
              render: (row) => `${formatDate(row.period_start)} – ${formatDate(row.period_end)}`,
            },
            { key: 'assets', header: 'Assets', align: 'right' },
            {
              key: 'total_amount',
              header: 'Amount',
              align: 'right',
              render: (row) => formatMoney(row.total_amount),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) =>
                row.status === 'draft' ? (
                  <Button size="sm" variant="subtle" onClick={() => postRun(row.id)} disabled={action.busy}>
                    Post
                  </Button>
                ) : (
                  <span className="subtle">{row.journal_entry_id ? 'posted' : '—'}</span>
                ),
            },
          ]}
          empty="No depreciation runs yet."
        />
      </Card>

      <Card title="Dispose an asset" subtitle="Proceeds are compared with net book value; the difference is a gain or loss.">
        <FormRow>
          <Field label="Asset">
            <Select
              value={disposeId}
              onChange={setDisposeId}
              placeholder="Select asset"
              options={activeAssets.map((asset) => ({
                value: asset.id,
                label: `${asset.asset_code} — ${asset.asset_name}`,
              }))}
            />
          </Field>
          <Field label="Proceeds">
            <Input value={proceeds} onChange={setProceeds} type="number" min="0" />
          </Field>
          <Button variant="danger" onClick={dispose} disabled={action.busy || !disposeId}>
            Dispose
          </Button>
        </FormRow>
      </Card>
    </div>
  );
}
