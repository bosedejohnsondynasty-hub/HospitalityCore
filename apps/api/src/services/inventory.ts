import type { Queryable } from '../db.js';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { auditAction } from '../audit.js';
import { GL, money, postJournal } from './finance.js';

export async function listItems(db: Queryable) {
  const { rows } = await db.query(
    `SELECT id, sku, item_name, category, base_unit, standard_cost, reorder_level, is_batch_tracked
       FROM inventory.items WHERE status = 'active' ORDER BY category, item_name`,
  );
  return rows.map((r) => ({ ...r, standard_cost: Number(r.standard_cost as string) }));
}

export async function createItem(
  db: Queryable,
  ctx: AuthContext,
  input: {
    sku: string;
    name: string;
    category: string;
    baseUnit?: string;
    standardCost?: number;
    reorderLevel?: number;
    isBatchTracked?: boolean;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO inventory.items
       (tenant_id, sku, item_name, category, base_unit, standard_cost, reorder_level, is_batch_tracked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      ctx.tenantId,
      input.sku,
      input.name,
      input.category,
      input.baseUnit ?? 'unit',
      money(input.standardCost ?? 0),
      input.reorderLevel ?? 0,
      input.isBatchTracked ?? false,
    ],
  );
  await auditAction(db, ctx, 'inventory.item_created', 'inventory_item', rows[0]!.id, {
    after: { sku: input.sku },
  });
  return rows[0]!;
}

export async function listStores(db: Queryable) {
  const { rows } = await db.query(
    `SELECT s.id, s.store_code, s.store_name, s.store_type, b.branch_name
       FROM inventory.stores s JOIN platform.branches b ON b.id = s.branch_id
      WHERE s.status = 'active' ORDER BY b.branch_name, s.store_name`,
  );
  return rows;
}

export async function stockBalances(db: Queryable, storeId?: string) {
  const { rows } = await db.query(
    `SELECT sb.store_id, st.store_name, sb.item_id, i.sku, i.item_name, sb.quantity, sb.average_cost
       FROM inventory.stock_balances sb
       JOIN inventory.items i ON i.id = sb.item_id
       JOIN inventory.stores st ON st.id = sb.store_id
      WHERE ($1::uuid IS NULL OR sb.store_id = $1)
      ORDER BY i.item_name`,
    [storeId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    quantity: Number(r.quantity as string),
    average_cost: Number(r.average_cost as string),
  }));
}

export async function listMovements(db: Queryable, itemId?: string, limit = 100) {
  const { rows } = await db.query(
    `SELECT m.id, m.movement_type, m.quantity, m.unit_cost, m.reference_type, m.reference_id,
            m.created_at, i.sku, i.item_name, st.store_name
       FROM inventory.movements m
       JOIN inventory.items i ON i.id = m.item_id
       JOIN inventory.stores st ON st.id = m.store_id
      WHERE ($1::uuid IS NULL OR m.item_id = $1)
      ORDER BY m.created_at DESC LIMIT $2`,
    [itemId ?? null, limit],
  );
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity as string) }));
}

/**
 * Receives stock into a store.
 *
 * Each receipt line creates an append-only ledger movement (driving stock
 * balances) and the whole receipt posts one balanced journal: inventory debit
 * against accounts payable.
 */
