import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction } from '../audit.js';
import { GL, money, postJournal } from './finance.js';

/**
 * Nigerian PAYE, annualised.
 *
 * Consolidated relief allowance is the higher of NGN 200,000 or 1% of gross,
 * plus 20% of gross. Employee pension (8%) is deducted before tax. The bands
 * below are the statutory progressive rates.
 *
 * This is deliberately a pure function: payroll totals must be reproducible and
 * testable without a database.
 */
export function annualPaye(annualGross: number): number {
  if (annualGross <= 0) return 0;
  const cra = Math.max(200_000, annualGross * 0.01) + annualGross * 0.2;
  const pension = annualGross * 0.08;
  let taxable = Math.max(0, annualGross - cra - pension);
  const bands: Array<[number, number]> = [
    [300_000, 0.07],
    [300_000, 0.11],
    [500_000, 0.15],
    [500_000, 0.19],
    [1_600_000, 0.21],
    [Number.POSITIVE_INFINITY, 0.24],
  ];
  let tax = 0;
  for (const [width, rate] of bands) {
    if (taxable <= 0) break;
    const slice = Math.min(taxable, width);
    tax += slice * rate;
    taxable -= slice;
  }
  return tax;
}

export interface PayrollLine {
  gross: number;
  paye: number;
  pensionEmployee: number;
  pensionEmployer: number;
  net: number;
}

export function payrollFor(gross: number): PayrollLine {
  const monthlyGross = money(gross);
  const paye = money(Math.round((annualPaye(monthlyGross * 12) / 12) * 100) / 100);
  const pensionEmployee = money(monthlyGross * 0.08);
  const pensionEmployer = money(monthlyGross * 0.1);
  const net = money(monthlyGross - paye - pensionEmployee);
  if (net < 0) throw badRequest('Deductions exceed gross pay for this employee');
  return { gross: monthlyGross, paye, pensionEmployee, pensionEmployer, net };
}

const NUMERIC = (value: unknown): number => Number(value as string);

export async function listEmployees(db: Queryable) {
  const { rows } = await db.query(
    `SELECT e.id, e.employee_number, e.full_name, e.email, e.phone, e.job_title, e.department,
            e.employment_type, e.hire_date, e.end_date, e.base_salary, e.status, b.branch_name
       FROM workforce.employees e
       JOIN platform.branches b ON b.id = e.branch_id
      ORDER BY e.status, e.full_name`,
  );
  return rows.map((r) => ({
    ...r,
    base_salary: NUMERIC(r.base_salary),
    monthly_paye: payrollFor(NUMERIC(r.base_salary)).paye,
  }));
}

export async function createEmployee(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    employeeNumber?: string;
    fullName: string;
    email?: string;
    phone?: string;
    jobTitle: string;
    department: string;
    employmentType?: 'full_time' | 'part_time' | 'contract' | 'casual';
    hireDate: string;
    baseSalary: number;
  },
) {
  const branchId = input.branchId ?? (await defaultBranch(db));
  const number =
    input.employeeNumber ??
    (
      await db.query<{ number: string }>(
        "SELECT app_next_document_number($1, 'employee', 'EMP-') AS number",
        [ctx.tenantId],
      )
    ).rows[0]!.number;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workforce.employees
       (tenant_id, branch_id, employee_number, full_name, email, phone, job_title, department,
        employment_type, hire_date, base_salary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      ctx.tenantId,
      branchId,
      number,
      input.fullName,
      input.email ?? null,
      input.phone ?? null,
      input.jobTitle,
      input.department,
      input.employmentType ?? 'full_time',
      input.hireDate,
      money(input.baseSalary),
    ],
  );
  await auditAction(db, ctx, 'workforce.employee_created', 'employee', rows[0]!.id, {
    after: { employeeNumber: number, fullName: input.fullName },
  });
  return { id: rows[0]!.id, employeeNumber: number };
}

