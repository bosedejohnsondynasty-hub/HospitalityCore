import type { AuthContext } from '../auth.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction, emitEvent } from '../audit.js';
import { money, postJournal } from './finance.js';

const NUMERIC = (value: unknown): number => Number(value as string);

async function nextCode(db: Queryable, ctx: AuthContext, key: string, prefix: string): Promise<string> {
  const { rows } = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, $2, $3) AS number",
    [ctx.tenantId, key, prefix],
  );
  return rows[0]!.number;
}

function positive(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw badRequest(`${field} must be zero or greater`);
}

function amount(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw badRequest(`${field} must be greater than zero`);
  return money(value);
}

async function transition(
  db: Queryable,
  table: string,
  id: string,
  from: string[],
  to: string,
  action: string,
  errorCode: string,
): Promise<void> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM ${table} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound('Record not found');
  if (!from.includes(row.status)) throw conflict(errorCode, `${action} is not allowed from ${row.status}`);
  await db.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [id, to]);
}

// ---------------------------------------------------------------------------
// Budget and cost control
// ---------------------------------------------------------------------------

export async function listBudgets(db: Queryable) {
  const { rows } = await db.query(
    `SELECT b.id, b.branch_id, br.branch_name, b.fiscal_year, b.budget_code, b.budget_name,
            b.status, b.total_amount, b.created_at, b.approved_at, b.locked_at,
            COUNT(l.id)::int AS line_count
       FROM backoffice.budgets b
       LEFT JOIN platform.branches br ON br.id = b.branch_id
       LEFT JOIN backoffice.budget_lines l ON l.budget_id = b.id
      GROUP BY b.id, br.branch_name
      ORDER BY b.fiscal_year DESC, b.created_at DESC`,
  );
  return rows.map((r) => ({ ...r, total_amount: NUMERIC(r.total_amount) }));
}

export async function createBudget(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    fiscalYear: number;
    budgetCode?: string;
    name: string;
    lines?: Array<{ accountId: string; category: string; costCentre?: string; amount: number }>;
  },
) {
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 2000 || input.fiscalYear > 2100) {
    throw badRequest('fiscalYear must be a four-digit year');
  }
  const branchId = input.branchId ?? null;
  const code = input.budgetCode ?? (await nextCode(db, ctx, 'budget', 'BUD-'));
  const total = money((input.lines ?? []).reduce((sum, line) => sum + amount(line.amount, 'amount'), 0));
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO backoffice.budgets
         (tenant_id, branch_id, fiscal_year, budget_code, budget_name, status, total_amount, created_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7) RETURNING id`,
      [ctx.tenantId, branchId, input.fiscalYear, code, input.name, total, ctx.userId],
    );
    const budgetId = rows[0]!.id;
    for (const line of input.lines ?? []) {
      await db.query(
        `INSERT INTO backoffice.budget_lines
           (tenant_id, budget_id, account_id, category, cost_centre, amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.tenantId, budgetId, line.accountId, line.category, line.costCentre ?? null, amount(line.amount, 'amount')],
      );
    }
    await auditAction(db, ctx, 'backoffice.budget_created', 'budget', budgetId, {
      after: { code, fiscalYear: input.fiscalYear, total },
    });
    return { id: budgetId, budgetCode: code, total };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw conflict('BUDGET_CODE_EXISTS', `Budget code ${code} already exists for this branch and year`);
    }
    throw err;
  }
}

