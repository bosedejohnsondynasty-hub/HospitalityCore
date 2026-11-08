import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction } from '../audit.js';
import { GL, money, postJournal } from './finance.js';

const NUMERIC = (value: unknown): number => Number(value as string);

export async function listAssets(db: Queryable) {
  const { rows } = await db.query(
    `SELECT a.id, a.asset_code, a.asset_name, a.category, a.location, a.acquisition_date,
            a.acquisition_cost, a.salvage_value, a.useful_life_months, a.accumulated_depreciation,
            a.status, a.serial_number, a.disposed_on, a.disposal_proceeds, b.branch_name
       FROM assets.fixed_assets a
       JOIN platform.branches b ON b.id = a.branch_id
      ORDER BY a.status, a.acquisition_date, a.asset_code`,
  );
  return rows.map((r) => {
    const cost = NUMERIC(r.acquisition_cost);
    const salvage = NUMERIC(r.salvage_value);
    const accumulated = NUMERIC(r.accumulated_depreciation);
    const life = Number(r.useful_life_months);
    const monthly = money((cost - salvage) / life);
    return {
      ...r,
      acquisition_cost: cost,
      salvage_value: salvage,
      accumulated_depreciation: accumulated,
      net_book_value: money(cost - accumulated),
      monthly_depreciation: monthly,
      remaining_depreciable: money(Math.max(0, cost - salvage - accumulated)),
    };
  });
}

export async function createAsset(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId?: string;
    assetCode: string;
    assetName: string;
    category: string;
    location?: string;
    acquisitionDate: string;
    acquisitionCost: number;
    salvageValue?: number;
    usefulLifeMonths: number;
    serialNumber?: string;
    /** Post the acquisition to the ledger (Dr Fixed Assets, Cr Bank). */
    capitalise?: boolean;
  },
) {
  if (input.acquisitionCost <= 0) throw badRequest('acquisitionCost must be greater than zero');
  if (input.usefulLifeMonths < 1 || input.usefulLifeMonths > 600) {
    throw badRequest('usefulLifeMonths must be between 1 and 600');
  }
  const salvage = money(input.salvageValue ?? 0);
  if (salvage < 0 || salvage > input.acquisitionCost) {
    throw badRequest('salvageValue must be between zero and the acquisition cost');
  }
  const branchId = input.branchId ?? (await defaultBranch(db));

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO assets.fixed_assets
       (tenant_id, branch_id, asset_code, asset_name, category, location, acquisition_date,
        acquisition_cost, salvage_value, useful_life_months, serial_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      ctx.tenantId,
      branchId,
      input.assetCode,
      input.assetName,
      input.category,
      input.location ?? null,
      input.acquisitionDate,
      money(input.acquisitionCost),
      salvage,
      input.usefulLifeMonths,
      input.serialNumber ?? null,
    ],
  );
  const assetId = rows[0]!.id;

  let journalEntryId: string | null = null;
  if (input.capitalise !== false) {
    journalEntryId = await postJournal(db, {
      tenantId: ctx.tenantId,
      branchId,
      entryDate: input.acquisitionDate,
      description: `Capitalise asset ${input.assetCode} - ${input.assetName}`,
      sourceType: 'fixed_asset',
      sourceId: assetId,
      purpose: 'capitalisation',
      postedBy: ctx.userId,
      lines: [
        { accountCode: GL.fixedAssets, debit: money(input.acquisitionCost), description: 'Asset cost' },
        { accountCode: GL.bank, credit: money(input.acquisitionCost), description: 'Funded from bank' },
      ],
    });
  }

  await auditAction(db, ctx, 'assets.asset_created', 'fixed_asset', assetId, {
    after: { assetCode: input.assetCode, cost: input.acquisitionCost, capitalised: !!journalEntryId },
  });
  return { id: assetId, journalEntryId };
}

/**
 * Disposes an asset and recognises the gain or loss against net book value.
 *
 *   Dr accumulated depreciation, Dr bank (proceeds), Dr loss
 *   Cr asset cost, Cr gain
 */