export async function receiveStock(
  db: Queryable,
  ctx: AuthContext,
  input: {
    storeId: string;
    items: Array<{ itemId: string; quantity: number; unitCost: number; batchNo?: string; expiryDate?: string }>;
    supplierId?: string;
    purchaseOrderId?: string;
    reference?: string;
    supplierInvoiceNumber?: string;
  },
) {
  if (input.items.length === 0) throw badRequest('A goods receipt needs at least one line');
  const store = await db.query<{ id: string; branch_id: string }>(
    'SELECT id, branch_id FROM inventory.stores WHERE id = $1',
    [input.storeId],
  );
  const storeRow = store.rows[0];
  if (!storeRow) throw notFound('Store not found');

  let supplierId = input.supplierId;
  if (!supplierId && input.purchaseOrderId) {
    const po = await db.query<{ supplier_id: string }>(
      'SELECT supplier_id FROM procurement.purchase_orders WHERE id = $1',
      [input.purchaseOrderId],
    );
    supplierId = po.rows[0]?.supplier_id;
  }
  if (!supplierId) throw badRequest('A supplier or purchase order is required for a goods receipt');

  const grnNumber = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'grn', 'GRN-') AS number",
    [ctx.tenantId],
  );
  const grn = await db.query<{ id: string }>(
    `INSERT INTO procurement.goods_receipts
       (tenant_id, branch_id, store_id, purchase_order_id, supplier_id, grn_number,
        received_by, supplier_invoice_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      ctx.tenantId,
      storeRow.branch_id,
      input.storeId,
      input.purchaseOrderId ?? null,
      supplierId,
      grnNumber.rows[0]!.number,
      ctx.userId,
      input.supplierInvoiceNumber ?? null,
    ],
  );
  const grnId = grn.rows[0]!.id;

  let totalValue = 0;
  for (const line of input.items) {
    if (!(line.quantity > 0)) throw badRequest('Received quantity must be greater than zero');
    await db.query(
      `INSERT INTO procurement.goods_receipt_lines
         (tenant_id, goods_receipt_id, item_id, quantity, unit_cost, batch_no, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ctx.tenantId,
        grnId,
        line.itemId,
        line.quantity,
        money(line.unitCost),
        line.batchNo ?? null,
        line.expiryDate ?? null,
      ],
    );
    await db.query(
      `INSERT INTO inventory.movements
         (tenant_id, branch_id, store_id, item_id, movement_type, quantity, unit_cost, total_cost,
          reference_type, reference_id, batch_no, expiry_date, notes, performed_by)
       VALUES ($1,$2,$3,$4,'receipt',$5,$6,$7,'goods_receipt',$8,$9,$10,$11,$12)`,
      [
        ctx.tenantId,
        storeRow.branch_id,
        input.storeId,
        line.itemId,
        money(line.quantity),
        money(line.unitCost),
        money(line.quantity * line.unitCost),
        grnId,
        line.batchNo ?? null,
        line.expiryDate ?? null,
        input.reference ?? null,
        ctx.userId,
      ],
    );
    totalValue = money(totalValue + line.quantity * line.unitCost);

    if (input.purchaseOrderId) {
      await db.query(
        `UPDATE procurement.purchase_order_lines
            SET received_quantity = received_quantity + $3
          WHERE purchase_order_id = $1 AND item_id = $2`,
        [input.purchaseOrderId, line.itemId, line.quantity],
      );
    }
  }

  let journalEntryId: string | null = null;
  if (totalValue > 0) {
    journalEntryId = await postJournal(db, {
      tenantId: ctx.tenantId,
      branchId: storeRow.branch_id,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Goods received ${grnNumber.rows[0]!.number}`,
      sourceType: 'goods_receipt',
      sourceId: grnId,
      purpose: 'receipt',
      lines: [
        { accountCode: GL.inventory, debit: totalValue },
        { accountCode: GL.accountsPayable, credit: totalValue },
      ],
      postedBy: ctx.userId,
    });
  }

  if (input.purchaseOrderId) {
    await db.query(
      `UPDATE procurement.purchase_orders po
          SET status = CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM procurement.purchase_order_lines l
                   WHERE l.purchase_order_id = po.id AND l.received_quantity < l.quantity
                ) THEN 'received' ELSE 'partially_received' END
        WHERE po.id = $1 AND po.status IN ('approved','partially_received')`,
      [input.purchaseOrderId],
    );
  }

  await auditAction(db, ctx, 'inventory.goods_received', 'goods_receipt', grnId, {
    after: { grnNumber: grnNumber.rows[0]!.number, totalValue },
    branchId: storeRow.branch_id,
  });
  return { grnId, grnNumber: grnNumber.rows[0]!.number, totalValue, journalEntryId };
}

export async function issueStock(
  db: Queryable,
  ctx: AuthContext,
  input: {
    storeId: string;
    items: Array<{ itemId: string; quantity: number }>;
    reason: string;
    costAccountCode?: string;
  },
) {
  if (input.items.length === 0) throw badRequest('An issue needs at least one line');
  const store = await db.query<{ branch_id: string }>(
    'SELECT branch_id FROM inventory.stores WHERE id = $1',
    [input.storeId],
  );
  const storeRow = store.rows[0];
  if (!storeRow) throw notFound('Store not found');

  let totalValue = 0;
  for (const line of input.items) {
    if (!(line.quantity > 0)) throw badRequest('Issued quantity must be greater than zero');
    const item = await db.query<{ standard_cost: string }>(
      'SELECT standard_cost FROM inventory.items WHERE id = $1',
      [line.itemId],
    );
    const cost = Number(item.rows[0]?.standard_cost ?? 0);
    await db.query(
      `INSERT INTO inventory.movements
         (tenant_id, branch_id, store_id, item_id, movement_type, quantity, unit_cost, total_cost,
          reference_type, reference_id, notes, performed_by)
       VALUES ($1,$2,$3,$4,'issue',$5,$6,$7,'manual_issue',$8,$9,$10)`,
      [
        ctx.tenantId,
        storeRow.branch_id,
        input.storeId,
        line.itemId,
        -money(line.quantity),
        cost,
        money(line.quantity * cost),
        `${input.storeId}:${Date.now()}:${line.itemId}`,
        input.reason,
        ctx.userId,
      ],
    );
    totalValue = money(totalValue + line.quantity * cost);
  }

  if (totalValue > 0) {
    await postJournal(db, {
      tenantId: ctx.tenantId,
      branchId: storeRow.branch_id,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Stock issue: ${input.reason}`,
      lines: [
        { accountCode: input.costAccountCode ?? GL.foodCost, debit: totalValue },
        { accountCode: GL.inventory, credit: totalValue },
      ],
      postedBy: ctx.userId,
    });
  }
  await auditAction(db, ctx, 'inventory.issued', 'store', input.storeId, {
    after: { totalValue, reason: input.reason },
  });
  return { totalValue };
}

