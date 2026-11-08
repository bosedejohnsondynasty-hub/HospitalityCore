import './env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeAll, seedTenant, sql, type SeededTenant } from './helpers.js';

after(async () => {
  await closeAll();
});

function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function isoAt(offsetHours: number): string {
  return new Date(Date.now() + offsetHours * 3_600_000).toISOString();
}

async function glAccountId(tenantId: string, code: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    `SELECT a.id FROM finance.accounts a
       JOIN platform.organizations o ON o.id = a.organization_id
      WHERE o.tenant_id = $1 AND a.account_code = $2`,
    [tenantId, code],
  );
  assert.ok(rows[0]?.id, `account ${code} exists`);
  return rows[0]!.id;
}

async function createEmployee(tenant: SeededTenant): Promise<string> {
  const res = await api('POST', '/api/v1/workforce/employees', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      fullName: 'Grace Trainer',
      jobTitle: 'Front Desk Agent',
      department: 'Front Office',
      hireDate: isoDate(-30),
      baseSalary: 250000,
    },
  });
  assert.equal(res.status, 200, `create employee: ${JSON.stringify(res.body)}`);
  return (res.body as { id: string }).id;
}

test('budget lifecycle: lines, approval, lock and variance against posted journals', async () => {
  const tenant = await seedTenant();
  const payrollAccount = await glAccountId(tenant.tenantId, '6000');

  const created = await api('POST', '/api/v1/hotel/budgets', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      fiscalYear: Number(isoDate().slice(0, 4)),
      name: 'Housekeeping payroll budget',
      lines: [{ accountId: payrollAccount, category: 'payroll', amount: 1_000_000 }],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const budgetId = (created.body as { id: string }).id;

  const line = await api('POST', `/api/v1/hotel/budgets/${budgetId}/lines`, {
    token: tenant.token,
    body: { accountId: payrollAccount, category: 'overtime', amount: 250_000 },
  });
  assert.equal(line.status, 200, JSON.stringify(line.body));

  const varianceBefore = await api('GET', `/api/v1/hotel/budgets/${budgetId}/variance`, {
    token: tenant.token,
  });
  assert.equal(varianceBefore.status, 200);
  const before = varianceBefore.body as { totals: { budget: number; actual: number; variance: number } };
  assert.equal(before.totals.budget, 1_250_000, 'budget total reflects both lines');

  const approveDraft = await api('POST', `/api/v1/hotel/budgets/${budgetId}/lock`, { token: tenant.token });
  assert.equal(approveDraft.status, 409, 'a draft budget cannot be locked');
  assert.equal((approveDraft.body as { error: { code: string } }).error.code, 'BUDGET_NOT_LOCKABLE');

  const approved = await api('POST', `/api/v1/hotel/budgets/${budgetId}/approve`, { token: tenant.token });
  assert.equal(approved.status, 200);
  const locked = await api('POST', `/api/v1/hotel/budgets/${budgetId}/lock`, { token: tenant.token });
  assert.equal(locked.status, 200);

  const lineAfterLock = await api('POST', `/api/v1/hotel/budgets/${budgetId}/lines`, {
    token: tenant.token,
    body: { accountId: payrollAccount, category: 'bonus', amount: 1000 },
  });
  assert.equal(lineAfterLock.status, 409, 'a locked budget rejects new lines');

  const list = await api('GET', '/api/v1/hotel/budgets', { token: tenant.token });
  assert.equal(list.status, 200);
  const budgets = (list.body as { budgets: Array<{ id: string; status: string; line_count: number }> }).budgets;
  const mine = budgets.find((b) => b.id === budgetId);
  assert.equal(mine?.status, 'locked');
  assert.equal(mine?.line_count, 2);
});

test('treasury transfer posts one balanced journal and is rejected for the same account twice', async () => {
  const tenant = await seedTenant();
  const cashGl = await glAccountId(tenant.tenantId, '1000');
  const bankGl = await glAccountId(tenant.tenantId, '1010');

  const accounts = await sql<{ id: string }>(
    `INSERT INTO finance.bank_accounts (tenant_id, branch_id, account_name, bank_name, account_number, gl_account_id)
     VALUES ($1,$2,'Main bank','Test Bank','000111',$3),
            ($1,$2,'Petty cash','Test Bank','000222',$4)
     RETURNING id`,
    [tenant.tenantId, tenant.branchId, bankGl, cashGl],
  );
  const sourceId = accounts[0]!.id;
  const destinationId = accounts[1]!.id;

  const positions = await api('GET', '/api/v1/hotel/treasury/positions', { token: tenant.token });
  assert.equal(positions.status, 200);
  const positionIds = (positions.body as { accounts: Array<{ id: string }> }).accounts.map((a) => a.id);
  assert.ok(positionIds.includes(sourceId) && positionIds.includes(destinationId), 'both bank accounts appear in treasury positions');

  const transfer = await api('POST', '/api/v1/hotel/treasury/transfers', {
    token: tenant.token,
    body: {
      sourceBankAccountId: sourceId,
      destinationBankAccountId: destinationId,
      amount: 75_000,
      reference: `TRF-${Date.now()}`,
      entryDate: isoDate(),
      reason: 'Cash float replenishment',
    },
  });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  const journalEntryId = (transfer.body as { journalEntryId: string }).journalEntryId;
  assert.ok(journalEntryId);

  const lines = await sql<{ debit: string; credit: string; account_id: string }>(
    'SELECT debit, credit, account_id FROM finance.journal_lines WHERE entry_id = $1 ORDER BY line_number',
    [journalEntryId],
  );
  assert.equal(lines.length, 2, 'two journal lines posted');
  assert.equal(Number(lines[0]!.debit), 75_000, 'destination debited');
  assert.equal(lines[0]!.account_id, cashGl);
  assert.equal(Number(lines[1]!.credit), 75_000, 'source credited');
  assert.equal(lines[1]!.account_id, bankGl);

  const links = await sql<{ purpose: string }>(
    "SELECT purpose FROM finance.posting_links WHERE source_type = 'treasury_transfer' AND source_id = $1",
    [(transfer.body as { id: string }).id],
  );
  assert.equal(links[0]?.purpose, 'transfer');

  const sameAccount = await api('POST', '/api/v1/hotel/treasury/transfers', {
    token: tenant.token,
    body: {
      sourceBankAccountId: sourceId,
      destinationBankAccountId: sourceId,
      amount: 100,
      reference: `TRF-X-${Date.now()}`,
      entryDate: isoDate(),
    },
  });
  assert.equal(sameAccount.status, 400, 'a transfer needs two different accounts');
});

test('laundry cycle requires full accountability before completion and records an event', async () => {
  const tenant = await seedTenant();

  const created = await api('POST', '/api/v1/hotel/laundry', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      hotelId: tenant.hotelId,
      cycleType: 'guest_linen',
      scheduledAt: isoAt(-2),
      items: [
        { itemName: 'Bath towel', quantity: 40, returnedQuantity: 38, lostQuantity: 2 },
        { itemName: 'Bed sheet', quantity: 30 },
      ],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const cycleId = (created.body as { id: string }).id;

  const incomplete = await api('POST', `/api/v1/hotel/laundry/${cycleId}/complete`, { token: tenant.token });
  assert.equal(incomplete.status, 409, 'unresolved lines block completion');
  assert.equal((incomplete.body as { error: { code: string } }).error.code, 'LAUNDRY_UNRESOLVED');

  const detail = await api('GET', `/api/v1/hotel/laundry/${cycleId}`, { token: tenant.token });
  assert.equal(detail.status, 200);
  const items = (detail.body as { items: Array<{ id: string }> }).items;
  const sheet = items[1]!;
  const resolved = await sql(
    'UPDATE backoffice.laundry_items SET returned_quantity = 30 WHERE id = $1',
    [sheet.id],
  );
  assert.ok(Array.isArray(resolved));

  const completed = await api('POST', `/api/v1/hotel/laundry/${cycleId}/complete`, { token: tenant.token });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const events = await sql<{ event_type: string }>(
    "SELECT event_type FROM integration.outbox WHERE tenant_id = $1 AND aggregate_id = $2",
    [tenant.tenantId, cycleId],
  );
  assert.equal(events[0]?.event_type, 'laundry.completed');

  const alreadyComplete = await api('POST', `/api/v1/hotel/laundry/${cycleId}/complete`, { token: tenant.token });
  assert.equal(alreadyComplete.status, 409);
});

test('contracts, insurance claims, quality and security transitions are guarded', async () => {
  const tenant = await seedTenant();

  const agreement = await api('POST', '/api/v1/hotel/agreements', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      agreementName: 'Linen supply agreement',
      agreementType: 'supply',
      counterparty: 'Clean Linens Ltd',
      startDate: isoDate(-10),
      endDate: isoDate(355),
      amount: 2_400_000,
    },
  });
  assert.equal(agreement.status, 200, JSON.stringify(agreement.body));
  const agreementId = (agreement.body as { id: string }).id;
  const activation = await api('POST', `/api/v1/hotel/agreements/${agreementId}/status`, {
    token: tenant.token,
    body: { status: 'active' },
  });
  assert.equal(activation.status, 200);
  const illegal = await api('POST', `/api/v1/hotel/agreements/${agreementId}/status`, {
    token: tenant.token,
    body: { status: 'active' },
  });
  assert.equal(illegal.status, 409, 'agreements cannot re-enter the same state');

  const policy = await api('POST', '/api/v1/hotel/insurance/policies', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      insurer: 'Guardian Assurance',
      policyNumber: `POL-${Date.now()}`,
      coverageType: 'fire',
      startDate: isoDate(-30),
      endDate: isoDate(335),
      premium: 480_000,
      deductible: 25_000,
    },
  });
  assert.equal(policy.status, 200, JSON.stringify(policy.body));
  const policyId = (policy.body as { id: string }).id;
  await api('POST', `/api/v1/hotel/insurance/policies/${policyId}/status`, {
    token: tenant.token,
    body: { status: 'active' },
  });

  const claim = await api('POST', '/api/v1/hotel/insurance/claims', {
    token: tenant.token,
    body: { policyId, incidentDate: isoDate(-5), claimedAmount: 120_000, description: 'Kitchen fire damage' },
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const claimId = (claim.body as { id: string }).id;

  const paidTooEarly = await api('POST', `/api/v1/hotel/insurance/claims/${claimId}/status`, {
    token: tenant.token,
    body: { status: 'paid', paidAmount: 120_000 },
  });
  assert.equal(paidTooEarly.status, 409, 'an open claim must be reviewed before payment');

  const reviewed = await api('POST', `/api/v1/hotel/insurance/claims/${claimId}/status`, {
    token: tenant.token,
    body: { status: 'in_review' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));

  const approved = await api('POST', `/api/v1/hotel/insurance/claims/${claimId}/status`, {
    token: tenant.token,
    body: { status: 'approved', estimatedRecovery: 110_000 },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const overClaim = await api('POST', `/api/v1/hotel/insurance/claims/${claimId}/status`, {
    token: tenant.token,
    body: { status: 'paid', paidAmount: 500_000 },
  });
  assert.equal(overClaim.status, 400, 'recovery cannot exceed the claimed amount');

  const paid = await api('POST', `/api/v1/hotel/insurance/claims/${claimId}/status`, {
    token: tenant.token,
    body: { status: 'paid', paidAmount: 110_000 },
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));

  const inspection = await api('POST', '/api/v1/hotel/quality/inspections', {
    token: tenant.token,
    body: { branchId: tenant.branchId, areaName: 'Room 101', standardName: 'Guest room readiness', scheduledAt: isoAt(-1) },
  });
  assert.equal(inspection.status, 200, JSON.stringify(inspection.body));
  const inspectionId = (inspection.body as { id: string }).id;
  const completion = await api('POST', `/api/v1/hotel/quality/inspections/${inspectionId}/complete`, {
    token: tenant.token,
    body: { score: 82, result: 'follow_up' },
  });
  assert.equal(completion.status, 200);
  const action = await api('POST', '/api/v1/hotel/quality/actions', {
    token: tenant.token,
    body: { inspectionId, actionText: 'Replace torn bathrobe', ownerName: 'Housekeeping', dueDate: isoDate(2) },
  });
  assert.equal(action.status, 200, JSON.stringify(action.body));
  const actionId = (action.body as { id: string }).id;
  const actionDone = await api('POST', `/api/v1/hotel/quality/actions/${actionId}/status`, {
    token: tenant.token,
    body: { status: 'completed' },
  });
  assert.equal(actionDone.status, 200);

  const incident = await api('POST', '/api/v1/hotel/security/incidents', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      incidentType: 'theft',
      severity: 'high',
      occurredAt: isoAt(-3),
      location: 'Pool bar',
      description: 'Guest reported a missing phone',
    },
  });
  assert.equal(incident.status, 200, JSON.stringify(incident.body));
  const incidentId = (incident.body as { id: string }).id;
  const closed = await api('POST', `/api/v1/hotel/security/incidents/${incidentId}/status`, {
    token: tenant.token,
    body: { status: 'closed', actionTaken: 'CCTV reviewed, incident logged with police' },
  });
  assert.equal(closed.status, 200);
  const reopened = await api('POST', `/api/v1/hotel/security/incidents/${incidentId}/status`, {
    token: tenant.token,
    body: { status: 'monitoring' },
  });
  assert.equal(reopened.status, 409, 'a closed incident cannot be reopened');
});

test('utility meters compute consumption and cost, rejecting duplicate readings', async () => {
  const tenant = await seedTenant();

  const meter = await api('POST', '/api/v1/hotel/utilities/meters', {
    token: tenant.token,
    body: { branchId: tenant.branchId, meterName: 'Main electricity', utilityType: 'electricity', unit: 'kWh' },
  });
  assert.equal(meter.status, 200, JSON.stringify(meter.body));
  const meterId = (meter.body as { id: string }).id;

  const reading = await api('POST', '/api/v1/hotel/utilities/readings', {
    token: tenant.token,
    body: { meterId, readingDate: isoDate(-1), openingReading: 10_000, closingReading: 10_450, unitCost: 210 },
  });
  assert.equal(reading.status, 200, JSON.stringify(reading.body));
  assert.equal((reading.body as { consumption: number }).consumption, 450);
  assert.equal((reading.body as { estimatedCost: number }).estimatedCost, 94_500);

  const duplicate = await api('POST', '/api/v1/hotel/utilities/readings', {
    token: tenant.token,
    body: { meterId, readingDate: isoDate(-1), openingReading: 10_450, closingReading: 10_500, unitCost: 210 },
  });
  assert.equal(duplicate.status, 409, 'one reading per meter per day');

  const backwards = await api('POST', '/api/v1/hotel/utilities/readings', {
    token: tenant.token,
    body: { meterId, readingDate: isoDate(), openingReading: 500, closingReading: 100, unitCost: 210 },
  });
  assert.equal(backwards.status, 400);

  const summary = await api('GET', '/api/v1/hotel/utilities/summary', { token: tenant.token });
  assert.equal(summary.status, 200);
  const meters = (summary.body as { meters: Array<{ total_consumption: number; total_cost: number }> }).meters;
  assert.equal(meters[0]?.total_consumption, 450);
  assert.equal(meters[0]?.total_cost, 94_500);
});

test('document register and training enrollment track compliance per employee', async () => {
  const tenant = await seedTenant();
  const employeeId = await createEmployee(tenant);

  const doc = await api('POST', '/api/v1/hotel/documents', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      documentName: 'Fire safety certificate',
      documentCategory: 'statutory',
      ownerName: 'Engineering',
      reviewDate: isoDate(300),
      retentionYears: 7,
    },
  });
  assert.equal(doc.status, 200, JSON.stringify(doc.body));
  const docId = (doc.body as { id: string }).id;
  const activated = await api('POST', `/api/v1/hotel/documents/${docId}/status`, {
    token: tenant.token,
    body: { status: 'active' },
  });
  assert.equal(activated.status, 200);

  const docAction = await api('POST', '/api/v1/hotel/documents/actions', {
    token: tenant.token,
    body: { documentId: docId, actionText: 'Book annual extinguisher service', dueDate: isoDate(20) },
  });
  assert.equal(docAction.status, 200, JSON.stringify(docAction.body));

  const course = await api('POST', '/api/v1/hotel/training/courses', {
    token: tenant.token,
    body: { branchId: tenant.branchId, courseName: 'Fire warden induction', category: 'safety', validityDays: 365, mandatory: true },
  });
  assert.equal(course.status, 200, JSON.stringify(course.body));
  const courseId = (course.body as { id: string }).id;

  const enrollment = await api('POST', '/api/v1/hotel/training/enrollments', {
    token: tenant.token,
    body: { courseId, employeeId },
  });
  assert.equal(enrollment.status, 200, JSON.stringify(enrollment.body));
  const enrollmentId = (enrollment.body as { id: string }).id;
  assert.ok((enrollment.body as { expiresAt: string }).expiresAt, 'validity window is computed on enrollment');

  const duplicate = await api('POST', '/api/v1/hotel/training/enrollments', {
    token: tenant.token,
    body: { courseId, employeeId },
  });
  assert.equal(duplicate.status, 409, 'an employee trains once per course');

  const completed = await api('POST', `/api/v1/hotel/training/enrollments/${enrollmentId}/complete`, {
    token: tenant.token,
    body: { score: 91, certificateReference: 'CERT-2026-001' },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const list = await api('GET', `/api/v1/hotel/training/enrollments?employeeId=${employeeId}`, {
    token: tenant.token,
  });
  assert.equal(list.status, 200);
  const rows = (list.body as { enrollments: Array<{ status: string; certificate_reference: string }> }).enrollments;
  assert.equal(rows[0]?.status, 'completed');
  assert.equal(rows[0]?.certificate_reference, 'CERT-2026-001');
});

test('banquet events accumulate charges and emit a completion event', async () => {
  const tenant = await seedTenant();

  const event = await api('POST', '/api/v1/hotel/banquets', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      hotelId: tenant.hotelId,
      eventName: 'Okafor wedding reception',
      clientName: 'Okafor Family',
      eventAt: isoAt(240),
      expectedPax: 120,
      estimatedRevenue: 1_800_000,
    },
  });
  assert.equal(event.status, 200, JSON.stringify(event.body));
  const eventId = (event.body as { id: string }).id;

  const hall = await api('POST', `/api/v1/hotel/banquets/${eventId}/charges`, {
    token: tenant.token,
    body: { chargeType: 'venue', description: 'Ballroom hire', quantity: 1, unitPrice: 900_000 },
  });
  assert.equal(hall.status, 200, JSON.stringify(hall.body));
  const catering = await api('POST', `/api/v1/hotel/banquets/${eventId}/charges`, {
    token: tenant.token,
    body: { chargeType: 'catering', description: 'Buffet per head', quantity: 120, unitPrice: 7_000 },
  });
  assert.equal(catering.status, 200, JSON.stringify(catering.body));

  const charges = await api('GET', `/api/v1/hotel/banquets/${eventId}/charges`, { token: tenant.token });
  assert.equal(charges.status, 200, JSON.stringify(charges.body));
  const rows = (charges.body as { charges: Array<{ amount: number }> }).charges;
  assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 1_740_000);

  for (const status of ['booked', 'confirmed', 'delivered', 'completed']) {
    const moved = await api('POST', `/api/v1/hotel/banquets/${eventId}/status`, {
      token: tenant.token,
      body: { status },
    });
    assert.equal(moved.status, 200, `banquet → ${status}: ${JSON.stringify(moved.body)}`);
  }

  const events = await sql<{ event_type: string }>(
    'SELECT event_type FROM integration.outbox WHERE tenant_id = $1 AND aggregate_id = $2',
    [tenant.tenantId, eventId],
  );
  assert.equal(events[0]?.event_type, 'banquet.completed');

  const afterClose = await api('POST', `/api/v1/hotel/banquets/${eventId}/charges`, {
    token: tenant.token,
    body: { chargeType: 'extras', description: 'Late charge', quantity: 1, unitPrice: 1000 },
  });
  assert.equal(afterClose.status, 409, 'completed events reject new charges');
});

