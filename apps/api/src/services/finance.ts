import type { Queryable } from '../db.js';
import { AppError, conflict } from '../errors.js';
import { GL } from '../catalogue.js';

export { GL };

export const money = (value: number): number => {
  const rounded = Math.round(value * 10_000) / 10_000;
  // Normalise -0 so ledger comparisons stay stable.
  return rounded === 0 ? 0 : rounded;
};

export async function getDefaultOrganization(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM platform.organizations ORDER BY created_at LIMIT 1',
  );
  if (!rows[0]) throw new AppError(409, 'NOT_PROVISIONED', 'Tenant has no organization configured');
  return rows[0].id;
}

async function accountIdsByCode(db: Queryable, organizationId: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; account_code: string }>(
    'SELECT id, account_code FROM finance.accounts WHERE organization_id = $1',
    [organizationId],
  );
  return new Map(rows.map((r) => [r.account_code, r.id]));
}

export interface JournalLineInput {
  accountCode?: keyof typeof GL | string;
  accountId?: string;
  debit?: number;
  credit?: number;
  description?: string;
  costCentre?: string;
}

export interface PostJournalInput {
  tenantId: string;
  branchId?: string | null;
  entryDate: string;
  description: string;
  sourceType?: string;
  sourceId?: string;
  /** Exactly-once guard. A given source/purpose may post at most one entry. */
  purpose?: string;
  lines: JournalLineInput[];
  postedBy?: string | null;
}

/**
 * Posts a balanced journal entry.
 *
 * The database independently enforces period control, debit=credit balance and
 * append-only posted records; this function resolves accounts, assigns the entry
 * number and applies the exactly-once posting link.
 */
export async function postJournal(db: Queryable, input: PostJournalInput): Promise<string> {
  const organizationId = await getDefaultOrganization(db);
  const accounts = await accountIdsByCode(db, organizationId);

  const period = await db.query<{ id: string }>(
    `SELECT id FROM finance.fiscal_periods
      WHERE organization_id = $1 AND starts_on <= $2 AND ends_on >= $2 AND status = 'open'
      ORDER BY starts_on DESC LIMIT 1`,
    [organizationId, input.entryDate],
  );
  const periodId = period.rows[0]?.id;
  if (!periodId) {
    throw conflict(
      'PERIOD_CLOSED',
      `No open fiscal period covers ${input.entryDate}. Open the period before posting.`,
    );
  }

  const resolved = input.lines.map((line, index) => {
    const accountId = line.accountId ?? (line.accountCode ? accounts.get(String(line.accountCode)) : undefined);
    if (!accountId) {
      throw new AppError(400, 'UNKNOWN_ACCOUNT', `Unknown account code: ${line.accountCode ?? index}`);
    }
    return {
      accountId,
      debit: money(line.debit ?? 0),
      credit: money(line.credit ?? 0),
      description: line.description ?? null,
      costCentre: line.costCentre ?? null,
      lineNumber: index + 1,
    };
  });

  const totalDebit = money(resolved.reduce((s, l) => s + l.debit, 0));
  const totalCredit = money(resolved.reduce((s, l) => s + l.credit, 0));
  if (totalDebit !== totalCredit || totalDebit <= 0) {
    throw new AppError(
      400,
      'UNBALANCED_JOURNAL',
      `Journal is not balanced (debit ${totalDebit} vs credit ${totalCredit})`,
    );
  }

  const entryNumber = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'journal', 'JV-') AS number",
    [input.tenantId],
  );

  const entry = await db.query<{ id: string }>(
    `INSERT INTO finance.journal_entries
       (tenant_id, organization_id, branch_id, entry_number, entry_date, period_id, description,
        source_type, source_id, status, posted_by, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10, now())
     RETURNING id`,
    [
      input.tenantId,
      organizationId,
      input.branchId ?? null,
      entryNumber.rows[0]!.number,
      input.entryDate,
      periodId,
      input.description,
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.postedBy ?? null,
    ],
  );
  const entryId = entry.rows[0]!.id;

  for (const line of resolved) {
    await db.query(
      `INSERT INTO finance.journal_lines
         (tenant_id, entry_id, line_number, account_id, debit, credit, description, cost_centre)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.tenantId,
        entryId,
        line.lineNumber,
        line.accountId,
        line.debit,
        line.credit,
        line.description,
        line.costCentre,
      ],
    );
  }

  if (input.purpose && input.sourceType && input.sourceId) {
    try {
      await db.query(
        `INSERT INTO finance.posting_links
           (tenant_id, source_type, source_id, purpose, journal_entry_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, input.sourceType, input.sourceId, input.purpose, entryId],
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        throw conflict(
          'DUPLICATE_POSTING',
          `A ${input.purpose} posting already exists for ${input.sourceType} ${input.sourceId}`,
        );
      }
      throw err;
    }
  }

  return entryId;
}

/** Reverses a posted journal entry by creating a mirrored entry (never deletes). */
export async function reverseJournal(
  db: Queryable,
  tenantId: string,
  entryId: string,
  reason: string,
  postedBy?: string | null,
): Promise<string> {
  const entry = await db.query<{ id: string; entry_date: string; description: string; branch_id: string | null; status: string }>(
    'SELECT id, entry_date, description, branch_id, status FROM finance.journal_entries WHERE id = $1',
    [entryId],
  );
  const original = entry.rows[0];
  if (!original) throw new AppError(404, 'NOT_FOUND', 'Journal entry not found');
  if (original.status !== 'posted') {
    throw conflict('ENTRY_NOT_POSTED', 'Only posted entries can be reversed');
  }

  const lines = await db.query<{ account_id: string; debit: string; credit: string }>(
    'SELECT account_id, debit, credit FROM finance.journal_lines WHERE entry_id = $1 ORDER BY line_number',
    [entryId],
  );

  const reversalId = await postJournal(db, {
    tenantId,
    branchId: original.branch_id,
    entryDate: new Date().toISOString().slice(0, 10),
    description: `Reversal of ${original.description}: ${reason}`,
    sourceType: 'journal_reversal',
    sourceId: entryId,
    lines: lines.rows.map((l) => ({
      accountId: l.account_id,
      debit: Number(l.credit),
      credit: Number(l.debit),
    })),
    postedBy,
  });

  await db.query(
    "UPDATE finance.journal_entries SET status = 'reversed', reversed_by_entry_id = $2 WHERE id = $1",
    [entryId, reversalId],
  );
  return reversalId;
}

export async function trialBalance(db: Queryable): Promise<
  Array<{ account_code: string; account_name: string; account_class: string; total_debit: number; total_credit: number; net_debit: number; net_credit: number }>
> {
  const { rows } = await db.query<{
    account_code: string;
    account_name: string;
    account_class: string;
    total_debit: string;
    total_credit: string;
    net_debit: string;
    net_credit: string;
  }>('SELECT * FROM finance.trial_balance ORDER BY account_code');
  return rows.map((r) => ({
    account_code: r.account_code,
    account_name: r.account_name,
    account_class: r.account_class,
    total_debit: Number(r.total_debit),
    total_credit: Number(r.total_credit),
    net_debit: Number(r.net_debit),
    net_credit: Number(r.net_credit),
  }));
}