export async function updateEmployee(
  db: Queryable,
  ctx: AuthContext,
  employeeId: string,
  input: Partial<{
    fullName: string;
    email: string | null;
    phone: string | null;
    jobTitle: string;
    department: string;
    employmentType: 'full_time' | 'part_time' | 'contract' | 'casual';
    baseSalary: number;
  }>,
) {
  const employee = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM workforce.employees WHERE id = $1',
    [employeeId],
  );
  if (!employee.rows[0]) throw notFound('Employee not found');
  if (employee.rows[0].status === 'terminated') {
    throw conflict('EMPLOYEE_TERMINATED', 'A terminated employee cannot be amended');
  }
  const { rows } = await db.query(
    `UPDATE workforce.employees SET
       full_name = COALESCE($2, full_name),
       email = CASE WHEN $3::boolean THEN $4 ELSE email END,
       phone = CASE WHEN $5::boolean THEN $6 ELSE phone END,
       job_title = COALESCE($7, job_title),
       department = COALESCE($8, department),
       employment_type = COALESCE($9, employment_type),
       base_salary = COALESCE($10, base_salary),
       updated_at = now()
     WHERE id = $1
     RETURNING id, employee_number, full_name, base_salary, status`,
    [
      employeeId,
      input.fullName ?? null,
      input.email !== undefined,
      input.email ?? null,
      input.phone !== undefined,
      input.phone ?? null,
      input.jobTitle ?? null,
      input.department ?? null,
      input.employmentType ?? null,
      input.baseSalary === undefined ? null : money(input.baseSalary),
    ],
  );
  await auditAction(db, ctx, 'workforce.employee_updated', 'employee', employeeId, {
    after: { fields: Object.keys(input) },
  });
  return { ...rows[0]!, base_salary: NUMERIC((rows[0] as { base_salary: unknown }).base_salary) };
}

export async function terminateEmployee(
  db: Queryable,
  ctx: AuthContext,
  employeeId: string,
  input: { endDate: string; reason?: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE workforce.employees
        SET status = 'terminated', end_date = $2, updated_at = now()
      WHERE id = $1 AND status <> 'terminated'
      RETURNING id`,
    [employeeId, input.endDate],
  );
  if (!rows[0]) throw notFound('Active employee not found');
  await db.query(
    "UPDATE workforce.shifts SET status = 'cancelled' WHERE employee_id = $1 AND starts_at >= $2 AND status = 'scheduled'",
    [employeeId, input.endDate],
  );
  await auditAction(db, ctx, 'workforce.employee_terminated', 'employee', employeeId, {
    after: { endDate: input.endDate, reason: input.reason ?? null },
  });
  return { id: employeeId, status: 'terminated' };
}

export async function listShifts(db: Queryable, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT s.id, s.starts_at, s.ends_at, s.shift_role, s.status, s.notes,
            e.id AS employee_id, e.full_name, e.job_title, b.branch_name
       FROM workforce.shifts s
       JOIN workforce.employees e ON e.id = s.employee_id
       JOIN platform.branches b ON b.id = s.branch_id
      WHERE s.starts_at < $2::timestamptz AND s.ends_at > $1::timestamptz
      ORDER BY s.starts_at`,
    [from, to],
  );
  return rows;
}

export async function createShift(
  db: Queryable,
  ctx: AuthContext,
  input: {
    employeeId: string;
    startsAt: string;
    endsAt: string;
    shiftRole?: string;
    notes?: string;
  },
) {
  const employee = await db.query<{ branch_id: string; status: string }>(
    'SELECT branch_id, status FROM workforce.employees WHERE id = $1',
    [input.employeeId],
  );
  if (!employee.rows[0]) throw notFound('Employee not found');
  if (employee.rows[0].status !== 'active') {
    throw conflict('EMPLOYEE_INACTIVE', 'Only active employees can be rostered');
  }
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO workforce.shifts
         (tenant_id, branch_id, employee_id, shift_role, starts_at, ends_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        ctx.tenantId,
        employee.rows[0].branch_id,
        input.employeeId,
        input.shiftRole ?? null,
        input.startsAt,
        input.endsAt,
        input.notes ?? null,
      ],
    );
    await auditAction(db, ctx, 'workforce.shift_created', 'shift', rows[0]!.id, {
      after: { employeeId: input.employeeId, startsAt: input.startsAt },
    });
    return { id: rows[0]!.id };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23P01') {
      throw conflict('SHIFT_OVERLAP', 'This employee already has a shift in that period');
    }
    throw err;
  }
}

