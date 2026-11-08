/**
 * Role templates used at tenant onboarding.
 *
 * Patterns are matched against access.permissions.permission_code:
 *   'hotel.reservations.*'  allow every action in that namespace
 *   '*.*'                   allow everything
 *   '!restaurant.payments.refund'  explicit denial, applied after allows
 *
 * Separation of duties is expressed here: the cashier can take payments but not
 * approve refunds, the storekeeper can receive stock but not adjust it, and the
 * auditor is read-only.
 */
export interface RoleTemplate {
  code: string;
  name: string;
  description: string;
  allow: string[];
  deny?: string[];
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    code: 'owner',
    name: 'Owner / Platform Administrator',
    description: 'Full access to every product, licence and setting.',
    allow: ['*.*'],
  },
  {
    code: 'general_manager',
    name: 'General Manager',
    description: 'Operational management across licensed products, without licence administration.',
    allow: ['*.*'],
    deny: [
      'platform.licensing.manage',
      'platform.tenants.manage',
      'platform.roles.manage',
      'restaurant.payments.refund',
      'bar.payments.refund',
      'inventory.stock.adjust.approve',
      'finance.periods.manage',
    ],
  },
  {
    code: 'front_desk',
    name: 'Front Desk Agent',
    description: 'Reception, reservations, check-in, folio posting and settlement.',
    allow: [
      'hotel.reservations.view',
      'hotel.reservations.create',
      'hotel.reservations.cancel',
      'hotel.guests.view',
      'hotel.guests.manage',
      'hotel.rooms.view',
      'hotel.hotels.view',
      'hotel.frontdesk.*',
      'hotel.folios.view',
      'hotel.folios.post',
      'hotel.folios.settle',
      'hotel.housekeeping.view',
      'hotel.maintenance.request',
      'hotel.notifications.view',
      'hotel.notifications.send',
      'hotel.reports.view',
    ],
    deny: ['hotel.folios.reverse', 'hotel.nightaudit.run'],
  },
  {
    code: 'reservations_agent',
    name: 'Reservations Agent',
    description: 'Reservation and guest profile management without cashiering.',
    allow: [
      'hotel.reservations.*',
      'hotel.guests.*',
      'hotel.rooms.view',
      'hotel.hotels.view',
      'hotel.reports.view',
    ],
    deny: ['hotel.folios.settle', 'hotel.folios.reverse'],
  },
  {
    code: 'housekeeping_supervisor',
    name: 'Housekeeping Supervisor',
    description: 'Assign, verify and inspect cleaning work.',
    allow: [
      'hotel.housekeeping.*',
      'hotel.rooms.view',
      'hotel.maintenance.request',
      'hotel.maintenance.view',
      'hotel.reports.view',
    ],
  },
  {
    code: 'housekeeper',
    name: 'Housekeeper',
    description: 'Mobile cleaning tasks and checklists.',
    allow: [
      'hotel.housekeeping.view',
      'hotel.housekeeping.complete',
      'hotel.rooms.view',
      'platform.sync.execute',
    ],
  },
  {
    code: 'maintenance_technician',
    name: 'Maintenance Technician',
    description: 'Work order execution and parts usage; cannot verify their own work.',
    allow: [
      'hotel.maintenance.view',
      'hotel.maintenance.request',
      'hotel.maintenance.complete',
      'inventory.stock.view',
      'platform.sync.execute',
    ],
    deny: ['hotel.maintenance.verify', 'hotel.maintenance.config'],
  },
  {
    code: 'maintenance_supervisor',
    name: 'Maintenance Supervisor / Chief Engineer',
    description: 'Trades, checklists, SLA configuration and four-eyes verification of completed work.',
    allow: [
      'hotel.maintenance.*',
      'hotel.rooms.view',
      'hotel.housekeeping.view',
      'inventory.stock.view',
      'hotel.reports.view',
      'platform.sync.execute',
    ],
  },
  {
    code: 'restaurant_manager',
    name: 'Restaurant Manager',
    description: 'Full restaurant operations including refunds approval.',
    allow: ['restaurant.*.*', 'hotel.folios.post'],
    deny: [],
  },
  {
    code: 'waiter',
    name: 'Waiter / Waitress',
    description: 'Table service order taking and serving.',
    allow: [
      'restaurant.orders.view',
      'restaurant.orders.create',
      'restaurant.orders.update',
      'restaurant.menu.view',
      'restaurant.kitchen.view',
      'restaurant.outlets.view',
      'platform.sync.execute',
    ],
  },
  {
    code: 'kitchen_staff',
    name: 'Kitchen Staff',
    description: 'Kitchen display and preparation progression.',
    allow: [
      'restaurant.kitchen.view',
      'restaurant.kitchen.update',
      'restaurant.orders.view',
      'restaurant.menu.view',
    ],
  },
  {
    code: 'cashier',
    name: 'Cashier',
    description: 'Take payments and settle folios; refunds require a second approver.',
    allow: [
      'restaurant.orders.view',
      'restaurant.payments.initiate',
      'bar.orders.view',
      'bar.payments.initiate',
      'hotel.folios.view',
      'hotel.folios.settle',
      'hotel.folios.post',
    ],
    deny: [
      'restaurant.payments.refund',
      'bar.payments.refund',
      'hotel.folios.reverse',
      'restaurant.orders.void',
      'bar.orders.void',
    ],
  },
  {
    code: 'bar_manager',
    name: 'Bar Manager',
    description: 'Full bar operations, beverage costing and event management.',
    allow: ['bar.*.*', 'hotel.folios.post', 'restaurant.menu.view'],
  },
  {
    code: 'bartender',
    name: 'Bartender',
    description: 'Bar service and tabs.',
    allow: [
      'bar.orders.view',
      'bar.orders.create',
      'bar.beverages.view',
      'bar.outlets.view',
      'platform.sync.execute',
    ],
  },
  {
    code: 'storekeeper',
    name: 'Storekeeper',
    description: 'Receive, issue and count stock; adjustments need approval.',
    allow: [
      'inventory.items.view',
      'inventory.stock.view',
      'inventory.stock.receive',
      'inventory.stock.issue',
      'procurement.goodsreceipts.create',
      'procurement.purchaseorders.view',
    ],
    deny: ['inventory.stock.adjust', 'inventory.stock.adjust.approve'],
  },
  {
    code: 'finance_officer',
    name: 'Finance Officer',
    description: 'Accounting, procurement approval and financial reporting.',
    allow: [
      'finance.*.*',
      'inventory.stock.view',
      'inventory.items.view',
      'procurement.*.*',
      'hotel.reports.view',
      'restaurant.reports.view',
      'bar.reports.view',
      'restaurant.payments.refund',
      'bar.payments.refund',
      'hotel.folios.reverse',
    ],
    deny: ['finance.periods.manage'],
  },
  {
    code: 'internal_auditor',
    name: 'Internal Auditor',
    description: 'Read-only access to operational and financial records plus the audit trail.',
    allow: ['*.*.view', 'platform.audit.view', 'finance.journals.view', 'finance.reports.view'],
    deny: [
      'hotel.folios.post',
      'hotel.folios.settle',
      'hotel.folios.reverse',
      'restaurant.payments.initiate',
      'bar.payments.initiate',
      'inventory.stock.*',
      'finance.journals.post',
    ],
  },
];