export async function addBudgetLine(
  db: Queryable,
  ctx: AuthContext,
  budgetId: string,
  input: { accountId: string; category: string; costCentre?: string; amount: number },
) {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM backoffice.budgets WHERE id = $1 FOR UPDATE',
    [budgetId],
  );
  if (!rows[0]) throw notFound('Budget not found');
  if (rows[0].status !== 'draft') throw conflict('BUDGET_NOT_EDITABLE', 'Budget lines can only change while the budget is in draft');
  const value = amount(input.amount, 'amount');
  await db.query(
    `INSERT INTO backoffice.budget_lines
       (tenant_id, budget_id, account_id, category, cost_centre, amount)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, budgetId, input.accountId, input.category, input.costCentre ?? null, value],
  );
  await db.query(
    'UPDATE backoffice.budgets SET total_amount = total_amount + $2, updated_at = now() WHERE id = $1',
    [budgetId, value],
  );
  await auditAction(db, ctx, 'backoffice.budget_line_added', 'budget', budgetId, {
    after: { accountId: input.accountId, amount: value },
  });
  return { budgetId, amount: value };
}

export async function approveBudget(db: Queryable, ctx: AuthContext, budgetId: string) {
  const { rows } = await db.query<{ status: string; total_amount: string }>(
    'SELECT status, total_amount FROM backoffice.budgets WHERE id = $1 FOR UPDATE',
    [budgetId],
  );
  const row = rows[0];
  if (!row) throw notFound('Budget not found');
  if (row.status !== 'draft') throw conflict('BUDGET_NOT_APPROVABLE', 'Only a draft budget can be approved');
  if (NUMERIC(row.total_amount) <= 0) throw conflict('EMPTY_BUDGET', 'A budget with no lines cannot be approved');
  await db.query(
    "UPDATE backoffice.budgets SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1",
    [budgetId, ctx.userId],
  );
  await auditAction(db, ctx, 'backoffice.budget_approved', 'budget', budgetId);
  return { id: budgetId, status: 'approved' };
}

export async function lockBudget(db: Queryable, ctx: AuthContext, budgetId: string) {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM backoffice.budgets WHERE id = $1 FOR UPDATE',
    [budgetId],
  );
  const row = rows[0];
  if (!row) throw notFound('Budget not found');
  if (row.status !== 'approved') throw conflict('BUDGET_NOT_LOCKABLE', 'Only an approved budget can be locked');
  await db.query(
    "UPDATE backoffice.budgets SET status = 'locked', locked_at = now(), updated_at = now() WHERE id = $1",
    [budgetId],
  );
  await auditAction(db, ctx, 'backoffice.budget_locked', 'budget', budgetId);
  return { id: budgetId, status: 'locked' };
}

export async function budgetVariance(db: Queryable, budgetId: string) {
  const budget = await db.query<{ id: string; fiscal_year: number; budget_code: string; budget_name: string; status: string; total_amount: string; branch_id: string | null }>(
    'SELECT id, fiscal_year, budget_code, budget_name, status, total_amount, branch_id FROM backoffice.budgets WHERE id = $1',
    [budgetId],
  );
  if (!budget.rows[0]) throw notFound('Budget not found');
  const b = budget.rows[0];
  const { rows } = await db.query(
    `SELECT bl.id, bl.category, bl.cost_centre, bl.amount AS budget_amount,
            a.account_code, a.account_name,
            COALESCE(SUM(CASE WHEN e.entry_date >= make_date($2, 1, 1) AND e.entry_date <= make_date($2, 12, 31)
                               AND ($3::uuid IS NULL OR e.branch_id = $3)
                              THEN jl.debit - jl.credit ELSE 0 END), 0) AS actual_amount
       FROM backoffice.budget_lines bl
       JOIN finance.accounts a ON a.id = bl.account_id
       LEFT JOIN finance.journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = bl.tenant_id
       LEFT JOIN finance.journal_entries e ON e.id = jl.entry_id AND e.status = 'posted'
      WHERE bl.budget_id = $1
      GROUP BY bl.id, a.account_code, a.account_name
      ORDER BY bl.category, a.account_code`,
    [budgetId, b.fiscal_year, b.branch_id],
  );
  const lines = rows.map((r) => {
    const budgetAmount = NUMERIC(r.budget_amount);
    const actual = NUMERIC(r.actual_amount);
    const variance = money(budgetAmount - actual);
    return {
      ...r,
      budget_amount: budgetAmount,
      actual_amount: actual,
      variance,
      variance_percent: budgetAmount === 0 ? 0 : Math.round((variance / budgetAmount) * 10000) / 100,
    };
  });
  const totalBudget = NUMERIC(b.total_amount);
  const totalActual = money(lines.reduce((sum, line) => sum + line.actual_amount, 0));
  return {
    budget: { ...b, total_amount: totalBudget },
    lines,
    totals: {
      budget: totalBudget,
      actual: totalActual,
      variance: money(totalBudget - totalActual),
      utilization_percent: totalBudget === 0 ? 0 : Math.round((totalActual / totalBudget) * 10000) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

export async function treasuryPositions(db: Queryable) {
  const { rows } = await db.query(
    `SELECT ba.id, ba.account_name, ba.bank_name, ba.account_number, ba.currency_code,
            ba.gl_account_id, a.account_code, a.account_name AS gl_account_name,
            COALESCE(SUM(CASE WHEN e.status = 'posted' THEN jl.debit - jl.credit ELSE 0 END), 0) AS balance
       FROM finance.bank_accounts ba
       JOIN finance.accounts a ON a.id = ba.gl_account_id
       LEFT JOIN finance.journal_lines jl ON jl.account_id = ba.gl_account_id
       LEFT JOIN finance.journal_entries e ON e.id = jl.entry_id
      WHERE ba.is_active
      GROUP BY ba.id, ba.account_name, ba.bank_name, ba.account_number, ba.currency_code, ba.gl_account_id, a.account_code, a.account_name
      ORDER BY ba.bank_name, ba.account_name`,
  );
  return rows.map((r) => ({ ...r, balance: NUMERIC(r.balance) }));
}

export async function listTreasuryTransfers(db: Queryable) {
  const { rows } = await db.query(
    `SELECT t.id, t.entry_date, t.reference, t.amount, t.status, t.reason, t.journal_entry_id,
            s.account_name AS source_account, d.account_name AS destination_account
       FROM backoffice.treasury_transfers t
       JOIN finance.bank_accounts s ON s.id = t.source_bank_account_id
       JOIN finance.bank_accounts d ON d.id = t.destination_bank_account_id
      ORDER BY t.entry_date DESC, t.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ ...r, amount: NUMERIC(r.amount) }));
}