test('sales pipeline and CRM segments capture commercial activity', async () => {
  const tenant = await seedTenant();

  const campaign = await api('POST', '/api/v1/hotel/sales/campaigns', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      campaignName: 'Q4 corporate drive',
      channel: 'email',
      budgetAmount: 300_000,
      expectedRevenue: 4_000_000,
      startsOn: isoDate(-7),
      endsOn: isoDate(60),
    },
  });
  assert.equal(campaign.status, 200, JSON.stringify(campaign.body));
  const campaignId = (campaign.body as { id: string }).id;
  const activated = await api('POST', `/api/v1/hotel/sales/campaigns/${campaignId}/status`, {
    token: tenant.token,
    body: { status: 'active' },
  });
  assert.equal(activated.status, 200);

  const opportunity = await api('POST', '/api/v1/hotel/sales/opportunities', {
    token: tenant.token,
    body: {
      campaignId,
      prospectName: 'Zenith Energy',
      contactEmail: 'travel@zenith.example',
      estimatedValue: 2_500_000,
      probabilityPercent: 40,
      expectedCloseDate: isoDate(30),
    },
  });
  assert.equal(opportunity.status, 200, JSON.stringify(opportunity.body));
  const opportunityId = (opportunity.body as { id: string }).id;

  const pipeline = await api('GET', `/api/v1/hotel/sales/opportunities?campaignId=${campaignId}`, {
    token: tenant.token,
  });
  assert.equal(pipeline.status, 200);
  const rows = (pipeline.body as { opportunities: Array<{ weighted_value: number }> }).opportunities;
  assert.equal(rows[0]?.weighted_value, 1_000_000, 'weighted pipeline uses probability');

  const stage = await api('POST', `/api/v1/hotel/sales/opportunities/${opportunityId}/stage`, {
    token: tenant.token,
    body: { stage: 'proposal' },
  });
  assert.equal(stage.status, 200);
  const backwards = await api('POST', `/api/v1/hotel/sales/opportunities/${opportunityId}/stage`, {
    token: tenant.token,
    body: { stage: 'qualified' },
  });
  assert.equal(backwards.status, 409, 'opportunities cannot rewind a stage');
  assert.equal((backwards.body as { error: { code: string } }).error.code, 'OPPORTUNITY_TRANSITION');

  const unknownStage = await api('POST', `/api/v1/hotel/sales/opportunities/${opportunityId}/stage`, {
    token: tenant.token,
    body: { stage: 'teleported' },
  });
  assert.equal(unknownStage.status, 400, 'unknown stages are a validation error');

  const segment = await api('POST', '/api/v1/hotel/crm/segments', {
    token: tenant.token,
    body: { segmentName: 'Repeat corporate travellers', criteria: { minStays: 3 } },
  });
  assert.equal(segment.status, 200, JSON.stringify(segment.body));
  const segmentId = (segment.body as { id: string }).id;

  const interaction = await api('POST', '/api/v1/hotel/crm/interactions', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      segmentId,
      customerName: 'Zenith Energy travel desk',
      interactionType: 'call',
      summary: 'Discussed corporate rate for Q4',
      satisfactionScore: 4,
      followUpDue: isoDate(3),
    },
  });
  assert.equal(interaction.status, 200, JSON.stringify(interaction.body));
  const interactionId = (interaction.body as { id: string }).id;

  const completed = await api('POST', `/api/v1/hotel/crm/interactions/${interactionId}/complete`, {
    token: tenant.token,
  });
  assert.equal(completed.status, 200);

  const segments = await api('GET', '/api/v1/hotel/crm/segments', { token: tenant.token });
  assert.equal(segments.status, 200);
  const segmentRows = (segments.body as { segments: Array<{ interaction_count: number }> }).segments;
  assert.equal(segmentRows[0]?.interaction_count, 1);
});