/** Default chart of accounts created for every tenant. */
export interface CoaTemplate {
  code: string;
  name: string;
  class: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normal: 'debit' | 'credit';
}

export const DEFAULT_COA: CoaTemplate[] = [
  { code: '1000', name: 'Cash on Hand', class: 'asset', normal: 'debit' },
  { code: '1010', name: 'Bank - Current Account', class: 'asset', normal: 'debit' },
  { code: '1100', name: 'Accounts Receivable - Guest Ledger', class: 'asset', normal: 'debit' },
  { code: '1200', name: 'Inventory - Food and Beverage', class: 'asset', normal: 'debit' },
  { code: '1500', name: 'Fixed Assets', class: 'asset', normal: 'debit' },
  { code: '1510', name: 'Accumulated Depreciation', class: 'asset', normal: 'credit' },
  { code: '2000', name: 'Accounts Payable', class: 'liability', normal: 'credit' },
  { code: '2100', name: 'VAT Payable', class: 'liability', normal: 'credit' },
  { code: '2200', name: 'PAYE and Pension Payable', class: 'liability', normal: 'credit' },
  { code: '2300', name: 'Salaries Payable', class: 'liability', normal: 'credit' },
  { code: '3000', name: 'Owner Equity', class: 'equity', normal: 'credit' },
  { code: '4000', name: 'Room Revenue', class: 'revenue', normal: 'credit' },
  { code: '4100', name: 'Restaurant Revenue', class: 'revenue', normal: 'credit' },
  { code: '4200', name: 'Bar Revenue', class: 'revenue', normal: 'credit' },
  { code: '4300', name: 'Other Revenue', class: 'revenue', normal: 'credit' },
  { code: '4400', name: 'Gain on Disposal', class: 'revenue', normal: 'credit' },
  { code: '5000', name: 'Cost of Sales - Food', class: 'expense', normal: 'debit' },
  { code: '5100', name: 'Cost of Sales - Beverage', class: 'expense', normal: 'debit' },
  { code: '6000', name: 'Payroll Expense', class: 'expense', normal: 'debit' },
  { code: '6100', name: 'Utilities Expense', class: 'expense', normal: 'debit' },
  { code: '6200', name: 'Repairs and Maintenance', class: 'expense', normal: 'debit' },
  { code: '6300', name: 'Operating Supplies', class: 'expense', normal: 'debit' },
  { code: '6400', name: 'Payment Gateway Fees', class: 'expense', normal: 'debit' },
  { code: '6500', name: 'Discounts and Allowances', class: 'expense', normal: 'debit' },
  { code: '6600', name: 'Depreciation Expense', class: 'expense', normal: 'debit' },
  { code: '6700', name: 'Loss on Disposal', class: 'expense', normal: 'debit' },
];