export async function createTreasuryTransfer(
  db: Queryable,
  ctx: AuthContext,
  input: {
    sourceBankAccountId: string;
    destinationBankAccountId: string;
    amount: number;
    reference: string;
    entryDate?: string;
    reason?: string;
  },
) {
  const value = amount(input.amount, 'amount');
  const entryDate = input.entryDate ?? new Date().toISOString().slice(0, 10);
  const accounts = await db.query<{
    id: string;
    gl_account_id: string;
    branch_id: string | null;
    is_active: boolean;
  }>(
    'SELECT id, gl_account_id, branch_id, is_active FROM finance.bank_accounts WHERE id = ANY($1::uuid[])',
    [[input.sourceBankAccountId, input.destinationBankAccountId]],
  );
  const source = accounts.rows.find((r) => r.id === input.sourceBankAccountId);
  const destination = accounts.rows.find((r) => r.id === input.destinationBankAccountId);
  if (!source || !destination) throw notFound('One or both bank accounts were not found');
  if (!source.is_active || !destination.is_active) throw conflict('BANK_ACCOUNT_INACTIVE', 'Treasury transfers require two active bank accounts');

  const branchId = source.branch_id ?? destination.branch_id ?? null;
  let transferId: string;
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO backoffice.treasury_transfers
         (tenant_id, branch_id, source_bank_account_id, destination_bank_account_id, entry_date, amount, reference, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.tenantId, branchId, input.sourceBankAccountId, input.destinationBankAccountId, entryDate, value, input.reference, input.reason ?? null, ctx.userId],
    );
    transferId = rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('TREASURY_REFERENCE_EXISTS', 'Treasury reference already exists');
    throw err;
  }

  const journalEntryId = await postJournal(db, {
    tenantId: ctx.tenantId,
    branchId,
    entryDate,
    description: `Treasury transfer ${input.reference}`,
    sourceType: 'treasury_transfer',
    sourceId: transferId,
    purpose: 'transfer',
    postedBy: ctx.userId,
    lines: [
      { accountId: destination.gl_account_id, debit: value, description: 'Destination bank account' },
      { accountId: source.gl_account_id, credit: value, description: 'Source bank account' },
    ],
  });
  await db.query(
    "UPDATE backoffice.treasury_transfers SET status = 'posted', journal_entry_id = $2 WHERE id = $1",
    [transferId, journalEntryId],
  );
  await auditAction(db, ctx, 'backoffice.treasury_transfer_posted', 'treasury_transfer', transferId, {
    after: { reference: input.reference, amount: value, journalEntryId },
  });
  return { id: transferId, status: 'posted', journalEntryId };
}

// ---------------------------------------------------------------------------
// Laundry
// ---------------------------------------------------------------------------

export async function listLaundry(db: Queryable) {
  const { rows } = await db.query(
    `SELECT c.*, COALESCE(SUM(i.quantity), 0)::int AS item_count,
            COALESCE(SUM(i.returned_quantity), 0)::int AS returned_count,
            COALESCE(SUM(i.lost_quantity), 0)::int AS lost_count,
            COALESCE(SUM(i.damaged_quantity), 0)::int AS damaged_count
       FROM backoffice.laundry_cycles c
       LEFT JOIN backoffice.laundry_items i ON i.cycle_id = c.id
      GROUP BY c.id ORDER BY c.scheduled_at DESC LIMIT 200`,
  );
  return rows;
}

export async function getLaundry(db: Queryable, id: string) {
  const cycle = await db.query('SELECT * FROM backoffice.laundry_cycles WHERE id = $1', [id]);
  if (!cycle.rows[0]) throw notFound('Laundry cycle not found');
  const items = await db.query(
    'SELECT * FROM backoffice.laundry_items WHERE cycle_id = $1 ORDER BY item_name',
    [id],
  );
  return { cycle: cycle.rows[0], items: items.rows };
}