export async function listAttendance(db: Queryable, employeeId?: string) {
  const { rows } = await db.query(
    `SELECT a.id, a.clock_in, a.clock_out, a.source, a.notes, e.full_name, e.employee_number,
            EXTRACT(EPOCH FROM (COALESCE(a.clock_out, now()) - a.clock_in)) / 3600 AS hours
       FROM workforce.attendance a
       JOIN workforce.employees e ON e.id = a.employee_id
      WHERE ($1::uuid IS NULL OR a.employee_id = $1)
      ORDER BY a.clock_in DESC LIMIT 200`,
    [employeeId ?? null],
  );
  return rows.map((r) => ({ ...r, hours: Math.round(NUMERIC(r.hours) * 100) / 100 }));
}

export async function recordAttendance(
  db: Queryable,
  ctx: AuthContext,
  input: {
    employeeId: string;
    clockIn: string;
    clockOut?: string;
    shiftId?: string;
    source?: 'manual' | 'mobile' | 'biometric';
    notes?: string;
  },
) {
  const employee = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM workforce.employees WHERE id = $1',
    [input.employeeId],
  );
  if (!employee.rows[0]) throw notFound('Employee not found');
  if (employee.rows[0].status !== 'active') {
    throw conflict('EMPLOYEE_INACTIVE', 'Attendance can only be recorded for active employees');
  }
  if (input.clockOut && new Date(input.clockOut) <= new Date(input.clockIn)) {
    throw badRequest('clockOut must be after clockIn');
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workforce.attendance
       (tenant_id, employee_id, shift_id, clock_in, clock_out, source, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      ctx.tenantId,
      input.employeeId,
      input.shiftId ?? null,
      input.clockIn,
      input.clockOut ?? null,
      input.source ?? 'manual',
      input.notes ?? null,
    ],
  );
  if (input.shiftId && input.clockOut) {
    await db.query("UPDATE workforce.shifts SET status = 'completed' WHERE id = $1", [
      input.shiftId,
    ]);
  }
  await auditAction(db, ctx, 'workforce.attendance_recorded', 'attendance', rows[0]!.id, {
    after: { employeeId: input.employeeId, clockIn: input.clockIn },
  });
  return { id: rows[0]!.id };
}