test('channel allocation and revenue forecasting enforce yield guard rails', async () => {
  const tenant = await seedTenant();

  const allocation = await api('POST', '/api/v1/hotel/channels/inventory', {
    token: tenant.token,
    body: {
      hotelId: tenant.hotelId,
      roomTypeId: tenant.standardRoomTypeId,
      channelName: 'booking.com',
      allocationDate: isoDate(1),
      allocatedUnits: 4,
      netRate: 42_000,
    },
  });
  assert.equal(allocation.status, 200, JSON.stringify(allocation.body));
  const allocationId = (allocation.body as { id: string }).id;

  const duplicate = await api('POST', '/api/v1/hotel/channels/inventory', {
    token: tenant.token,
    body: {
      hotelId: tenant.hotelId,
      roomTypeId: tenant.standardRoomTypeId,
      channelName: 'booking.com',
      allocationDate: isoDate(1),
      allocatedUnits: 2,
      netRate: 40_000,
    },
  });
  assert.equal(duplicate.status, 409, 'one allocation per channel/room type/date');

  const oversold = await api('POST', `/api/v1/hotel/channels/inventory/${allocationId}/update`, {
    token: tenant.token,
    body: { soldUnits: 5 },
  });
  assert.equal(oversold.status, 400, 'sold units cannot exceed the allocation');

  const sold = await api('POST', `/api/v1/hotel/channels/inventory/${allocationId}/update`, {
    token: tenant.token,
    body: { soldUnits: 3, parityStatus: 'parity_failed' },
  });
  assert.equal(sold.status, 200, JSON.stringify(sold.body));

  const forecast = await api('POST', '/api/v1/hotel/revenue/forecasts', {
    token: tenant.token,
    body: {
      hotelId: tenant.hotelId,
      forecastDate: isoDate(1),
      occupancyPercent: 78,
      adr: 55_000,
      forecastRevenue: 165_000,
      strategy: 'Raise BAR rate on high demand',
    },
  });
  assert.equal(forecast.status, 200, JSON.stringify(forecast.body));
  const forecastId = (forecast.body as { id: string }).id;

  const approved = await api('POST', `/api/v1/hotel/revenue/forecasts/${forecastId}/approve`, {
    token: tenant.token,
  });
  assert.equal(approved.status, 200);

  const summary = await api('GET', '/api/v1/hotel/revenue/summary', { token: tenant.token });
  assert.equal(summary.status, 200);
  const hotels = (summary.body as { hotels: Array<{ forecast_days: number; forecast_revenue: number }> }).hotels;
  assert.equal(hotels[0]?.forecast_days, 1);
  assert.equal(hotels[0]?.forecast_revenue, 165_000);
});