export async function createLaundry(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    hotelId?: string;
    cycleType: string;
    scheduledAt: string;
    notes?: string;
    items: Array<{
      itemName: string;
      linenCategory?: string;
      quantity: number;
      returnedQuantity?: number;
      lostQuantity?: number;
      damagedQuantity?: number;
      notes?: string;
    }>;
  },
) {
  if (!input.items.length) throw badRequest('A laundry cycle needs at least one item line');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.laundry_cycles
       (tenant_id, branch_id, hotel_id, cycle_type, scheduled_at, status, notes)
     VALUES ($1,$2,$3,$4,$5,'scheduled',$6) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, input.hotelId ?? null, input.cycleType, input.scheduledAt, input.notes ?? null],
  );
  const id = rows[0]!.id;
  for (const item of input.items) {
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Laundry quantity must be a positive integer');
    const returned = Number(item.returnedQuantity ?? 0);
    const lost = Number(item.lostQuantity ?? 0);
    const damaged = Number(item.damagedQuantity ?? 0);
    if (![returned, lost, damaged].every((n) => Number.isInteger(n) && n >= 0) || returned + lost + damaged > qty) {
      throw badRequest('Returned, lost and damaged quantities cannot exceed the received quantity');
    }
    await db.query(
      `INSERT INTO backoffice.laundry_items
         (tenant_id, cycle_id, item_name, linen_category, quantity, returned_quantity, lost_quantity, damaged_quantity, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, id, item.itemName, item.linenCategory ?? 'guest_linen', qty, returned, lost, damaged, item.notes ?? null],
    );
  }
  await auditAction(db, ctx, 'backoffice.laundry_cycle_created', 'laundry_cycle', id);
  return { id, status: 'scheduled' };
}

export async function completeLaundry(db: Queryable, ctx: AuthContext, id: string) {
  const detail = await getLaundry(db, id);
  if (detail.cycle.status === 'completed') throw conflict('LAUNDRY_ALREADY_COMPLETED', 'This laundry cycle is already completed');
  if (detail.cycle.status === 'cancelled') throw conflict('LAUNDRY_CANCELLED', 'A cancelled laundry cycle cannot be completed');
  const incomplete = detail.items.find(
    (item) => Number(item.returned_quantity) + Number(item.lost_quantity) + Number(item.damaged_quantity) !== Number(item.quantity),
  );
  if (incomplete) {
    throw conflict('LAUNDRY_UNRESOLVED', 'Every item must account for returned, lost or damaged pieces before completion');
  }
  await db.query(
    "UPDATE backoffice.laundry_cycles SET status = 'completed', started_at = COALESCE(started_at, now()), completed_at = now() WHERE id = $1",
    [id],
  );
  await auditAction(db, ctx, 'backoffice.laundry_cycle_completed', 'laundry_cycle', id);
  await emitEvent(db, ctx.tenantId, 'laundry.completed', 'laundry_cycle', id, { itemCount: detail.items.length });
  return { id, status: 'completed' };
}

export async function cancelLaundry(db: Queryable, ctx: AuthContext, id: string) {
  const detail = await getLaundry(db, id);
  if (detail.cycle.status === 'completed') throw conflict('LAUNDRY_COMPLETED', 'A completed laundry cycle cannot be cancelled');
  await db.query("UPDATE backoffice.laundry_cycles SET status = 'cancelled' WHERE id = $1", [id]);
  await auditAction(db, ctx, 'backoffice.laundry_cycle_cancelled', 'laundry_cycle', id);
  return { id, status: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Agreements, insurance, quality, utilities, security, documents, training
// ---------------------------------------------------------------------------

export async function listAgreements(db: Queryable) {
  const { rows } = await db.query(
    'SELECT * FROM backoffice.agreements ORDER BY status, end_date, agreement_name LIMIT 200',
  );
  return rows.map((r) => ({ ...r, amount: NUMERIC(r.amount) }));
}

export async function createAgreement(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    agreementCode?: string;
    agreementName: string;
    agreementType: string;
    counterparty: string;
    startDate: string;
    endDate: string;
    amount?: number;
    terms?: string;
  },
) {
  const code = input.agreementCode ?? (await nextCode(db, ctx, 'agreement', 'AGR-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.agreements
       (tenant_id, branch_id, agreement_code, agreement_name, agreement_type, counterparty, start_date, end_date, amount, terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.agreementName, input.agreementType, input.counterparty, input.startDate, input.endDate, money(input.amount ?? 0), input.terms ?? null],
  );
  await auditAction(db, ctx, 'backoffice.agreement_created', 'agreement', rows[0]!.id);
  return { id: rows[0]!.id, agreementCode: code };
}

export async function updateAgreementStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  const allowed: Record<string, string[]> = {
    draft: ['active', 'terminated'],
    active: ['suspended', 'expired', 'terminated'],
    suspended: ['active', 'terminated'],
    expired: ['terminated'],
    terminated: [],
  };
  const { rows } = await db.query<{ status: string }>('SELECT status FROM backoffice.agreements WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Agreement not found');
  if (!(allowed[rows[0].status] ?? []).includes(status)) {
    throw conflict('AGREEMENT_TRANSITION', `Agreement cannot move from ${rows[0].status} to ${status}`);
  }
  await db.query('UPDATE backoffice.agreements SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  await auditAction(db, ctx, 'backoffice.agreement_status', 'agreement', id, { after: { status } });
  return { id, status };
}

export async function listInsurancePolicies(db: Queryable) {
  const { rows } = await db.query(
    'SELECT * FROM backoffice.insurance_policies ORDER BY status, end_date DESC LIMIT 200',
  );
  return rows.map((r) => ({ ...r, premium: NUMERIC(r.premium), deductible: NUMERIC(r.deductible) }));
}

export async function createInsurancePolicy(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    insurer: string;
    policyNumber: string;
    coverageType: string;
    startDate: string;
    endDate: string;
    premium?: number;
    deductible?: number;
    coverageDetails?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.insurance_policies
       (tenant_id, branch_id, insurer, policy_number, coverage_type, start_date, end_date, premium, deductible, coverage_details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, input.insurer, input.policyNumber, input.coverageType, input.startDate, input.endDate, money(input.premium ?? 0), money(input.deductible ?? 0), input.coverageDetails ?? null],
  );
  await auditAction(db, ctx, 'backoffice.insurance_policy_created', 'insurance_policy', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function updateInsurancePolicyStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'backoffice.insurance_policies', id, ['draft', 'active'], status, 'Insurance policy status', 'POLICY_TRANSITION');
  await auditAction(db, ctx, 'backoffice.insurance_policy_status', 'insurance_policy', id, { after: { status } });
  return { id, status };
}

export async function listInsuranceClaims(db: Queryable, policyId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM backoffice.insurance_claims WHERE ($1::uuid IS NULL OR policy_id = $1) ORDER BY created_at DESC LIMIT 200',
    [policyId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    claimed_amount: NUMERIC(r.claimed_amount),
    estimated_recovery: NUMERIC(r.estimated_recovery),
    paid_amount: NUMERIC(r.paid_amount),
  }));
}

export async function createInsuranceClaim(
  db: Queryable,
  ctx: AuthContext,
  input: {
    policyId: string;
    claimNumber?: string;
    incidentDate: string;
    claimedAmount: number;
    description?: string;
  },
) {
  const number = input.claimNumber ?? (await nextCode(db, ctx, 'insurance_claim', 'CLM-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.insurance_claims
       (tenant_id, policy_id, claim_number, incident_date, claimed_amount, description)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, input.policyId, number, input.incidentDate, amount(input.claimedAmount, 'claimedAmount'), input.description ?? null],
  );
  await auditAction(db, ctx, 'backoffice.insurance_claim_created', 'insurance_claim', rows[0]!.id);
  return { id: rows[0]!.id, claimNumber: number };
}

export async function updateInsuranceClaim(
  db: Queryable,
  ctx: AuthContext,
  id: string,
  input: { status: string; estimatedRecovery?: number; paidAmount?: number },
) {
  const { rows } = await db.query<{ status: string; claimed_amount: string; estimated_recovery: string }>(
    'SELECT status, claimed_amount, estimated_recovery FROM backoffice.insurance_claims WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw notFound('Insurance claim not found');
  const current = rows[0].status;
  const progress: Record<string, string[]> = {
    open: ['in_review', 'denied', 'closed'],
    in_review: ['approved', 'denied', 'closed'],
    approved: ['paid', 'closed'],
    paid: ['closed'],
    denied: ['closed'],
    closed: [],
  };
  if (!(progress[current] ?? []).includes(input.status)) {
    throw conflict('CLAIM_TRANSITION', `Claim cannot move from ${current} to ${input.status}`);
  }
  const claimed = NUMERIC(rows[0].claimed_amount);
  const recovery = input.estimatedRecovery === undefined ? NUMERIC(rows[0].estimated_recovery) : money(input.estimatedRecovery);
  const paid = input.paidAmount === undefined ? 0 : money(input.paidAmount);
  if (recovery > claimed || paid > claimed || recovery < 0 || paid < 0) {
    throw badRequest('Recovery and paid amounts cannot exceed the claimed amount');
  }
  if (input.status === 'paid' && paid <= 0) throw badRequest('paidAmount is required to mark a claim paid');
  await db.query(
    `UPDATE backoffice.insurance_claims
        SET status = $2, estimated_recovery = $3, paid_amount = $4, decided_at = CASE WHEN $2 IN ('approved', 'denied', 'paid') THEN now() ELSE decided_at END
      WHERE id = $1`,
    [id, input.status, recovery, paid],
  );
  await auditAction(db, ctx, 'backoffice.insurance_claim_updated', 'insurance_claim', id, {
    after: input,
  });
  return { id, status: input.status };
}

export async function listQualityInspections(db: Queryable) {
  const { rows } = await db.query(
    `SELECT q.*, COUNT(a.id)::int AS action_count,
            COUNT(a.id) FILTER (WHERE a.status IN ('open','in_progress'))::int AS open_actions
       FROM backoffice.quality_inspections q
       LEFT JOIN backoffice.quality_actions a ON a.inspection_id = q.id
      GROUP BY q.id ORDER BY q.scheduled_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ ...r, score: r.score === null ? null : NUMERIC(r.score) }));
}