/** A payroll run covers exactly one calendar month, matching the monthly salary basis. */
function assertSingleMonth(periodStart: string, periodEnd: string): void {
  const start = new Date(`${periodStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw badRequest('periodStart must be a date');
  if (start.getUTCDate() !== 1) throw badRequest('periodStart must be the first day of a month');
  const expectedEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  if (periodEnd !== expectedEnd) {
    throw badRequest(`A payroll run covers one month; periodEnd must be ${expectedEnd}`);
  }
}

export async function createPayrollRun(
  db: Queryable,
  ctx: AuthContext,
  input: { periodStart: string; periodEnd: string; branchId?: string },
) {
  assertSingleMonth(input.periodStart, input.periodEnd);

  const employees = await db.query<{ id: string; base_salary: string }>(
    `SELECT id, base_salary FROM workforce.employees
      WHERE status = 'active'
        AND hire_date <= $1
        AND (end_date IS NULL OR end_date >= $2)
        AND ($3::uuid IS NULL OR branch_id = $3)
      ORDER BY employee_number`,
    [input.periodEnd, input.periodStart, input.branchId ?? null],
  );
  if (employees.rows.length === 0) {
    throw conflict('NO_EMPLOYEES', 'No active employees are payable for this period');
  }

  const runNumber = (
    await db.query<{ number: string }>(
      "SELECT app_next_document_number($1, 'payroll', 'PR-') AS number",
      [ctx.tenantId],
    )
  ).rows[0]!.number;

  let run: { rows: Array<{ id: string }> };
  try {
    run = await db.query<{ id: string }>(
      `INSERT INTO workforce.payroll_runs
         (tenant_id, branch_id, run_number, period_start, period_end, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.tenantId, input.branchId ?? null, runNumber, input.periodStart, input.periodEnd, ctx.userId],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw conflict(
        'PAYROLL_PERIOD_EXISTS',
        'A payroll run already exists for that branch and period',
      );
    }
    throw err;
  }
  const runId = run.rows[0]!.id;

  let gross = 0;
  let paye = 0;
  let pension = 0;
  let net = 0;
  for (const employee of employees.rows) {
    const line = payrollFor(NUMERIC(employee.base_salary));
    gross += line.gross;
    paye += line.paye;
    pension += line.pensionEmployee + line.pensionEmployer;
    net += line.net;
    await db.query(
      `INSERT INTO workforce.payslips
         (tenant_id, run_id, employee_id, gross, paye, pension_employee, pension_employer, net)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ctx.tenantId,
        runId,
        employee.id,
        line.gross,
        line.paye,
        line.pensionEmployee,
        line.pensionEmployer,
        line.net,
      ],
    );
  }

  await db.query(
    `UPDATE workforce.payroll_runs
        SET gross_total = $2, paye_total = $3, pension_total = $4, net_total = $5
      WHERE id = $1`,
    [runId, money(gross), money(paye), money(pension), money(net)],
  );

  await auditAction(db, ctx, 'workforce.payroll_created', 'payroll_run', runId, {
    after: { runNumber, periodStart: input.periodStart, periodEnd: input.periodEnd },
  });
  return { id: runId, runNumber, gross, paye, pension, net, employees: employees.rows.length };
}

export async function listPayrollRuns(db: Queryable) {
  const { rows } = await db.query(
    `SELECT id, run_number, period_start, period_end, status, gross_total, paye_total,
            pension_total, net_total, journal_entry_id, payment_journal_id, created_at, posted_at, paid_at
       FROM workforce.payroll_runs ORDER BY period_start DESC, created_at DESC`,
  );
  return rows.map((r) => ({
    ...r,
    gross_total: NUMERIC(r.gross_total),
    paye_total: NUMERIC(r.paye_total),
    pension_total: NUMERIC(r.pension_total),
    net_total: NUMERIC(r.net_total),
  }));
}

export async function getPayrollRun(db: Queryable, runId: string) {
  const run = await db.query(
    `SELECT id, run_number, period_start, period_end, status, gross_total, paye_total,
            pension_total, net_total, journal_entry_id, payment_journal_id, posted_at, paid_at
       FROM workforce.payroll_runs WHERE id = $1`,
    [runId],
  );
  if (!run.rows[0]) throw notFound('Payroll run not found');
  const payslips = await db.query(
    `SELECT p.id, e.employee_number, e.full_name, e.job_title, e.department,
            p.gross, p.paye, p.pension_employee, p.pension_employer, p.net
       FROM workforce.payslips p
       JOIN workforce.employees e ON e.id = p.employee_id
      WHERE p.run_id = $1 ORDER BY e.full_name`,
    [runId],
  );
  const numeric = (value: unknown) => NUMERIC(value);
  return {
    run: Object.fromEntries(
      Object.entries(run.rows[0]).map(([key, value]) =>
        ['gross_total', 'paye_total', 'pension_total', 'net_total'].includes(key)
          ? [key, numeric(value)]
          : [key, value],
      ),
    ),
    payslips: payslips.rows.map((r) => ({
      ...r,
      gross: numeric(r.gross),
      paye: numeric(r.paye),
      pension_employee: numeric(r.pension_employee),
      pension_employer: numeric(r.pension_employer),
      net: numeric(r.net),
    })),
  };
}

/**
 * Posts the payroll accrual exactly once:
 *   Dr Payroll Expense (gross + employer pension)
 *   Cr PAYE and Pension Payable (PAYE + employee + employer pension)
 *   Cr Salaries Payable (net)
 */
export async function postPayrollRun(db: Queryable, ctx: AuthContext, runId: string) {
  const { rows } = await db.query<{
    id: string;
    run_number: string;
    status: string;
    period_end: string;
    gross_total: string;
    paye_total: string;
    pension_total: string;
    net_total: string;
    branch_id: string | null;
  }>(
    `SELECT id, run_number, status, period_end, gross_total, paye_total, pension_total,
            net_total, branch_id
       FROM workforce.payroll_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  const run = rows[0];
  if (!run) throw notFound('Payroll run not found');
  if (run.status !== 'draft') throw conflict('PAYROLL_ALREADY_POSTED', 'This payroll run is already posted');

  const gross = NUMERIC(run.gross_total);
  const paye = NUMERIC(run.paye_total);
  const pension = NUMERIC(run.pension_total);
  const net = NUMERIC(run.net_total);
  // Employer pension sits inside pension_total but not inside net, so the
  // expense side needs gross + employer share. Derive it from the payslips.
  const employer = await db.query<{ total: string }>(
    'SELECT COALESCE(sum(pension_employer), 0) AS total FROM workforce.payslips WHERE run_id = $1',
    [runId],
  );
  const employerPension = NUMERIC(employer.rows[0]!.total);

  const journalEntryId = await postJournal(db, {
    tenantId: ctx.tenantId,
    branchId: run.branch_id,
    entryDate: run.period_end,
    description: `Payroll ${run.run_number}`,
    sourceType: 'payroll_run',
    sourceId: runId,
    purpose: 'accrual',
    postedBy: ctx.userId,
    lines: [
      { accountCode: GL.payrollExpense, debit: money(gross + employerPension), description: 'Gross pay and employer pension' },
      { accountCode: GL.statutoryPayable, credit: money(paye + pension), description: 'PAYE and pension withheld' },
      { accountCode: GL.salariesPayable, credit: net, description: 'Net pay payable' },
    ],
  });

  await db.query(
    "UPDATE workforce.payroll_runs SET status = 'posted', journal_entry_id = $2, posted_at = now() WHERE id = $1",
    [runId, journalEntryId],
  );
  await auditAction(db, ctx, 'workforce.payroll_posted', 'payroll_run', runId, {
    after: { journalEntryId, gross, net },
  });
  return { id: runId, status: 'posted', journalEntryId };
}

/** Settles net pay from the bank: Dr Salaries Payable, Cr Bank. */
export async function payPayrollRun(db: Queryable, ctx: AuthContext, runId: string) {
  const { rows } = await db.query<{
    status: string;
    net_total: string;
    run_number: string;
    period_end: string;
    branch_id: string | null;
  }>(
    'SELECT status, net_total, run_number, period_end, branch_id FROM workforce.payroll_runs WHERE id = $1 FOR UPDATE',
    [runId],
  );
  const run = rows[0];
  if (!run) throw notFound('Payroll run not found');
  if (run.status === 'draft') throw conflict('PAYROLL_NOT_POSTED', 'Post the payroll run before paying it');
  if (run.status === 'paid') throw conflict('PAYROLL_ALREADY_PAID', 'This payroll run is already paid');

  const net = NUMERIC(run.net_total);
  if (net <= 0) throw conflict('NOTHING_TO_PAY', 'This payroll run has no net pay');

  const journalEntryId = await postJournal(db, {
    tenantId: ctx.tenantId,
    branchId: run.branch_id,
    entryDate: run.period_end,
    description: `Payroll payment ${run.run_number}`,
    sourceType: 'payroll_run',
    sourceId: runId,
    purpose: 'payment',
    postedBy: ctx.userId,
    lines: [
      { accountCode: GL.salariesPayable, debit: net, description: 'Net pay settled' },
      { accountCode: GL.bank, credit: net, description: 'Bank transfer' },
    ],
  });

  await db.query(
    "UPDATE workforce.payroll_runs SET status = 'paid', payment_journal_id = $2, paid_at = now() WHERE id = $1",
    [runId, journalEntryId],
  );
  await auditAction(db, ctx, 'workforce.payroll_paid', 'payroll_run', runId, {
    after: { journalEntryId, net },
  });
  return { id: runId, status: 'paid', journalEntryId };
}

async function defaultBranch(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM platform.branches WHERE status = 'active' ORDER BY created_at LIMIT 1",
  );
  if (!rows[0]) throw conflict('NO_BRANCH', 'Create a branch before adding employees');
  return rows[0].id;
}

export { NUMERIC as toNumber };