export async function disposeAsset(
  db: Queryable,
  ctx: AuthContext,
  assetId: string,
  input: { disposedOn: string; proceeds?: number },
) {
  const { rows } = await db.query<{
    id: string;
    asset_code: string;
    asset_name: string;
    branch_id: string;
    status: string;
    acquisition_cost: string;
    salvage_value: string;
    accumulated_depreciation: string;
    acquisition_date: string;
  }>(
    `SELECT id, asset_code, asset_name, branch_id, status, acquisition_cost, salvage_value,
            accumulated_depreciation, acquisition_date
       FROM assets.fixed_assets WHERE id = $1 FOR UPDATE`,
    [assetId],
  );
  const asset = rows[0];
  if (!asset) throw notFound('Asset not found');
  if (asset.status === 'disposed') throw conflict('ASSET_DISPOSED', 'This asset is already disposed');
  if (input.disposedOn < asset.acquisition_date) {
    throw badRequest('disposedOn cannot precede the acquisition date');
  }

  const cost = NUMERIC(asset.acquisition_cost);
  const accumulated = NUMERIC(asset.accumulated_depreciation);
  const proceeds = money(input.proceeds ?? 0);
  if (proceeds < 0) throw badRequest('proceeds cannot be negative');
  const netBookValue = money(cost - accumulated);
  const gain = money(Math.max(0, proceeds - netBookValue));
  const loss = money(Math.max(0, netBookValue - proceeds));

  const lines: Array<{ accountCode: string; debit?: number; credit?: number; description?: string }> = [];
  if (accumulated > 0) {
    lines.push({
      accountCode: GL.accumulatedDepreciation,
      debit: accumulated,
      description: 'Remove accumulated depreciation',
    });
  }
  if (proceeds > 0) {
    lines.push({ accountCode: GL.bank, debit: proceeds, description: 'Disposal proceeds' });
  }
  if (loss > 0) {
    lines.push({ accountCode: GL.lossOnDisposal, debit: loss, description: 'Loss on disposal' });
  }
  lines.push({ accountCode: GL.fixedAssets, credit: cost, description: 'Derecognise asset cost' });
  if (gain > 0) {
    lines.push({ accountCode: GL.gainOnDisposal, credit: gain, description: 'Gain on disposal' });
  }

  let journalEntryId: string | null = null;
  if (lines.length > 1) {
    journalEntryId = await postJournal(db, {
      tenantId: ctx.tenantId,
      branchId: asset.branch_id,
      entryDate: input.disposedOn,
      description: `Dispose asset ${asset.asset_code} - ${asset.asset_name}`,
      sourceType: 'fixed_asset',
      sourceId: assetId,
      purpose: 'disposal',
      postedBy: ctx.userId,
      lines,
    });
  }

  await db.query(
    `UPDATE assets.fixed_assets
        SET status = 'disposed', disposed_on = $2, disposal_proceeds = $3, updated_at = now()
      WHERE id = $1`,
    [assetId, input.disposedOn, proceeds],
  );
  await auditAction(db, ctx, 'assets.asset_disposed', 'fixed_asset', assetId, {
    after: { disposedOn: input.disposedOn, proceeds, gain, loss, journalEntryId },
  });
  return { id: assetId, status: 'disposed', gain, loss, journalEntryId };
}

export async function listDepreciationRuns(db: Queryable) {
  const { rows } = await db.query(
    `SELECT r.id, r.run_number, r.period_start, r.period_end, r.status, r.total_amount,
            r.journal_entry_id, r.posted_at, count(e.id)::int AS assets
       FROM assets.depreciation_runs r
       LEFT JOIN assets.depreciation_entries e ON e.run_id = r.id
      GROUP BY r.id ORDER BY r.period_start DESC`,
  );
  return rows.map((r) => ({ ...r, total_amount: NUMERIC(r.total_amount) }));
}

export async function getDepreciationRun(db: Queryable, runId: string) {
  const { rows } = await db.query<{
    id: string;
    run_number: string;
    period_start: string;
    period_end: string;
    status: string;
    total_amount: string;
    journal_entry_id: string | null;
    posted_at: string | null;
  }>(
    `SELECT id, run_number, period_start, period_end, status, total_amount, journal_entry_id, posted_at
       FROM assets.depreciation_runs WHERE id = $1`,
    [runId],
  );
  if (!rows[0]) throw notFound('Depreciation run not found');
  const entries = await db.query(
    `SELECT e.id, e.amount, a.asset_code, a.asset_name, a.acquisition_cost, a.accumulated_depreciation
       FROM assets.depreciation_entries e
       JOIN assets.fixed_assets a ON a.id = e.asset_id
      WHERE e.run_id = $1 ORDER BY a.asset_code`,
    [runId],
  );
  return {
    run: { ...rows[0], total_amount: NUMERIC(rows[0].total_amount) },
    entries: entries.rows.map((r) => ({
      ...r,
      amount: NUMERIC(r.amount),
      acquisition_cost: NUMERIC(r.acquisition_cost),
      accumulated_depreciation: NUMERIC(r.accumulated_depreciation),
    })),
  };
}