export async function createQualityInspection(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; areaName: string; standardName: string; scheduledAt: string; notes?: string },
) {
  const code = await nextCode(db, ctx, 'quality_inspection', 'QA-');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.quality_inspections
       (tenant_id, branch_id, inspection_code, area_name, standard_name, scheduled_at, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.areaName, input.standardName, input.scheduledAt, input.notes ?? null],
  );
  await auditAction(db, ctx, 'backoffice.quality_inspection_created', 'quality_inspection', rows[0]!.id);
  return { id: rows[0]!.id, inspectionCode: code };
}

export async function completeQualityInspection(
  db: Queryable,
  ctx: AuthContext,
  id: string,
  input: { score: number; result: 'pass' | 'fail' | 'follow_up'; notes?: string },
) {
  if (!(input.score >= 0 && input.score <= 100)) throw badRequest('score must be between 0 and 100');
  const { rows } = await db.query<{ status: string }>('SELECT status FROM backoffice.quality_inspections WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Quality inspection not found');
  if (rows[0].status === 'completed') throw conflict('INSPECTION_COMPLETED', 'This inspection is already completed');
  await db.query(
    "UPDATE backoffice.quality_inspections SET status = 'completed', score = $2, result = $3, completed_at = now(), notes = COALESCE($4, notes) WHERE id = $1",
    [id, input.score, input.result, input.notes ?? null],
  );
  await auditAction(db, ctx, 'backoffice.quality_inspection_completed', 'quality_inspection', id, {
    after: input,
  });
  return { id, status: 'completed' };
}