export async function adjustStock(
  db: Queryable,
  ctx: AuthContext,
  input: { storeId: string; itemId: string; quantity: number; reason: string },
) {
  if (input.quantity === 0) throw badRequest('Adjustment quantity cannot be zero');
  if (!input.reason?.trim()) throw badRequest('A reason is required for a stock adjustment');
  const store = await db.query<{ branch_id: string }>(
    'SELECT branch_id FROM inventory.stores WHERE id = $1',
    [input.storeId],
  );
  if (!store.rows[0]) throw notFound('Store not found');
  const item = await db.query<{ standard_cost: string }>(
    'SELECT standard_cost FROM inventory.items WHERE id = $1',
    [input.itemId],
  );
  const cost = Number(item.rows[0]?.standard_cost ?? 0);

  await db.query(
    `INSERT INTO inventory.movements
       (tenant_id, branch_id, store_id, item_id, movement_type, quantity, unit_cost, total_cost,
        reference_type, reference_id, notes, performed_by)
     VALUES ($1,$2,$3,$4,'adjustment',$5,$6,$7,'stock_adjustment',$8,$9,$10)`,
    [
      ctx.tenantId,
      store.rows[0].branch_id,
      input.storeId,
      input.itemId,
      money(input.quantity),
      cost,
      money(Math.abs(input.quantity) * cost),
      `${input.storeId}:${Date.now()}:${input.itemId}`,
      input.reason,
      ctx.userId,
    ],
  );
  if (input.quantity < 0 && cost > 0) {
    await postJournal(db, {
      tenantId: ctx.tenantId,
      branchId: store.rows[0].branch_id,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Stock adjustment: ${input.reason}`,
      lines: [
        { accountCode: GL.foodCost, debit: money(Math.abs(input.quantity) * cost) },
        { accountCode: GL.inventory, credit: money(Math.abs(input.quantity) * cost) },
      ],
      postedBy: ctx.userId,
    });
  }
  await auditAction(db, ctx, 'inventory.adjusted', 'inventory_item', input.itemId, {
    after: { quantity: input.quantity, reason: input.reason, storeId: input.storeId },
  });
  return { adjusted: true };
}

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------
export async function createSupplier(
  db: Queryable,
  ctx: AuthContext,
  input: { code: string; name: string; email?: string; phone?: string; paymentTermsDays?: number },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO procurement.suppliers
       (tenant_id, supplier_code, supplier_name, email, phone, payment_terms_days)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, input.code, input.name, input.email ?? null, input.phone ?? null, input.paymentTermsDays ?? 30],
  );
  return rows[0]!;
}

export async function listSuppliers(db: Queryable) {
  const { rows } = await db.query(
    'SELECT id, supplier_code, supplier_name, email, phone, payment_terms_days, status FROM procurement.suppliers ORDER BY supplier_name',
  );
  return rows;
}

export async function createPurchaseOrder(
  db: Queryable,
  ctx: AuthContext,
  input: {
    branchId: string;
    supplierId: string;
    items: Array<{ itemId: string; quantity: number; unitCost: number }>;
    expectedDate?: string;
    notes?: string;
  },
) {
  if (input.items.length === 0) throw badRequest('A purchase order needs at least one line');
  const poNumber = await db.query<{ number: string }>(
    "SELECT app_next_document_number($1, 'purchase_order', 'PO-') AS number",
    [ctx.tenantId],
  );
  const subtotal = money(input.items.reduce((s, i) => s + i.quantity * i.unitCost, 0));
  const po = await db.query<{ id: string }>(
    `INSERT INTO procurement.purchase_orders
       (tenant_id, branch_id, supplier_id, po_number, status, expected_date, subtotal, tax_total,
        total_amount, requested_by, notes)
     VALUES ($1,$2,$3,$4,'pending_approval',$5,$6,0,$7,$8,$9) RETURNING id`,
    [
      ctx.tenantId,
      input.branchId,
      input.supplierId,
      poNumber.rows[0]!.number,
      input.expectedDate ?? null,
      subtotal,
      subtotal,
      ctx.userId,
      input.notes ?? null,
    ],
  );
  const poId = po.rows[0]!.id;
  for (const line of input.items) {
    await db.query(
      `INSERT INTO procurement.purchase_order_lines
         (tenant_id, purchase_order_id, item_id, quantity, unit_cost, line_total)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, poId, line.itemId, line.quantity, money(line.unitCost), money(line.quantity * line.unitCost)],
    );
  }
  return { poId, poNumber: poNumber.rows[0]!.number, total: subtotal, status: 'pending_approval' };
}