test('spa, tours and call centre bookings respect capacity and overlap', async () => {
  const tenant = await seedTenant();

  const resource = await api('POST', '/api/v1/hotel/spa/resources', {
    token: tenant.token,
    body: { branchId: tenant.branchId, hotelId: tenant.hotelId, resourceName: 'Treatment room 1', resourceType: 'treatment_room' },
  });
  assert.equal(resource.status, 200, JSON.stringify(resource.body));
  const resourceId = (resource.body as { id: string }).id;

  const start = isoAt(24);
  const booking = await api('POST', '/api/v1/hotel/spa/bookings', {
    token: tenant.token,
    body: { hotelId: tenant.hotelId, resourceId, serviceName: 'Deep tissue massage', startsAt: start, durationMinutes: 60, price: 35_000 },
  });
  assert.equal(booking.status, 200, JSON.stringify(booking.body));

  const overlapping = await api('POST', '/api/v1/hotel/spa/bookings', {
    token: tenant.token,
    body: { hotelId: tenant.hotelId, resourceId, serviceName: 'Facial', startsAt: isoAt(24.5), durationMinutes: 60, price: 20_000 },
  });
  assert.equal(overlapping.status, 409, 'a therapist cannot be double-booked');
  assert.equal((overlapping.body as { error: { code: string } }).error.code, 'SPA_RESOURCE_UNAVAILABLE');

  const packageRes = await api('POST', '/api/v1/hotel/tours/packages', {
    token: tenant.token,
    body: { branchId: tenant.branchId, tourName: 'Lekki conservation walk', capacity: 10, pricePerPerson: 15_000 },
  });
  assert.equal(packageRes.status, 200, JSON.stringify(packageRes.body));
  const packageId = (packageRes.body as { id: string }).id;

  const tour = await api('POST', '/api/v1/hotel/tours/bookings', {
    token: tenant.token,
    body: { packageId, departureAt: isoAt(48), groupName: 'Zenith staff outing', pax: 8 },
  });
  assert.equal(tour.status, 200, JSON.stringify(tour.body));
  assert.equal((tour.body as { amount: number }).amount, 120_000);

  const oversubscribed = await api('POST', '/api/v1/hotel/tours/bookings', {
    token: tenant.token,
    body: { packageId, departureAt: isoAt(48), groupName: 'Extra guests', pax: 11 },
  });
  assert.equal(oversubscribed.status, 400, 'pax above package capacity is rejected');

  const call = await api('POST', '/api/v1/hotel/callcentre/calls', {
    token: tenant.token,
    body: {
      hotelId: tenant.hotelId,
      callerName: 'Mrs Bello',
      callerPhone: '+2348000000000',
      outcome: 'Rate enquiry',
      durationMinutes: 4.5,
    },
  });
  assert.equal(call.status, 200, JSON.stringify(call.body));

  const central = await api('POST', '/api/v1/hotel/callcentre/reservations', {
    token: tenant.token,
    body: {
      hotelId: tenant.hotelId,
      arrivalDate: isoDate(10),
      departureDate: isoDate(12),
      amount: 150_000,
    },
  });
  assert.equal(central.status, 200, JSON.stringify(central.body));
  const centralId = (central.body as { id: string }).id;
  const confirmed = await api('POST', `/api/v1/hotel/callcentre/reservations/${centralId}/status`, {
    token: tenant.token,
    body: { status: 'confirmed' },
  });
  assert.equal(confirmed.status, 200);

  const sameDay = await api('POST', '/api/v1/hotel/callcentre/reservations', {
    token: tenant.token,
    body: { hotelId: tenant.hotelId, arrivalDate: isoDate(5), departureDate: isoDate(5) },
  });
  assert.equal(sameDay.status, 400, 'a stay needs at least one night');
});