export async function listQualityActions(db: Queryable, inspectionId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM backoffice.quality_actions WHERE ($1::uuid IS NULL OR inspection_id = $1) ORDER BY due_date, created_at LIMIT 200',
    [inspectionId ?? null],
  );
  return rows.map((r) => ({ ...r, estimated_cost: NUMERIC(r.estimated_cost) }));
}

export async function createQualityAction(
  db: Queryable,
  ctx: AuthContext,
  input: { inspectionId: string; actionText: string; ownerName?: string; dueDate?: string; estimatedCost?: number },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.quality_actions
       (tenant_id, inspection_id, action_text, owner_name, due_date, estimated_cost)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, input.inspectionId, input.actionText, input.ownerName ?? null, input.dueDate ?? null, money(input.estimatedCost ?? 0)],
  );
  await auditAction(db, ctx, 'backoffice.quality_action_created', 'quality_action', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function updateQualityAction(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'backoffice.quality_actions', id, ['open', 'in_progress'], status, 'Quality action', 'QUALITY_ACTION_TRANSITION');
  if (status === 'completed') {
    await db.query('UPDATE backoffice.quality_actions SET completed_at = now() WHERE id = $1', [id]);
  }
  await auditAction(db, ctx, 'backoffice.quality_action_status', 'quality_action', id, { after: { status } });
  return { id, status };
}

export async function listUtilityMeters(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM backoffice.utility_meters ORDER BY meter_code');
  return rows;
}

export async function createUtilityMeter(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; meterCode?: string; meterName: string; utilityType: string; location?: string; unit?: string },
) {
  const code = input.meterCode ?? (await nextCode(db, ctx, 'utility_meter', 'UT-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.utility_meters
       (tenant_id, branch_id, meter_code, meter_name, utility_type, location, unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.meterName, input.utilityType, input.location ?? null, input.unit ?? 'kWh'],
  );
  await auditAction(db, ctx, 'backoffice.utility_meter_created', 'utility_meter', rows[0]!.id);
  return { id: rows[0]!.id, meterCode: code };
}

export async function listUtilityReadings(db: Queryable, meterId?: string) {
  const { rows } = await db.query(
    `SELECT r.*, m.meter_code, m.meter_name, m.utility_type, m.unit
       FROM backoffice.utility_readings r
       JOIN backoffice.utility_meters m ON m.id = r.meter_id
      WHERE ($1::uuid IS NULL OR r.meter_id = $1)
      ORDER BY r.reading_date DESC LIMIT 200`,
    [meterId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    opening_reading: NUMERIC(r.opening_reading),
    closing_reading: NUMERIC(r.closing_reading),
    unit_cost: NUMERIC(r.unit_cost),
    consumption: NUMERIC(r.consumption),
    estimated_cost: NUMERIC(r.estimated_cost),
  }));
}

export async function createUtilityReading(
  db: Queryable,
  ctx: AuthContext,
  input: {
    meterId: string;
    readingDate: string;
    openingReading: number;
    closingReading: number;
    unitCost?: number;
    notes?: string;
  },
) {
  if (input.closingReading < input.openingReading) throw badRequest('Closing reading cannot be below opening reading');
  const consumption = money(input.closingReading - input.openingReading);
  const unitCost = money(input.unitCost ?? 0);
  positive(unitCost, 'unitCost');
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO backoffice.utility_readings
         (tenant_id, meter_id, reading_date, opening_reading, closing_reading, unit_cost, consumption, estimated_cost, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.tenantId, input.meterId, input.readingDate, input.openingReading, input.closingReading, unitCost, consumption, money(consumption * unitCost), input.notes ?? null],
    );
    await auditAction(db, ctx, 'backoffice.utility_reading_created', 'utility_reading', rows[0]!.id, {
      after: { consumption, estimatedCost: money(consumption * unitCost) },
    });
    return { id: rows[0]!.id, consumption, estimatedCost: money(consumption * unitCost) };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('READING_EXISTS', 'A reading already exists for that meter and date');
    throw err;
  }
}

