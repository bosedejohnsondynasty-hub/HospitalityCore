import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { config } from '../config.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { auditAction } from '../audit.js';
import { assertSegregationOfDuties } from '../auth.js';
import { GL, money, postJournal } from './finance.js';
import { hmacHex, newReference, safeEqualHex } from '../security.js';
import { chargeOrderToFolio as chargeRestaurant, recogniseOrderRevenue as recogniseRestaurant } from './restaurant.js';
import { chargeOrderToFolio as chargeBar, recogniseOrderRevenue as recogniseBar } from './bar.js';
import { settleFolio } from './hotel.js';
import { pool, withScopedLookup, withTenant } from '../db.js';

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------
export interface ProviderAdapter {
  code: 'paystack' | 'flutterwave' | 'cash' | 'bank_transfer' | 'pos_terminal';
  verifySignature(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseEvent(rawBody: string): {
    eventId: string;
    eventType: string;
    reference: string;
    amount: number;
    currency: string;
    status: 'success' | 'failed' | 'pending';
    providerTransactionId: string;
    channel?: string;
    fees?: number;
  };
}

const headerValue = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const paystack: ProviderAdapter = {
  code: 'paystack',
  verifySignature(rawBody, headers) {
    const secret = config.PAYSTACK_SECRET_KEY;
    const signature = headerValue(headers, 'x-paystack-signature');
    if (!secret || !signature) return false;
    return safeEqualHex(hmacHex('sha512', secret, rawBody), signature);
  },
  parseEvent(rawBody) {
    const body = JSON.parse(rawBody) as {
      event?: string;
      data?: {
        id?: number | string;
        reference?: string;
        amount?: number;
        currency?: string;
        status?: string;
        channel?: string;
        fees?: number;
      };
    };
    const data = body.data ?? {};
    if (!data.reference) throw badRequest('Paystack payload has no reference');
    return {
      eventId: String(data.id ?? data.reference),
      eventType: body.event ?? 'charge.success',
      reference: data.reference,
      amount: money(Number(data.amount ?? 0) / 100),
      currency: (data.currency ?? 'NGN').toUpperCase(),
      status: data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : 'pending',
      providerTransactionId: String(data.id ?? data.reference),
      channel: data.channel,
      fees: data.fees ? money(Number(data.fees) / 100) : 0,
    };
  },
};

const flutterwave: ProviderAdapter = {
  code: 'flutterwave',
  verifySignature(rawBody, headers) {
    const staticHash = config.FLUTTERWAVE_SECRET_HASH;
    const verifHash = headerValue(headers, 'verif-hash');
    if (staticHash && verifHash && safeEqualHex(staticHash, verifHash)) return true;
    const secret = config.FLUTTERWAVE_SECRET_KEY;
    const signature = headerValue(headers, 'flutterwave-signature');
    if (!secret || !signature) return false;
    return safeEqualHex(hmacHex('sha256', secret, rawBody), signature);
  },
  parseEvent(rawBody) {
    const body = JSON.parse(rawBody) as {
      event?: string;
      data?: {
        id?: number | string;
        tx_ref?: string;
        amount?: number | string;
        currency?: string;
        status?: string;
        payment_type?: string;
        app_fee?: number;
      };
    };
    const data = body.data ?? {};
    if (!data.tx_ref) throw badRequest('Flutterwave payload has no tx_ref');
    return {
      eventId: String(data.id ?? data.tx_ref),
      eventType: body.event ?? 'charge.completed',
      reference: data.tx_ref,
      amount: money(Number(data.amount ?? 0)),
      currency: (data.currency ?? 'NGN').toUpperCase(),
      status: data.status === 'successful' ? 'success' : data.status === 'failed' ? 'failed' : 'pending',
      providerTransactionId: String(data.id ?? data.tx_ref),
      channel: data.payment_type,
      fees: data.app_fee ? money(Number(data.app_fee)) : 0,
    };
  },
};

const adapters: Record<string, ProviderAdapter> = { paystack, flutterwave };

// ---------------------------------------------------------------------------
// Intent creation
// ---------------------------------------------------------------------------
async function resolvePayable(
  db: Queryable,
  tenantId: string,
  relatedType: string,
  relatedId: string,
): Promise<{ amount: number; currency: string; branchId: string; description: string }> {
  if (relatedType === 'restaurant_order') {
    const { rows } = await db.query<{
      total_amount: string;
      currency_code: string;
      branch_id: string;
      payment_status: string;
      order_number: string;
    }>(
      'SELECT total_amount, currency_code, branch_id, payment_status, order_number FROM restaurant.orders WHERE id = $1',
      [relatedId],
    );
    const row = rows[0];
    if (!row) throw notFound('Restaurant order not found');
    if (row.payment_status === 'paid') throw conflict('ORDER_ALREADY_PAID', 'Order is already paid');
    return {
      amount: Number(row.total_amount),
      currency: row.currency_code,
      branchId: row.branch_id,
      description: `Restaurant order ${row.order_number}`,
    };
  }
  if (relatedType === 'bar_order') {
    const { rows } = await db.query<{
      total_amount: string;
      currency_code: string;
      branch_id: string;
      payment_status: string;
      order_number: string;
    }>('SELECT total_amount, currency_code, branch_id, payment_status, order_number FROM bar.orders WHERE id = $1', [
      relatedId,
    ]);
    const row = rows[0];
    if (!row) throw notFound('Bar order not found');
    if (row.payment_status === 'paid') throw conflict('ORDER_ALREADY_PAID', 'Order is already paid');
    return {
      amount: Number(row.total_amount),
      currency: row.currency_code,
      branchId: row.branch_id,
      description: `Bar order ${row.order_number}`,
    };
  }
  if (relatedType === 'hotel_folio') {
    const { rows } = await db.query<{
      balance: string;
      currency_code: string;
      hotel_id: string;
      status: string;
      folio_number: string;
    }>(
      `SELECT f.balance, f.currency_code, f.hotel_id, f.status, f.folio_number
         FROM hotel.folios f WHERE f.id = $1`,
      [relatedId],
    );
    const row = rows[0];
    if (!row) throw notFound('Folio not found');
    if (row.status !== 'open') throw conflict('FOLIO_CLOSED', 'Folio is not open');
    if (Number(row.balance) <= 0) throw conflict('NOTHING_TO_PAY', 'Folio has no outstanding balance');
    const hotel = await db.query<{ branch_id: string }>('SELECT branch_id FROM hotel.hotels WHERE id = $1', [
      row.hotel_id,
    ]);
    return {
      amount: Number(row.balance),
      currency: row.currency_code,
      branchId: hotel.rows[0]!.branch_id,
      description: `Folio ${row.folio_number}`,
    };
  }
  throw badRequest(`Unsupported payment purpose: ${relatedType}`);
}

/**
 * Creates a payment intent. The amount is always derived from the server-side
 * payable, never from the request body.
 */
export async function createIntent(
  db: Queryable,
  ctx: AuthContext,
  input: {
    relatedType: 'restaurant_order' | 'bar_order' | 'hotel_folio';
    relatedId: string;
    provider: 'paystack' | 'flutterwave' | 'cash' | 'bank_transfer' | 'pos_terminal';
    customerEmail?: string;
    customerPhone?: string;
  },
) {
  const payable = await resolvePayable(db, ctx.tenantId, input.relatedType, input.relatedId);
  const reference = newReference('HC');

  if (['cash', 'bank_transfer', 'pos_terminal'].includes(input.provider)) {
    const intent = await db.query<{ id: string }>(
      `INSERT INTO payments.intents
         (tenant_id, branch_id, reference, provider, purpose, related_type, related_id, amount,
          currency_code, status, verified_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'successful',now(),$10)
       RETURNING id`,
      [
        ctx.tenantId,
        payable.branchId,
        reference,
        input.provider,
        input.relatedType,
        input.relatedType,
        input.relatedId,
        payable.amount,
        payable.currency,
        ctx.userId,
      ],
    );
    const intentId = intent.rows[0]!.id;
    await db.query(
      `INSERT INTO payments.transactions
         (tenant_id, intent_id, provider, provider_transaction_id, amount, currency_code, status, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,'successful',now())`,
      [ctx.tenantId, intentId, input.provider, `${input.provider}-${reference}`, payable.amount, payable.currency],
    );
    await applySuccessfulPayment(db, ctx.tenantId, ctx.userId, intentId, input.provider, {
      amount: payable.amount,
      currency: payable.currency,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      description: payable.description,
    });
    await auditAction(db, ctx, 'payment.received', 'payment_intent', intentId, {
      after: { provider: input.provider, amount: payable.amount, reference },
    });
    return { intentId, reference, status: 'successful', amount: payable.amount, currency: payable.currency };
  }

  const adapter = adapters[input.provider];
  if (!adapter) throw badRequest(`Unknown provider ${input.provider}`);
  const secretConfigured =
    input.provider === 'paystack'
      ? Boolean(config.PAYSTACK_SECRET_KEY)
      : Boolean(config.FLUTTERWAVE_SECRET_KEY || config.FLUTTERWAVE_SECRET_HASH);
  if (!secretConfigured && !config.PAYMENTS_ALLOW_OFFLINE_VERIFY) {
    throw new AppError(
      424,
      'PROVIDER_NOT_CONFIGURED',
      `${input.provider} credentials are not configured on this installation`,
    );
  }

  const intent = await db.query<{ id: string }>(
    `INSERT INTO payments.intents
       (tenant_id, branch_id, reference, provider, purpose, related_type, related_id, amount,
        currency_code, status, customer_email, customer_phone, checkout_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13)
     RETURNING id`,
    [
      ctx.tenantId,
      payable.branchId,
      reference,
      input.provider,
      input.relatedType,
      input.relatedType,
      input.relatedId,
      payable.amount,
      payable.currency,
      input.customerEmail ?? null,
      input.customerPhone ?? null,
      config.PAYMENTS_ALLOW_OFFLINE_VERIFY
        ? null
        : `${config.APP_ORIGIN}/pay/${reference}`,
      ctx.userId,
    ],
  );
  await db.query(
    "UPDATE restaurant.orders SET payment_status = 'pending' WHERE id = $1 AND payment_status = 'unpaid'",
    [input.relatedType === 'restaurant_order' ? input.relatedId : '00000000-0000-0000-0000-000000000000'],
  );
  await db.query(
    "UPDATE bar.orders SET payment_status = 'pending' WHERE id = $1 AND payment_status = 'unpaid'",
    [input.relatedType === 'bar_order' ? input.relatedId : '00000000-0000-0000-0000-000000000000'],
  );

  await auditAction(db, ctx, 'payment.intent_created', 'payment_intent', intent.rows[0]!.id, {
    after: { provider: input.provider, amount: payable.amount, reference },
  });

  return {
    intentId: intent.rows[0]!.id,
    reference,
    status: 'pending',
    amount: payable.amount,
    currency: payable.currency,
    checkoutUrl: config.PAYMENTS_ALLOW_OFFLINE_VERIFY ? null : `${config.APP_ORIGIN}/pay/${reference}`,
  };
}

/**
 * Applies the accounting and order effects of a verified successful payment.
 * Revenue is recognised with an exactly-once posting link per business document.
 */
async function applySuccessfulPayment(
  db: Queryable,
  tenantId: string,
  userId: string | null,
  intentId: string,
  provider: string,
  detail: {
    amount: number;
    currency: string;
    relatedType: string;
    relatedId: string;
    description: string;
  },
): Promise<void> {
  if (detail.relatedType === 'restaurant_order') {
    await recogniseRestaurant(db, { tenantId, userId }, detail.relatedId, GL.cash);
    await db.query("UPDATE restaurant.orders SET payment_status = 'paid' WHERE id = $1", [detail.relatedId]);
  } else if (detail.relatedType === 'bar_order') {
    await recogniseBar(db, { tenantId, userId }, detail.relatedId, GL.cash);
    await db.query("UPDATE bar.orders SET payment_status = 'paid', status = 'closed' WHERE id = $1", [
      detail.relatedId,
    ]);
  } else if (detail.relatedType === 'hotel_folio') {
    // Settlement clears guest receivable; the charge itself already recognised revenue.
    await db.query(
      `INSERT INTO hotel.folio_entries
         (tenant_id, hotel_id, folio_id, entry_type, description, amount, currency_code,
          source_type, source_id, business_date, posted_by)
       SELECT $1, f.hotel_id, f.id, 'payment', $2, $3, f.currency_code, 'payment_intent', $4, current_date, $5
         FROM hotel.folios f WHERE f.id = $6`,
      [tenantId, `Gateway payment (${provider})`, -money(detail.amount), intentId, userId, detail.relatedId],
    );
    await postJournal(db, {
      tenantId,
      entryDate: today(),
      description: `Payment settlement ${intentId}`,
      sourceType: 'payment_intent',
      sourceId: intentId,
      purpose: 'settlement',
      lines: [
        { accountCode: GL.cash, debit: money(detail.amount) },
        { accountCode: GL.guestReceivable, credit: money(detail.amount) },
      ],
      postedBy: userId,
    });
  }
  await db.query('UPDATE payments.intents SET status = $2, verified_at = now() WHERE id = $1', [
    intentId,
    'successful',
  ]);
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
export interface WebhookResult {
  httpStatus: number;
  body: { status: string; detail?: string };
}

/**
 * Verifies and applies a provider webhook.
 *
 * Order is deliberate: signature -> replay guard -> amount/currency/reference
 * checks -> effects. A customer returning from a checkout page never marks an
 * order paid; only this server side path does.
 */
export async function handleWebhook(
  provider: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookResult> {
  const adapter = adapters[provider];
  if (!adapter) return { httpStatus: 404, body: { status: 'unknown_provider' } };
  if (!adapter.verifySignature(rawBody, headers)) {
    return { httpStatus: 401, body: { status: 'invalid_signature' } };
  }

  let event;
  try {
    event = adapter.parseEvent(rawBody);
  } catch {
    return { httpStatus: 400, body: { status: 'invalid_payload' } };
  }

  const intent = await withScopedLookup(async (db) => {
    const { rows } = await db.query<{
      intent_id: string;
      tenant_id: string;
      amount: string;
      currency_code: string;
      status: string;
      provider: string;
      related_type: string;
      related_id: string;
      purpose: string;
    }>('SELECT * FROM payments_intent_lookup($1)', [event.reference]);
    return rows[0];
  });

  if (!intent) return { httpStatus: 404, body: { status: 'unknown_reference' } };

  return withTenant(intent.tenant_id, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO payments.webhook_events
         (tenant_id, provider, event_id, event_type, signature_valid, payload)
       VALUES ($1,$2,$3,$4,true,$5::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [intent.tenant_id, provider, event.eventId, event.eventType, rawBody],
    );
    if (!inserted.rows[0]) {
      return { httpStatus: 200, body: { status: 'duplicate', detail: 'Event already processed' } };
    }
    const webhookRowId = inserted.rows[0].id;

    const mismatch: string[] = [];
    if (intent.status === 'successful') mismatch.push('intent already successful');
    if (money(event.amount) !== money(Number(intent.amount))) mismatch.push('amount mismatch');
    if (event.currency !== intent.currency_code) mismatch.push('currency mismatch');
    if (provider !== intent.provider) mismatch.push('provider mismatch');

    if (mismatch.length > 0) {
      await db.query(
        "UPDATE payments.webhook_events SET result = 'rejected', result_detail = $2, processed_at = now() WHERE id = $1",
        [webhookRowId, mismatch.join('; ')],
      );
      await db.query("UPDATE payments.intents SET status = 'failed' WHERE id = $1 AND status <> 'successful'", [
        intent.intent_id,
      ]);
      return {
        httpStatus: 400,
        body: { status: 'rejected', detail: mismatch.join('; ') },
      };
    }

    if (event.status !== 'success') {
      await db.query(
        "UPDATE payments.webhook_events SET result = 'ignored', result_detail = $2, processed_at = now() WHERE id = $1",
        [webhookRowId, `payment status ${event.status}`],
      );
      if (event.status === 'failed') {
        await db.query("UPDATE payments.intents SET status = 'failed' WHERE id = $1", [intent.intent_id]);
      }
      return { httpStatus: 200, body: { status: 'ignored' } };
    }

    const tx = await db.query(
      `INSERT INTO payments.transactions
         (tenant_id, intent_id, provider, provider_transaction_id, amount, currency_code, status,
          channel, gateway_fee, paid_at, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,'successful',$7,$8,now(),$9::jsonb)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING
       RETURNING id`,
      [
        intent.tenant_id,
        intent.intent_id,
        provider,
        event.providerTransactionId,
        event.amount,
        event.currency,
        event.channel ?? null,
        event.fees ?? 0,
        rawBody,
      ],
    );

    await db.query(
      `UPDATE payments.intents
          SET status = 'successful', verified_at = now(), provider_reference = $2
        WHERE id = $1`,
      [intent.intent_id, event.providerTransactionId],
    );
    await applySuccessfulPayment(db, intent.tenant_id, null, intent.intent_id, provider, {
      amount: Number(intent.amount),
      currency: intent.currency_code,
      relatedType: intent.related_type,
      relatedId: intent.related_id,
      description: intent.purpose,
    });

    if ((event.fees ?? 0) > 0) {
      await postJournal(db, {
        tenantId: intent.tenant_id,
        entryDate: today(),
        description: `Gateway fee for ${event.reference}`,
        sourceType: 'payment_fee',
        sourceId: intent.intent_id,
        purpose: 'fee',
        lines: [
          { accountCode: GL.gatewayFees, debit: event.fees! },
          { accountCode: GL.cash, credit: event.fees! },
        ],
      }).catch((err) => {
        if ((err as { code?: string }).code !== 'DUPLICATE_POSTING') throw err;
      });
    }

    await db.query(
      "UPDATE payments.webhook_events SET result = 'processed', processed_at = now(), tenant_id = $2 WHERE id = $1",
      [webhookRowId, intent.tenant_id],
    );
    if (tx.rowCount === 0) {
      return { httpStatus: 200, body: { status: 'duplicate_transaction' } };
    }
    return { httpStatus: 200, body: { status: 'processed' } };
  });
}

/** Provider-agnostic verification used by the reconciliation screen. */
export async function verifyIntent(db: Queryable, intentId: string) {
  const { rows } = await db.query(
    `SELECT i.id, i.reference, i.provider, i.amount, i.currency_code, i.status, i.related_type,
            i.related_id, i.verified_at, i.checkout_url,
            (SELECT count(*) FROM payments.transactions t WHERE t.intent_id = i.id) AS transaction_count
       FROM payments.intents i WHERE i.id = $1`,
    [intentId],
  );
  if (!rows[0]) throw notFound('Payment intent not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Refunds (four-eyes)
// ---------------------------------------------------------------------------
export async function requestRefund(
  db: Queryable,
  ctx: AuthContext,
  input: { intentId: string; amount: number; reason: string },
) {
  if (!(input.amount > 0)) throw badRequest('Refund amount must be greater than zero');
  if (!input.reason?.trim()) throw badRequest('A reason is required for a refund');
  const intent = await db.query<{ amount: string; status: string }>(
    'SELECT amount, status FROM payments.intents WHERE id = $1',
    [input.intentId],
  );
  const row = intent.rows[0];
  if (!row) throw notFound('Payment intent not found');
  if (row.status !== 'successful') throw conflict('PAYMENT_NOT_SETTLED', 'Only successful payments can be refunded');
  if (money(input.amount) > money(Number(row.amount))) {
    throw badRequest('Refund cannot exceed the settled amount');
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payments.refunds (tenant_id, intent_id, amount, reason, requested_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.tenantId, input.intentId, money(input.amount), input.reason, ctx.userId],
  );
  await auditAction(db, ctx, 'payment.refund_requested', 'refund', rows[0]!.id, {
    after: { intentId: input.intentId, amount: input.amount },
  });
  return rows[0]!;
}

export async function approveRefund(
  db: Queryable,
  ctx: AuthContext,
  input: { refundId: string; approve: boolean; note?: string },
) {
  const refund = await db.query<{
    id: string;
    intent_id: string;
    amount: string;
    status: string;
    requested_by: string | null;
  }>('SELECT id, intent_id, amount, status, requested_by FROM payments.refunds WHERE id = $1 FOR UPDATE', [
    input.refundId,
  ]);
  const row = refund.rows[0];
  if (!row) throw notFound('Refund not found');
  if (row.status !== 'requested') throw conflict('REFUND_NOT_PENDING', `Refund is ${row.status}`);
  assertSegregationOfDuties(ctx.userId, row.requested_by ?? '', 'Refund approval');

  if (!input.approve) {
    await db.query(
      "UPDATE payments.refunds SET status = 'rejected', approved_by = $2, approved_at = now(), rejection_reason = $3 WHERE id = $1",
      [input.refundId, ctx.userId, input.note ?? 'Rejected'],
    );
    await auditAction(db, ctx, 'payment.refund_rejected', 'refund', input.refundId, {
      metadata: { note: input.note },
    });
    return { refundId: input.refundId, status: 'rejected' };
  }

  await db.query(
    "UPDATE payments.refunds SET status = 'processed', approved_by = $2, approved_at = now(), processed_at = now(), provider_refund_id = $3 WHERE id = $1",
    [input.refundId, ctx.userId, `RF-${input.refundId.slice(0, 8)}`],
  );

  const intent = await db.query<{ related_type: string; related_id: string; reference: string }>(
    'SELECT related_type, related_id, reference FROM payments.intents WHERE id = $1',
    [row.intent_id],
  );
  const relatedType = intent.rows[0]!.related_type;
  const relatedId = intent.rows[0]!.related_id;
  await postJournal(db, {
    tenantId: ctx.tenantId,
    entryDate: today(),
    description: `Refund ${intent.rows[0]!.reference}`,
    sourceType: 'refund',
    sourceId: input.refundId,
    purpose: 'refund',
    lines: [
      {
        accountCode: relatedType === 'bar_order' ? GL.barRevenue : relatedType === 'restaurant_order' ? GL.restaurantRevenue : GL.guestReceivable,
        debit: money(Number(row.amount)),
      },
      { accountCode: GL.cash, credit: money(Number(row.amount)) },
    ],
    postedBy: ctx.userId,
  });
  await db.query(
    "UPDATE payments.intents SET status = 'successful' WHERE id = $1 AND status = 'successful'",
    [row.intent_id],
  );
  if (relatedType === 'restaurant_order') {
    await db.query("UPDATE restaurant.orders SET payment_status = 'refunded' WHERE id = $1", [relatedId]);
  } else if (relatedType === 'bar_order') {
    await db.query("UPDATE bar.orders SET payment_status = 'refunded' WHERE id = $1", [relatedId]);
  }
  await auditAction(db, ctx, 'payment.refund_processed', 'refund', input.refundId, {
    after: { amount: Number(row.amount), intentId: row.intent_id },
  });
  return { refundId: input.refundId, status: 'processed', amount: Number(row.amount) };
}

/**
 * Payment intent for an unauthenticated QR order.
 *
 * The amount comes from the order, not the request, and only restaurant orders
 * in a payable state can be paid this way.
 */
export async function createPublicOrderIntent(
  db: Queryable,
  tenantId: string,
  orderId: string,
  provider: 'paystack' | 'flutterwave',
) {
  const order = await db.query<{ total_amount: string; currency_code: string; branch_id: string; payment_status: string; order_number: string }>(
    'SELECT total_amount, currency_code, branch_id, payment_status, order_number FROM restaurant.orders WHERE id = $1',
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound('Order not found');
  if (row.payment_status === 'paid') throw conflict('ORDER_ALREADY_PAID', 'Order is already paid');

  const secretConfigured =
    provider === 'paystack'
      ? Boolean(config.PAYSTACK_SECRET_KEY)
      : Boolean(config.FLUTTERWAVE_SECRET_KEY || config.FLUTTERWAVE_SECRET_HASH);
  if (!secretConfigured && !config.PAYMENTS_ALLOW_OFFLINE_VERIFY) {
    throw new AppError(424, 'PROVIDER_NOT_CONFIGURED', `${provider} is not configured`);
  }

  const reference = newReference('HCPUB');
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payments.intents
       (tenant_id, branch_id, reference, provider, purpose, related_type, related_id, amount,
        currency_code, status, checkout_url)
     VALUES ($1,$2,$3,$4,'restaurant_order','restaurant_order',$5,$6,$7,'pending',$8)
     RETURNING id`,
    [
      tenantId,
      row.branch_id,
      reference,
      provider,
      orderId,
      Number(row.total_amount),
      row.currency_code,
      config.PAYMENTS_ALLOW_OFFLINE_VERIFY ? null : `${config.APP_ORIGIN}/pay/${reference}`,
    ],
  );
  await db.query("UPDATE restaurant.orders SET payment_status = 'pending' WHERE id = $1 AND payment_status = 'unpaid'", [
    orderId,
  ]);

  return {
    intentId: intent.rows[0]!.id,
    reference,
    amount: Number(row.total_amount),
    currency: row.currency_code,
    status: 'pending',
    checkoutUrl: config.PAYMENTS_ALLOW_OFFLINE_VERIFY ? null : `${config.APP_ORIGIN}/pay/${reference}`,
    instructions: 'Complete payment on the provider checkout. The order is only marked paid after a verified webhook.',
  };
}

export { chargeRestaurant, chargeBar, settleFolio, pool, forbidden };