test('food safety checks record readings and corrective actions', async () => {
  const tenant = await seedTenant();

  const check = await api('POST', '/api/v1/hotel/foodsafety/checks', {
    token: tenant.token,
    body: { branchId: tenant.branchId, areaName: 'Cold room 1', checkType: 'temperature', scheduledAt: isoAt(-1) },
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const checkId = (check.body as { id: string }).id;

  const failLog = await api('POST', '/api/v1/hotel/foodsafety/logs', {
    token: tenant.token,
    body: { checkId, logType: 'cold_room_temp', reading: 9.5, status: 'fail', notes: 'Compressor fault' },
  });
  assert.equal(failLog.status, 200, JSON.stringify(failLog.body));

  const completed = await api('POST', `/api/v1/hotel/foodsafety/checks/${checkId}/complete`, {
    token: tenant.token,
    body: { result: 'fail', correctiveAction: 'Moved stock to cold room 2, logged engineering call' },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const checks = await api('GET', '/api/v1/hotel/foodsafety/checks', { token: tenant.token });
  assert.equal(checks.status, 200);
  const rows = (checks.body as { checks: Array<{ failed_readings: number; result: string }> }).checks;
  assert.equal(rows[0]?.failed_readings, 1);
  assert.equal(rows[0]?.result, 'fail');
});

test('corporate invoices post to the ledger, respect credit limits and settle once', async () => {
  const tenant = await seedTenant();
  const other = await seedTenant();

  const account = await api('POST', '/api/v1/hotel/corporate/accounts', {
    token: tenant.token,
    body: {
      branchId: tenant.branchId,
      accountName: 'Zenith Energy Ltd',
      billingEmail: 'ap@zenith.example',
      creditLimit: 500_000,
      priority: 'premium',
    },
  });
  assert.equal(account.status, 200, JSON.stringify(account.body));
  const accountId = (account.body as { id: string }).id;

  const invoice = await api('POST', '/api/v1/hotel/corporate/invoices', {
    token: tenant.token,
    body: { corporateAccountId: accountId, issueDate: isoDate(), dueDate: isoDate(30), amount: 300_000 },
  });
  assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
  const invoiceId = (invoice.body as { id: string }).id;

  const posted = await sql<{ account_code: string; debit: string; credit: string }>(
    `SELECT a.account_code, jl.debit, jl.credit
       FROM finance.journal_lines jl
       JOIN finance.accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1 ORDER BY jl.line_number`,
    [(invoice.body as { journalEntryId: string }).journalEntryId],
  );
  assert.equal(posted.length, 2);
  assert.equal(posted[0]!.account_code, '1100', 'guest receivable debited');
  assert.equal(Number(posted[0]!.debit), 300_000);
  assert.equal(posted[1]!.account_code, '4300', 'other revenue credited');

  const overLimit = await api('POST', '/api/v1/hotel/corporate/invoices', {
    token: tenant.token,
    body: { corporateAccountId: accountId, issueDate: isoDate(), dueDate: isoDate(30), amount: 250_000 },
  });
  assert.equal(overLimit.status, 409, 'credit limit blocks the second invoice');
  assert.equal((overLimit.body as { error: { code: string } }).error.code, 'CREDIT_LIMIT_EXCEEDED');

  const payment = await api('POST', `/api/v1/hotel/corporate/invoices/${invoiceId}/pay`, {
    token: tenant.token,
    body: { amount: 300_000, paymentDate: isoDate() },
  });
  assert.equal(payment.status, 200, JSON.stringify(payment.body));
  assert.equal((payment.body as { status: string }).status, 'paid');

  const secondPayment = await api('POST', `/api/v1/hotel/corporate/invoices/${invoiceId}/pay`, {
    token: tenant.token,
    body: { amount: 1000 },
  });
  assert.equal(secondPayment.status, 409, 'a paid invoice cannot be paid again');

  const balance = await api('GET', '/api/v1/hotel/corporate/accounts', { token: tenant.token });
  const accounts = (balance.body as { accounts: Array<{ current_balance: number; available_credit: number }> }).accounts;
  assert.equal(accounts[0]?.current_balance, 0);
  assert.equal(accounts[0]?.available_credit, 500_000);

  const foreign = await api('GET', '/api/v1/hotel/corporate/invoices', { token: other.token });
  assert.equal(foreign.status, 200);
  assert.equal((foreign.body as { invoices: unknown[] }).invoices.length, 0, 'invoices never leak across tenants');
});

test('franchise standards drive audits and corrective actions', async () => {
  const tenant = await seedTenant();

  const standard = await api('POST', '/api/v1/hotel/franchise/standards', {
    token: tenant.token,
    body: { standardName: 'Brand arrival experience', category: 'guest_journey', mandatory: true },
  });
  assert.equal(standard.status, 200, JSON.stringify(standard.body));
  const standardId = (standard.body as { id: string }).id;

  const audit = await api('POST', '/api/v1/hotel/franchise/audits', {
    token: tenant.token,
    body: { branchId: tenant.branchId, standardId, auditDate: isoDate(), auditor: 'Brand QA' },
  });
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  const auditId = (audit.body as { id: string }).id;

  const completed = await api('POST', `/api/v1/hotel/franchise/audits/${auditId}/complete`, {
    token: tenant.token,
    body: { score: 88, findings: 'Lobby signage outdated' },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const action = await api('POST', '/api/v1/hotel/franchise/actions', {
    token: tenant.token,
    body: { auditId, actionText: 'Order new lobby signage', ownerName: 'GM Office', dueDate: isoDate(14) },
  });
  assert.equal(action.status, 200, JSON.stringify(action.body));

  const standards = await api('GET', '/api/v1/hotel/franchise/standards', { token: tenant.token });
  assert.equal(standards.status, 200);
  const rows = (standards.body as { standards: Array<{ average_score: number; audit_count: number }> }).standards;
  assert.equal(rows[0]?.audit_count, 1);
  assert.equal(rows[0]?.average_score, 88);
});

test('restaurant reservations are conflict-safe and waitlist seating is one-way', async () => {
  const tenant = await seedTenant();

  const first = await api('POST', '/api/v1/restaurant/reservations', {
    token: tenant.token,
    body: {
      outletId: tenant.outletId,
      tableId: tenant.tableId,
      customerName: 'Mr Adeyemi',
      partySize: 2,
      reservationAt: isoAt(30),
      durationMinutes: 90,
    },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstId = (first.body as { id: string }).id;

  const overlap = await api('POST', '/api/v1/restaurant/reservations', {
    token: tenant.token,
    body: {
      outletId: tenant.outletId,
      tableId: tenant.tableId,
      customerName: 'Mrs Nwosu',
      partySize: 4,
      reservationAt: isoAt(30.5),
      durationMinutes: 90,
    },
  });
  assert.equal(overlap.status, 409, 'overlapping seating on one table is rejected');
  assert.equal((overlap.body as { error: { code: string } }).error.code, 'TABLE_ALREADY_RESERVED');

  const tooBig = await api('POST', '/api/v1/restaurant/reservations', {
    token: tenant.token,
    body: {
      outletId: tenant.outletId,
      tableId: tenant.tableId,
      customerName: 'Large party',
      partySize: 10,
      reservationAt: isoAt(60),
    },
  });
  assert.equal(tooBig.status, 409, 'party size cannot exceed table seats');

  const seated = await api('POST', `/api/v1/restaurant/reservations/${firstId}/status`, {
    token: tenant.token,
    body: { status: 'seated' },
  });
  assert.equal(seated.status, 200);
  const table = await sql<{ status: string }>('SELECT status FROM restaurant.tables WHERE id = $1', [tenant.tableId]);
  assert.equal(table[0]?.status, 'occupied', 'seating marks the table occupied');

  const entry = await api('POST', '/api/v1/restaurant/waitlist', {
    token: tenant.token,
    body: { outletId: tenant.outletId, customerName: 'Walk-in party', partySize: 3, quotedMinutes: 20 },
  });
  assert.equal(entry.status, 200, JSON.stringify(entry.body));
  const entryId = (entry.body as { id: string }).id;
  assert.equal((entry.body as { position: number }).position, 1);

  const seat = await api('POST', `/api/v1/restaurant/waitlist/${entryId}/seat`, { token: tenant.token });
  assert.equal(seat.status, 200);
  const seatAgain = await api('POST', `/api/v1/restaurant/waitlist/${entryId}/abandon`, { token: tenant.token });
  assert.equal(seatAgain.status, 409, 'a seated party cannot be abandoned');
});

test('restaurant customers earn and redeem loyalty points through an append-only ledger', async () => {
  const tenant = await seedTenant();

  const customer = await api('POST', '/api/v1/restaurant/customers', {
    token: tenant.token,
    body: { branchId: tenant.branchId, fullName: 'Chinelo Eze', phone: '+2348011111111', segment: 'vip' },
  });
  assert.equal(customer.status, 200, JSON.stringify(customer.body));
  const customerId = (customer.body as { id: string }).id;

  const earned = await api('POST', `/api/v1/restaurant/customers/${customerId}/loyalty/earn`, {
    token: tenant.token,
    body: { points: 320, reference: 'Order 1042' },
  });
  assert.equal(earned.status, 200, JSON.stringify(earned.body));
  assert.equal((earned.body as { balanceAfter: number }).balanceAfter, 320);

  const redeemed = await api('POST', `/api/v1/restaurant/customers/${customerId}/loyalty/redeem`, {
    token: tenant.token,
    body: { points: 120, reference: 'Free dessert' },
  });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.equal((redeemed.body as { balanceAfter: number }).balanceAfter, 200);

  const overdraw = await api('POST', `/api/v1/restaurant/customers/${customerId}/loyalty/redeem`, {
    token: tenant.token,
    body: { points: 500 },
  });
  assert.equal(overdraw.status, 409);
  assert.equal((overdraw.body as { error: { code: string } }).error.code, 'INSUFFICIENT_POINTS');

  const balance = await api('GET', `/api/v1/restaurant/customers/${customerId}/loyalty`, {
    token: tenant.token,
  });
  assert.equal(balance.status, 200);
  const body = balance.body as { pointsBalance: number; movements: Array<{ event_type: string; points: number }> };
  assert.equal(body.pointsBalance, 200);
  assert.equal(body.movements.length, 2);
  assert.equal(body.movements[0]?.event_type, 'redeem');
  assert.equal(body.movements[0]?.points, -120);

  const grants = await sql<{ can_update: boolean; can_delete: boolean }>(
    `SELECT has_table_privilege('hospitality_app', 'restaurant.loyalty_ledger', 'UPDATE') AS can_update,
            has_table_privilege('hospitality_app', 'restaurant.loyalty_ledger', 'DELETE') AS can_delete`,
  );
  assert.equal(grants[0]?.can_update, false, 'the runtime role cannot edit posted loyalty movements');
  assert.equal(grants[0]?.can_delete, false, 'the runtime role cannot delete posted loyalty movements');
});

test('promotions quote discounts with window and minimum-spend rules', async () => {
  const tenant = await seedTenant();

  const promo = await api('POST', '/api/v1/restaurant/promotions', {
    token: tenant.token,
    body: {
      promoCode: `EID${Date.now().toString(36).toUpperCase()}`,
      promoName: 'Eid celebration',
      discountPercent: 15,
      minimumSubtotal: 10_000,
      startsAt: isoAt(-1),
      endsAt: isoAt(72),
    },
  });
  assert.equal(promo.status, 200, JSON.stringify(promo.body));
  const promoId = (promo.body as { id: string }).id;
  const promoCode = (promo.body as { promoCode: string }).promoCode;

  const inactive = await api('POST', '/api/v1/restaurant/promotions/quote', {
    token: tenant.token,
    body: { promoCode, subtotal: 20_000 },
  });
  assert.equal(inactive.status, 409, 'draft promotions cannot be quoted');

  await api('POST', `/api/v1/restaurant/promotions/${promoId}/status`, {
    token: tenant.token,
    body: { status: 'active' },
  });

  const quote = await api('POST', '/api/v1/restaurant/promotions/quote', {
    token: tenant.token,
    body: { promoCode, subtotal: 20_000 },
  });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal((quote.body as { discount: number }).discount, 3_000);
  assert.equal((quote.body as { netSubtotal: number }).netSubtotal, 17_000);

  const belowMinimum = await api('POST', '/api/v1/restaurant/promotions/quote', {
    token: tenant.token,
    body: { promoCode, subtotal: 5_000 },
  });
  assert.equal(belowMinimum.status, 409);
  assert.equal((belowMinimum.body as { error: { code: string } }).error.code, 'PROMOTION_MINIMUM');

  const bothTypes = await api('POST', '/api/v1/restaurant/promotions', {
    token: tenant.token,
    body: {
      promoCode: `BAD${Date.now().toString(36).toUpperCase()}`,
      promoName: 'Invalid mix',
      discountPercent: 10,
      fixedDiscount: 500,
      startsAt: isoAt(-1),
      endsAt: isoAt(24),
    },
  });
  assert.equal(bothTypes.status, 400, 'a promotion cannot combine percentage and fixed discounts');
});

test('bar events sell tickets up to capacity and stop when cancelled', async () => {
  const tenant = await seedTenant();

  const event = await api('POST', '/api/v1/bar/events', {
    token: tenant.token,
    body: {
      barId: tenant.barId,
      eventName: 'Afrobeat night',
      eventDate: isoDate(7),
      startsAt: '20:00',
      capacity: 60,
      ticketPrice: 10_000,
    },
  });
  assert.equal(event.status, 200, JSON.stringify(event.body));
  const eventId = (event.body as { id: string }).id;

  const onSale = await api('POST', `/api/v1/bar/events/${eventId}/status`, {
    token: tenant.token,
    body: { status: 'on_sale' },
  });
  assert.equal(onSale.status, 200);

  const booking = await api('POST', `/api/v1/bar/events/${eventId}/bookings`, {
    token: tenant.token,
    body: { customerName: 'Tunde A.', seats: 4 },
  });
  assert.equal(booking.status, 200, JSON.stringify(booking.body));
  assert.equal((booking.body as { amount: number }).amount, 40_000);
  const bookingId = (booking.body as { id: string }).id;

  const oversell = await api('POST', `/api/v1/bar/events/${eventId}/bookings`, {
    token: tenant.token,
    body: { customerName: 'Large group', seats: 61 },
  });
  assert.equal(oversell.status, 409);
  assert.equal((oversell.body as { error: { code: string } }).error.code, 'BAR_EVENT_FULL');

  const cancelled = await api('POST', `/api/v1/bar/events/bookings/${bookingId}/cancel`, {
    token: tenant.token,
  });
  assert.equal(cancelled.status, 200);
  const cancelAgain = await api('POST', `/api/v1/bar/events/bookings/${bookingId}/cancel`, {
    token: tenant.token,
  });
  assert.equal(cancelAgain.status, 409);
});

test('food cost report costs recipes against inventory standard cost', async () => {
  const tenant = await seedTenant();

  const item = await sql<{ id: string }>(
    `INSERT INTO inventory.items (tenant_id, sku, item_name, base_unit, standard_cost)
     VALUES ($1, $2, 'Chicken thigh', 'kg', 3500) RETURNING id`,
    [tenant.tenantId, `CHK-${Date.now()}`],
  );
  const sku = await sql<{ sku: string }>('SELECT sku FROM inventory.items WHERE id = $1', [item[0]!.id]);

  const menuItem = await sql<{ id: string }>(
    `INSERT INTO restaurant.menu_items (tenant_id, menu_id, sku, item_name, price)
     VALUES ($1,$2,$3,'Grilled chicken plate',9000) RETURNING id`,
    [tenant.tenantId, tenant.menuId, `GRL-${Date.now()}`],
  );
  const recipe = await sql<{ id: string }>(
    `INSERT INTO restaurant.recipes (tenant_id, item_id, yield_quantity)
     VALUES ($1,$2,1) RETURNING id`,
    [tenant.tenantId, menuItem[0]!.id],
  );
  await sql(
    `INSERT INTO restaurant.recipe_ingredients (tenant_id, recipe_id, item_sku, quantity, wastage_percent)
     VALUES ($1,$2,$3,0.25,10)`,
    [tenant.tenantId, recipe[0]!.id, sku[0]!.sku],
  );

  const report = await api('GET', `/api/v1/restaurant/food-cost?outletId=${tenant.outletId}`, {
    token: tenant.token,
  });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  const items = (report.body as { items: Array<{ sku: string; plate_cost: number; margin_percent: number }> }).items;
  const plate = items.find((row) => row.sku.startsWith('GRL-'));
  assert.ok(plate, 'menu item appears in the cost report');
  assert.equal(plate.plate_cost, 962.5, 'plate cost includes wastage and standard cost');
  assert.ok(plate.margin_percent > 85, 'margin percent reflects plate cost');
});