export async function utilitySummary(db: Queryable) {
  const { rows } = await db.query(
    `SELECT m.meter_code, m.meter_name, m.utility_type, m.unit,
            COUNT(r.id)::int AS reading_count, COALESCE(SUM(r.consumption), 0) AS total_consumption,
            COALESCE(SUM(r.estimated_cost), 0) AS total_cost, MAX(r.reading_date) AS latest_reading
       FROM backoffice.utility_meters m
       LEFT JOIN backoffice.utility_readings r ON r.meter_id = m.id
      GROUP BY m.id ORDER BY m.meter_code`,
  );
  return rows.map((r) => ({
    ...r,
    total_consumption: NUMERIC(r.total_consumption),
    total_cost: NUMERIC(r.total_cost),
  }));
}

export async function listSecurityIncidents(db: Queryable) {
  const { rows } = await db.query(
    'SELECT * FROM backoffice.security_incidents ORDER BY occurred_at DESC LIMIT 200',
  );
  return rows;
}

export async function createSecurityIncident(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    incidentType: string;
    severity?: string;
    occurredAt: string;
    location?: string;
    reporterName?: string;
    description: string;
  },
) {
  const code = await nextCode(db, ctx, 'security_incident', 'SEC-');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.security_incidents
       (tenant_id, branch_id, incident_code, incident_type, severity, occurred_at, location, reporter_name, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.incidentType, input.severity ?? 'low', input.occurredAt, input.location ?? null, input.reporterName ?? null, input.description],
  );
  await auditAction(db, ctx, 'backoffice.security_incident_created', 'security_incident', rows[0]!.id);
  return { id: rows[0]!.id, incidentCode: code };
}

export async function updateSecurityIncident(db: Queryable, ctx: AuthContext, id: string, status: string, actionTaken?: string) {
  await transition(db, 'backoffice.security_incidents', id, ['open', 'monitoring'], status, 'Security incident', 'INCIDENT_TRANSITION');
  if (actionTaken !== undefined) {
    await db.query('UPDATE backoffice.security_incidents SET action_taken = $2 WHERE id = $1', [id, actionTaken]);
  }
  await auditAction(db, ctx, 'backoffice.security_incident_status', 'security_incident', id, { after: { status } });
  return { id, status };
}

export async function listSecurityPatrols(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM backoffice.security_patrols ORDER BY patrol_date DESC LIMIT 200');
  return rows;
}

export async function createSecurityPatrol(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; patrolDate: string; guardName: string; areaName: string; findings?: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.security_patrols
       (tenant_id, branch_id, patrol_date, guard_name, area_name, findings)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, input.patrolDate, input.guardName, input.areaName, input.findings ?? null],
  );
  await auditAction(db, ctx, 'backoffice.security_patrol_created', 'security_patrol', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function updateSecurityPatrol(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'backoffice.security_patrols', id, ['scheduled', 'in_progress'], status, 'Security patrol', 'PATROL_TRANSITION');
  if (status === 'in_progress') await db.query('UPDATE backoffice.security_patrols SET started_at = now() WHERE id = $1', [id]);
  if (status === 'completed') await db.query('UPDATE backoffice.security_patrols SET completed_at = now(), started_at = COALESCE(started_at, now()) WHERE id = $1', [id]);
  await auditAction(db, ctx, 'backoffice.security_patrol_status', 'security_patrol', id, { after: { status } });
  return { id, status };
}

export async function listDocuments(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM backoffice.document_register ORDER BY review_date, document_name LIMIT 200');
  return rows;
}

export async function createDocument(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    documentCode?: string;
    documentName: string;
    documentCategory: string;
    ownerName?: string;
    effectiveDate?: string;
    reviewDate?: string;
    retentionYears?: number;
    storageReference?: string;
  },
) {
  const code = input.documentCode ?? (await nextCode(db, ctx, 'document', 'DOC-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.document_register
       (tenant_id, branch_id, document_code, document_name, document_category, owner_name, effective_date, review_date, retention_years, storage_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.documentName, input.documentCategory, input.ownerName ?? null, input.effectiveDate ?? null, input.reviewDate ?? null, input.retentionYears ?? 7, input.storageReference ?? null],
  );
  await auditAction(db, ctx, 'backoffice.document_created', 'document', rows[0]!.id);
  return { id: rows[0]!.id, documentCode: code };
}

export async function updateDocumentStatus(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'backoffice.document_register', id, ['draft', 'active'], status, 'Document', 'DOCUMENT_TRANSITION');
  await auditAction(db, ctx, 'backoffice.document_status', 'document', id, { after: { status } });
  return { id, status };
}

