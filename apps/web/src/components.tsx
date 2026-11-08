import { useCallback, useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import type { Row } from './api.js';

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(load, [load]);
  return { data, loading, error, reload: load };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<unknown>, message = 'Saved') => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(message);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Request failed');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { run, busy, error, notice, reset };
}

export function Card(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${props.className ?? ''}`}>
      {(props.title || props.actions) && (
        <header className="card-head">
          <div>
            {props.title && <h2>{props.title}</h2>}
            {props.subtitle && <p className="subtle">{props.subtitle}</p>}
          </div>
          {props.actions && <div className="card-actions">{props.actions}</div>}
        </header>
      )}
      <div className="card-body">{props.children}</div>
    </section>
  );
}

export function Stat(props: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <strong className="stat-value">{props.value}</strong>
      {props.hint && <span className={`stat-hint ${props.tone ?? ''}`}>{props.hint}</span>}
    </div>
  );
}

export type Column<T extends Row> = {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
};

export function Table<T extends Row>(props: {
  columns: Array<Column<T>>;
  rows: T[] | undefined;
  empty?: string;
  loading?: boolean;
}) {
  if (props.loading && !props.rows) return <p className="subtle">Loading…</p>;
  const rows = props.rows ?? [];
  if (rows.length === 0) return <p className="empty">{props.empty ?? 'Nothing to show yet.'}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column.key} className={`align-${column.align ?? 'left'}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? row.balance_id ?? row.account_code ?? index)}>
              {props.columns.map((column) => (
                <td key={column.key} className={`align-${column.align ?? 'left'}`}>
                  {column.render ? column.render(row) : (row[column.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

export function Badge(props: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge-${props.tone ?? 'neutral'}`}>{props.children}</span>;
}

export function statusTone(status: string | null | undefined): BadgeTone {
  const value = String(status ?? '').toLowerCase();
  if (['paid', 'completed', 'active', 'successful', 'inspected', 'approved', 'posted', 'clean', 'ready', 'available'].includes(value)) return 'ok';
  if (['cancelled', 'failed', 'rejected', 'void', 'no_show', 'out_of_order', 'critical', 'unpaid'].includes(value)) return 'bad';
  if (['pending', 'in_progress', 'preparing', 'placed', 'accepted', 'dirty', 'occupied', 'warning', 'draft'].includes(value)) return 'warn';
  if (['in_house', 'confirmed', 'served', 'queued', 'open'].includes(value)) return 'info';
  return 'neutral';
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn btn-${props.variant ?? 'primary'} btn-${props.size ?? 'md'}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small className="subtle">{props.hint}</small>}
    </label>
  );
}

export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  min?: string;
  step?: string;
}) {
  return (
    <input
      value={props.value}
      type={props.type ?? 'text'}
      placeholder={props.placeholder}
      required={props.required}
      min={props.min}
      step={props.step}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
    />
  );
}

export function Select(props: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.placeholder && <option value="">{props.placeholder}</option>}
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Tabs<T extends string>(props: {
  tabs: Array<{ key: T; label: string }>;
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <nav className="tabs">
      {props.tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={tab.key === props.active ? 'tab active' : 'tab'}
          onClick={() => props.onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

export function Notice(props: { error?: string | null; notice?: string | null }) {
  if (!props.error && !props.notice) return null;
  return (
    <div className={props.error ? 'notice error' : 'notice ok'}>
      {props.error ?? props.notice}
    </div>
  );
}

export function FormRow(props: { children: ReactNode }) {
  return <div className="form-row">{props.children}</div>;
}