export async function approvePurchaseOrder(
  db: Queryable,
  ctx: AuthContext,
  poId: string,
) {
  const po = await db.query<{ status: string; requested_by: string | null; po_number: string }>(
    'SELECT status, requested_by, po_number FROM procurement.purchase_orders WHERE id = $1 FOR UPDATE',
    [poId],
  );
  const row = po.rows[0];
  if (!row) throw notFound('Purchase order not found');
  if (row.status !== 'pending_approval') {
    throw conflict('PO_NOT_PENDING', `Purchase order is ${row.status}`);
  }
  if (row.requested_by === ctx.userId) {
    throw conflict('SEGREGATION_OF_DUTIES', 'A purchase order must be approved by a different user');
  }
  await db.query(
    "UPDATE procurement.purchase_orders SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
    [poId, ctx.userId],
  );
  await auditAction(db, ctx, 'procurement.purchase_order_approved', 'purchase_order', poId, {
    after: { poNumber: row.po_number },
  });
  return { poId, status: 'approved' };
}

export async function createSupplierInvoice(
  db: Queryable,
  ctx: AuthContext,
  input: {
    supplierId: string;
    invoiceNumber: string;
    invoiceDate: string;
    amount: number;
    taxAmount?: number;
    purchaseOrderId?: string;
    goodsReceiptId?: string;
    dueDate?: string;
  },
) {
  let matchStatus: 'matched' | 'exception' | 'unmatched' = 'unmatched';
  let discrepancy: string | null = null;

  if (input.purchaseOrderId) {
    const po = await db.query<{ total_amount: string; status: string }>(
      'SELECT total_amount, status FROM procurement.purchase_orders WHERE id = $1',
      [input.purchaseOrderId],
    );
    if (!po.rows[0]) throw notFound('Purchase order not found');
    const received = await db.query<{ value: string }>(
      `SELECT coalesce(sum(l.received_quantity * l.unit_cost), 0) AS value
         FROM procurement.purchase_order_lines l WHERE l.purchase_order_id = $1`,
      [input.purchaseOrderId],
    );
    const receivedValue = money(Number(received.rows[0]!.value));
    const invoiceValue = money(input.amount + (input.taxAmount ?? 0));
    if (receivedValue === 0) {
      matchStatus = 'exception';
      discrepancy = 'No goods received against this purchase order';
    } else if (money(receivedValue) !== invoiceValue) {
      matchStatus = 'exception';
      discrepancy = `Invoice ${invoiceValue} does not match received value ${receivedValue}`;
    } else {
      matchStatus = 'matched';
    }
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO procurement.supplier_invoices
       (tenant_id, supplier_id, purchase_order_id, goods_receipt_id, invoice_number, invoice_date,
        due_date, amount, tax_amount, status, match_status, discrepancy_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11) RETURNING id`,
    [
      ctx.tenantId,
      input.supplierId,
      input.purchaseOrderId ?? null,
      input.goodsReceiptId ?? null,
      input.invoiceNumber,
      input.invoiceDate,
      input.dueDate ?? null,
      money(input.amount),
      money(input.taxAmount ?? 0),
      matchStatus,
      discrepancy,
    ],
  );
  await auditAction(db, ctx, 'procurement.invoice_recorded', 'supplier_invoice', rows[0]!.id, {
    after: { invoiceNumber: input.invoiceNumber, matchStatus },
  });
  return { invoiceId: rows[0]!.id, matchStatus, discrepancy };
}

export async function listPurchaseOrders(db: Queryable) {
  const { rows } = await db.query(
    `SELECT po.id, po.po_number, po.status, po.total_amount, po.order_date, s.supplier_name
       FROM procurement.purchase_orders po
       JOIN procurement.suppliers s ON s.id = po.supplier_id
      ORDER BY po.created_at DESC LIMIT 100`,
  );
  return rows;
}
