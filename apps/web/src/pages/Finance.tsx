import { api, formatDate, formatMoney, type Row } from '../api.js';
import { Badge, Card, Table, useAsync } from '../components.js';

export function FinancePage() {
  const trial = useAsync(() => api<Row>('GET', '/api/v1/finance/trial-balance'), []);
  const journals = useAsync(() => api<{ journals: Row[] }>('GET', '/api/v1/finance/journals'), []);
  const accounts = useAsync(() => api<{ accounts: Row[] }>('GET', '/api/v1/finance/accounts'), []);

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Card
        title="Trial balance"
        subtitle="Posted journals only. Reversals are separate entries, never edits."
        actions={
          trial.data ? (
            <Badge tone={trial.data.balanced ? 'ok' : 'bad'}>
              {trial.data.balanced ? 'Balanced' : 'Out of balance'}
            </Badge>
          ) : null
        }
      >
        <Table
          rows={trial.data?.accounts}
          loading={trial.loading}
          columns={[
            { key: 'account_code', header: 'Code' },
            { key: 'account_name', header: 'Account' },
            { key: 'account_class', header: 'Class' },
            { key: 'total_debit', header: 'Debit', align: 'right', render: (row) => formatMoney(row.total_debit) },
            { key: 'total_credit', header: 'Credit', align: 'right', render: (row) => formatMoney(row.total_credit) },
            {
              key: 'net',
              header: 'Net debit',
              align: 'right',
              render: (row) => formatMoney(row.net_debit),
            },
          ]}
          empty="No posted journals yet."
        />
        {trial.data && (
          <p className="subtle" style={{ marginTop: '0.8rem' }}>
            Total debits {formatMoney(trial.data.totalDebit)} · total credits {formatMoney(trial.data.totalCredit)}
          </p>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Recent journals">
          <Table
            rows={journals.data?.journals}
            loading={journals.loading}
            columns={[
              { key: 'entry_number', header: 'Entry' },
              { key: 'entry_date', header: 'Date', render: (row) => formatDate(row.entry_date) },
              { key: 'description', header: 'Description' },
              { key: 'status', header: 'Status', render: (row) => <Badge tone="ok">{row.status}</Badge> },
              { key: 'total', header: 'Total', align: 'right', render: (row) => formatMoney(row.total) },
            ]}
            empty="No journals posted."
          />
        </Card>

        <Card title="Chart of accounts">
          <Table
            rows={accounts.data?.accounts}
            loading={accounts.loading}
            columns={[
              { key: 'account_code', header: 'Code' },
              { key: 'account_name', header: 'Account' },
              { key: 'account_class', header: 'Class' },
              { key: 'normal_balance', header: 'Normal', render: (row) => row.normal_balance ?? row.normal ?? '—' },
            ]}
            empty="No accounts configured."
          />
        </Card>
      </div>
    </div>
  );
}