export const GL = {
  cash: '1000',
  bank: '1010',
  guestReceivable: '1100',
  inventory: '1200',
  fixedAssets: '1500',
  accumulatedDepreciation: '1510',
  accountsPayable: '2000',
  vatPayable: '2100',
  statutoryPayable: '2200',
  salariesPayable: '2300',
  roomRevenue: '4000',
  restaurantRevenue: '4100',
  barRevenue: '4200',
  otherRevenue: '4300',
  gainOnDisposal: '4400',
  foodCost: '5000',
  beverageCost: '5100',
  payrollExpense: '6000',
  depreciationExpense: '6600',
  lossOnDisposal: '6700',
  gatewayFees: '6400',
  discounts: '6500',
} as const;

/**
 * Pattern matcher shared by role seeding and tests.
 *
 * Supports exact codes, '*' as a single segment wildcard, and a trailing '*'
 * meaning "this segment and everything after it". Denials always win.
 */
export function matchesPatterns(code: string, allow: string[], deny: string[] = []): boolean {
  const hit = (pattern: string): boolean => {
    if (pattern === code) return true;
    const p = pattern.split('.');
    const c = code.split('.');
    const trailing = p[p.length - 1] === '*';
    if (trailing) {
      const fixed = p.slice(0, -1);
      if (c.length <= fixed.length) return false;
      return fixed.every((segment, index) => segment === '*' || segment === c[index]);
    }
    if (p.length !== c.length) return false;
    return p.every((segment, index) => segment === '*' || segment === c[index]);
  };
  if (deny.some(hit)) return false;
  return allow.some(hit);
}
