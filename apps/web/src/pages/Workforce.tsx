import { useState } from 'react';
import { api, formatDate, formatDateTime, formatMoney, type Row } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Field,
  FormRow,
  Input,
  Notice,
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

export function WorkforcePage({ timeZone }: { timeZone: string }) {
  const employees = useAsync(() => api<{ employees: Row[] }>('GET', '/api/v1/workforce/employees'), []);
  const runs = useAsync(
    () => api<{ runs: Row[] }>('GET', '/api/v1/workforce/payroll-runs'),
    [],
  );
  const action = useAction();

  const [fullName, setFullName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('Rooms');
  const [hireDate, setHireDate] = useState(new Date().toISOString().slice(0, 10));
  const [salary, setSalary] = useState('');
  const [periodStart, setPeriodStart] = useState(monthStart);
  const [periodEnd, setPeriodEnd] = useState(monthEnd);

  const [shiftFrom, setShiftFrom] = useState(
    () => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
  );
  const [shiftTo, setShiftTo] = useState(
    () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  );
  const [shiftEmployee, setShiftEmployee] = useState('');
  const [shiftRole, setShiftRole] = useState('');
  const [shiftStart, setShiftStart] = useState('');
  const [shiftEnd, setShiftEnd] = useState('');

  const resetShiftRange = () => {
    setShiftFrom(
      new Date(new Date().setDate(new Date().getDate() - 7))
        .toISOString()
        .slice(0, 10),
    );
    setShiftTo(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
  };

  const shifts = useAsync(
    () => api<{ shifts: Row[] }>(
      'GET',
      `/api/v1/workforce/shifts?${new URLSearchParams({ from: shiftFrom, to: shiftTo })}`,
    ),
    [shiftFrom, shiftTo],
  );
  const attendance = useAsync(
    () => api<{ attendance: Row[] }>('GET', '/api/v1/workforce/attendance'),
    [],
  );

  async function terminateEmployee(id: string, number: string) {
    if (!window.confirm(`Terminate ${number} and cancel their future scheduled shifts?`)) return;
    const endDate = new Date().toISOString().slice(0, 10);
    const ok = await action.run(
      () => api('POST', `/api/v1/workforce/employees/${id}/terminate`, { endDate }),
      `${number} terminated`,
    );
    if (ok) {
      employees.reload();
      shifts.reload();
    }
  }

  async function addShift() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/workforce/shifts', {
          employeeId: shiftEmployee,
          startsAt: shiftStart,
          endsAt: shiftEnd,
          shiftRole: shiftRole || undefined,
        }),
      'Shift scheduled',
    );
    if (ok) {
      setShiftEmployee('');
      setShiftRole('');
      setShiftStart('');
      setShiftEnd('');
      shifts.reload();
    }
  }

  async function addEmployee() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/workforce/employees', {
          fullName,
          jobTitle,
          department,
          hireDate,
          baseSalary: Number(salary),
        }),
      'Employee added',
    );
    if (ok) {
      setFullName('');
      setJobTitle('');
      setSalary('');
      employees.reload();
    }
  }

  async function createRun() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/workforce/payroll-runs', {
          periodStart,
          periodEnd,
        }),
      'Payroll calculated',
    );
    if (ok) runs.reload();
  }

  async function postRun(id: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/workforce/payroll-runs/${id}/post`, {}),
      'Payroll posted to the ledger',
    );
    if (ok) runs.reload();
  }

  async function payRun(id: string) {
    const ok = await action.run(
      () => api('POST', `/api/v1/workforce/payroll-runs/${id}/payment`, {}),
      'Net pay settled from the bank',
    );
    if (ok) runs.reload();
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error ?? shifts.error} notice={action.notice} />

      <Card
        title="Add employee"
        subtitle="Salaries are monthly. PAYE and pension are calculated at payroll, not stored on the employee."
      >
        <FormRow>
          <Field label="Full name">
            <Input value={fullName} onChange={setFullName} placeholder="Ada Okafor" />
          </Field>
          <Field label="Job title">
            <Input value={jobTitle} onChange={setJobTitle} placeholder="Front Office Manager" />
          </Field>
          <Field label="Department">
            <Input value={department} onChange={setDepartment} />
          </Field>
          <Field label="Hire date">
            <Input value={hireDate} onChange={setHireDate} type="date" />
          </Field>
          <Field label="Monthly salary">
            <Input value={salary} onChange={setSalary} type="number" min="0" />
          </Field>
          <Button
            onClick={addEmployee}
            disabled={action.busy || !fullName || !jobTitle || !salary}
          >
            Add employee
          </Button>
        </FormRow>
      </Card>

      <Card title="Employees" subtitle={`${employees.data?.employees.length ?? 0} on the register`}>
        <Table
          rows={employees.data?.employees}
          loading={employees.loading}
          columns={[
            { key: 'employee_number', header: 'Number' },
            { key: 'full_name', header: 'Name' },
            { key: 'job_title', header: 'Job title' },
            { key: 'department', header: 'Department' },
            { key: 'hire_date', header: 'Hired', render: (row) => formatDate(row.hire_date) },
            {
              key: 'base_salary',
              header: 'Monthly',
              align: 'right',
              render: (row) => formatMoney(row.base_salary),
            },
            {
              key: 'monthly_paye',
              header: 'PAYE / month',
              align: 'right',
              render: (row) => formatMoney(row.monthly_paye),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: 'terminate',
              header: '',
              align: 'right',
              render: (row) =>
                row.status === 'active' ? (
                  <Button size="sm" variant="ghost" onClick={() => terminateEmployee(row.id, row.employee_number)} disabled={action.busy}>
                    Terminate
                  </Button>
                ) : (
                  <Badge tone="neutral">{row.status}</Badge>
                ),
            },
          ]}
          empty="No employees yet."
        />
      </Card>      <Card
        title="Scheduled shifts"
        subtitle={`Table times are shown in ${timeZone}. Overlapping shifts for the same employee are rejected.`}
      >
        <FormRow>
          <Field label="From">
            <Input value={shiftFrom} onChange={setShiftFrom} type="date" />
          </Field>
          <Field label="To">
            <Input value={shiftTo} onChange={setShiftTo} type="date" />
          </Field>
          <Button
            onClick={resetShiftRange}
            disabled={action.busy}
          >
            Reset range
          </Button>
        </FormRow>

        <FormRow>
          <Field label="Employee">
            <select
              value={shiftEmployee}
              onChange={(e) => setShiftEmployee(e.target.value)}
              style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
            >
              <option value="">Select employee</option>
              {employees.data?.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.employee_number} — {e.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Role">
            <Input value={shiftRole} onChange={setShiftRole} placeholder="Front desk" />
          </Field>
          <Field label="Start">
            <Input value={shiftStart} onChange={setShiftStart} type="datetime-local" />
          </Field>
          <Field label="End">
            <Input value={shiftEnd} onChange={setShiftEnd} type="datetime-local" />
          </Field>
          <Button
            onClick={addShift}
            disabled={action.busy || !shiftEmployee || !shiftStart || !shiftEnd}
          >
            Schedule shift
          </Button>
        </FormRow>

        <Table
          rows={shifts.data?.shifts.filter((s) => s.status !== 'cancelled') ?? []}
          loading={shifts.loading}
          columns={[
            { key: 'full_name', header: 'Employee' },
            { key: 'shift_role', header: 'Role', render: (row) => row.shift_role ?? '—' },
            { key: 'starts_at', header: 'Start', render: (row) => formatDateTime(row.starts_at, timeZone) },
            { key: 'ends_at', header: 'End', render: (row) => formatDateTime(row.ends_at, timeZone) },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge> },
            { key: 'notes', header: 'Notes', render: (row) => row.notes ?? '—' },
          ]}
          empty="No shifts in range."
        />
      </Card>

      <Card
        title="Payroll"
        subtitle="A run posts once: Dr payroll expense, Cr statutory deductions and net pay payable."
      >
        <FormRow>
          <Field label="Period start">
            <Input value={periodStart} onChange={setPeriodStart} type="date" />
          </Field>
          <Field label="Period end">
            <Input value={periodEnd} onChange={setPeriodEnd} type="date" />
          </Field>
          <Button onClick={createRun} disabled={action.busy || !periodStart || !periodEnd}>
            Calculate payroll
          </Button>
        </FormRow>

        <Table
          rows={runs.data?.runs}
          loading={runs.loading}
          columns={[
            { key: 'run_number', header: 'Run' },
            {
              key: 'period',
              header: 'Period',
              render: (row) => `${formatDate(row.period_start)} – ${formatDate(row.period_end)}`,
            },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge> },
            {
              key: 'gross_total',
              header: 'Gross',
              align: 'right',
              render: (row) => formatMoney(row.gross_total),
            },
            {
              key: 'paye_total',
              header: 'PAYE',
              align: 'right',
              render: (row) => formatMoney(row.paye_total),
            },
            {
              key: 'pension_total',
              header: 'Pension',
              align: 'right',
              render: (row) => formatMoney(row.pension_total),
            },
            {
              key: 'net_total',
              header: 'Net',
              align: 'right',
              render: (row) => formatMoney(row.net_total),
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
                ) : row.status === 'posted' ? (
                  <Button size="sm" variant="ghost" onClick={() => payRun(row.id)} disabled={action.busy}>
                    Pay net
                  </Button>
                ) : (
                  <Badge tone="ok">settled</Badge>
                ),
            },
          ]}
          empty="No payroll runs yet."
        />
      </Card>

      <Card title="Recent attendance" subtitle="Clock-in and clock-out records from any device">
        <Table
          rows={attendance.data?.attendance}
          loading={attendance.loading}
          columns={[
            { key: 'employee_number', header: 'Employee' },
            { key: 'full_name', header: 'Name' },
            { key: 'clock_in', header: 'In', render: (row) => formatDate(row.clock_in) },
            { key: 'clock_out', header: 'Out', render: (row) => (row.clock_out ? formatDate(row.clock_out) : '—') },
            { key: 'hours', header: 'Hours', align: 'right' },
            { key: 'source', header: 'Source' },
          ]}
          empty="No attendance recorded yet."
        />
      </Card>
    </div>
  );
}