/** A depreciation run covers exactly one calendar month. */
function assertSingleMonth(periodStart: string, periodEnd: string): void {
  const start = new Date(`${periodStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw badRequest('periodStart must be a date');
  if (start.getUTCDate() !== 1) throw badRequest('periodStart must be the first day of a month');
  const expectedEnd = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  )
    .toISOString()
    .slice(0, 10);
  if (periodEnd !== expectedEnd) {
    throw badRequest(`A depreciation run covers one month; periodEnd must be ${expectedEnd}`);
  }
}

export async function createDepreciationRun(
  db: Queryable,
  ctx: AuthContext,
  input: { periodStart: string; periodEnd: string },
) {
  assertSingleMonth(input.periodStart, input.periodEnd);

  const assets = await db.query<{
    id: string;
    asset_code: string;
    acquisition_cost: string;
    salvage_value: string;
    accumulated_depreciation: string;
    useful_life_months: number;
  }>(
    `SELECT id, asset_code, acquisition_cost, salvage_value, accumulated_depreciation, useful_life_months
       FROM assets.fixed_assets
      WHERE status = 'active'
        AND acquisition_date <= $1
        AND accumulated_depreciation < acquisition_cost - salvage_value
      ORDER BY asset_code`,
    [input.periodEnd],
  );
  if (assets.rows.length === 0) {
    throw conflict('NO_DEPRECIABLE_ASSETS', 'No active assets need depreciation for this month');
  }

  const runNumber = (
    await db.query<{ number: string }>(
      "SELECT app_next_document_number($1, 'depreciation', 'DEP-') AS number",
      [ctx.tenantId],
    )
  ).rows[0]!.number;

  let run: { rows: Array<{ id: string }> };
  try {
    run = await db.query<{ id: string }>(
      `INSERT INTO assets.depreciation_runs
         (tenant_id, run_number, period_start, period_end, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.tenantId, runNumber, input.periodStart, input.periodEnd, ctx.userId],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw conflict('DEPRECIATION_PERIOD_EXISTS', 'Depreciation already exists for that month');
    }
    throw err;
  }
  const runId = run.rows[0]!.id;

  let total = 0;
  for (const asset of assets.rows) {
    const cost = NUMERIC(asset.acquisition_cost);
    const salvage = NUMERIC(asset.salvage_value);
    const accumulated = NUMERIC(asset.accumulated_depreciation);
    const remaining = money(cost - salvage - accumulated);
    const monthly = money((cost - salvage) / Number(asset.useful_life_months));
    const amount = money(Math.min(monthly, remaining));
    if (amount <= 0) continue;
    total += amount;
    await db.query(
      'INSERT INTO assets.depreciation_entries (tenant_id, run_id, asset_id, amount) VALUES ($1,$2,$3,$4)',
      [ctx.tenantId, runId, asset.id, amount],
    );
  }
  if (total <= 0) {
    await db.query('DELETE FROM assets.depreciation_runs WHERE id = $1', [runId]);
    throw conflict('NO_DEPRECIABLE_ASSETS', 'Calculated depreciation is zero for this month');
  }

  await db.query('UPDATE assets.depreciation_runs SET total_amount = $2 WHERE id = $1', [
    runId,
    money(total),
  ]);
  await auditAction(db, ctx, 'assets.depreciation_created', 'depreciation_run', runId, {
    after: { runNumber, periodStart: input.periodStart, total },
  });
  return { id: runId, runNumber, total, assets: assets.rows.length };
}

export async function postDepreciationRun(db: Queryable, ctx: AuthContext, runId: string) {
  const { rows } = await db.query<{
    id: string;
    run_number: string;
    status: string;
    period_end: string;
    total_amount: string;
  }>(
    'SELECT id, run_number, status, period_end, total_amount FROM assets.depreciation_runs WHERE id = $1 FOR UPDATE',
    [runId],
  );
  const run = rows[0];
  if (!run) throw notFound('Depreciation run not found');
  if (run.status === 'posted') throw conflict('DEPRECIATION_ALREADY_POSTED', 'This run is already posted');
  const total = NUMERIC(run.total_amount);
  if (total <= 0) throw conflict('NOTHING_TO_POST', 'This run has no depreciation to post');

  const journalEntryId = await postJournal(db, {
    tenantId: ctx.tenantId,
    entryDate: run.period_end,
    description: `Depreciation ${run.run_number}`,
    sourceType: 'depreciation_run',
    sourceId: runId,
    purpose: 'depreciation',
    postedBy: ctx.userId,
    lines: [
      { accountCode: GL.depreciationExpense, debit: total, description: 'Monthly depreciation' },
      { accountCode: GL.accumulatedDepreciation, credit: total, description: 'Accumulated depreciation' },
    ],
  });

  const entries = await db.query<{ asset_id: string; amount: string }>(
    'SELECT asset_id, amount FROM assets.depreciation_entries WHERE run_id = $1',
    [runId],
  );
  for (const entry of entries.rows) {
    await db.query(
      `UPDATE assets.fixed_assets
          SET accumulated_depreciation = accumulated_depreciation + $2,
              status = CASE
                WHEN accumulated_depreciation + $2 >= acquisition_cost - salvage_value THEN 'fully_depreciated'
                ELSE status
              END,
              updated_at = now()
        WHERE id = $1`,
      [entry.asset_id, NUMERIC(entry.amount)],
    );
  }

  await db.query(
    "UPDATE assets.depreciation_runs SET status = 'posted', journal_entry_id = $2, posted_at = now() WHERE id = $1",
    [runId, journalEntryId],
  );
  await auditAction(db, ctx, 'assets.depreciation_posted', 'depreciation_run', runId, {
    after: { journalEntryId, total },
  });
  return { id: runId, status: 'posted', journalEntryId, total };
}

async function defaultBranch(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM platform.branches WHERE status = 'active' ORDER BY created_at LIMIT 1",
  );
  if (!rows[0]) throw conflict('NO_BRANCH', 'Create a branch before adding assets');
  return rows[0].id;
}