export async function listDocumentActions(db: Queryable, documentId?: string) {
  const { rows } = await db.query(
    'SELECT * FROM backoffice.document_actions WHERE ($1::uuid IS NULL OR document_id = $1) ORDER BY due_date, created_at LIMIT 200',
    [documentId ?? null],
  );
  return rows;
}

export async function createDocumentAction(
  db: Queryable,
  ctx: AuthContext,
  input: { documentId: string; actionText: string; ownerName?: string; dueDate?: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.document_actions
       (tenant_id, document_id, action_text, owner_name, due_date)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.tenantId, input.documentId, input.actionText, input.ownerName ?? null, input.dueDate ?? null],
  );
  await auditAction(db, ctx, 'backoffice.document_action_created', 'document_action', rows[0]!.id);
  return { id: rows[0]!.id };
}

export async function updateDocumentAction(db: Queryable, ctx: AuthContext, id: string, status: string) {
  await transition(db, 'backoffice.document_actions', id, ['open', 'in_progress'], status, 'Document action', 'DOCUMENT_ACTION_TRANSITION');
  if (status === 'completed') await db.query('UPDATE backoffice.document_actions SET completed_at = now() WHERE id = $1', [id]);
  await auditAction(db, ctx, 'backoffice.document_action_status', 'document_action', id, { after: { status } });
  return { id, status };
}

export async function listTrainingCourses(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM backoffice.training_courses ORDER BY status, course_name LIMIT 200');
  return rows;
}

export async function createTrainingCourse(
  db: Queryable,
  ctx: AuthContext,
  input: { branchId?: string; courseCode?: string; courseName: string; category?: string; provider?: string; validityDays?: number; mandatory?: boolean },
) {
  const code = input.courseCode ?? (await nextCode(db, ctx, 'training_course', 'CRS-'));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO backoffice.training_courses
       (tenant_id, branch_id, course_code, course_name, category, provider, validity_days, mandatory)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, input.branchId ?? null, code, input.courseName, input.category ?? 'general', input.provider ?? null, input.validityDays ?? null, input.mandatory ?? false],
  );
  await auditAction(db, ctx, 'backoffice.training_course_created', 'training_course', rows[0]!.id);
  return { id: rows[0]!.id, courseCode: code };
}

export async function listTrainingEnrollments(db: Queryable, employeeId?: string) {
  const { rows } = await db.query(
    `SELECT e.*, c.course_code, c.course_name, emp.full_name, emp.employee_number
       FROM backoffice.training_enrollments e
       JOIN backoffice.training_courses c ON c.id = e.course_id
       JOIN workforce.employees emp ON emp.id = e.employee_id
      WHERE ($1::uuid IS NULL OR e.employee_id = $1)
      ORDER BY e.status, e.expires_at NULLS LAST, e.enrolled_at DESC LIMIT 200`,
    [employeeId ?? null],
  );
  return rows.map((r) => ({ ...r, score: r.score === null ? null : NUMERIC(r.score) }));
}

export async function createTrainingEnrollment(
  db: Queryable,
  ctx: AuthContext,
  input: { courseId: string; employeeId: string },
) {
  const course = await db.query<{ validity_days: number | null; status: string }>(
    'SELECT validity_days, status FROM backoffice.training_courses WHERE id = $1',
    [input.courseId],
  );
  if (!course.rows[0]) throw notFound('Training course not found');
  if (course.rows[0].status !== 'active') throw conflict('COURSE_INACTIVE', 'Training course is not active');
  const expiresAt = course.rows[0].validity_days === null
    ? null
    : new Date(Date.now() + course.rows[0].validity_days * 86_400_000).toISOString();
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO backoffice.training_enrollments (tenant_id, course_id, employee_id, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [ctx.tenantId, input.courseId, input.employeeId, expiresAt],
    );
    await auditAction(db, ctx, 'backoffice.training_enrollment_created', 'training_enrollment', rows[0]!.id);
    return { id: rows[0]!.id, expiresAt };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('ALREADY_ENROLLED', 'This employee is already enrolled in the course');
    throw err;
  }
}

export async function completeTrainingEnrollment(
  db: Queryable,
  ctx: AuthContext,
  id: string,
  input: { score?: number; certificateReference?: string },
) {
  if (input.score !== undefined && !(input.score >= 0 && input.score <= 100)) {
    throw badRequest('score must be between 0 and 100');
  }
  await transition(db, 'backoffice.training_enrollments', id, ['enrolled'], 'completed', 'Training enrollment', 'ENROLLMENT_TRANSITION');
  await db.query(
    'UPDATE backoffice.training_enrollments SET completed_at = now(), score = $2, certificate_reference = $3 WHERE id = $1',
    [id, input.score ?? null, input.certificateReference ?? null],
  );
  await auditAction(db, ctx, 'backoffice.training_enrollment_completed', 'training_enrollment', id, { after: input });
  return { id, status: 'completed' };
}
