# Release notes

## 0.1.0 — 2026-11-07

First implementation release of Hospitality Core: a self-hosted hotel, restaurant and bar platform
on PostgreSQL, with a Fastify API and a React web client.

### Delivered

**Platform**
- Tenant onboarding (tenant, organization, legal entity, branch, fiscal calendar, chart of accounts,
  roles, module activations) in one transaction.
- 3 products, 73 modules, 214 permissions, 16 role templates, 26-account chart of accounts.
- Module/licence centre with server-side enforcement (`402 MODULE_NOT_LICENSED`).
- PostgreSQL row-level security with a restricted runtime role; the API refuses to start otherwise.
- Append-only financial and inventory records, controlled reversals, audit trail.

**Hotel**
- Guests, reservations, availability, room allocation with database-enforced double-booking
  prevention, check-in/out, folio charges, settlement, reversals.
- Night audit with critical exceptions, authorised override, once-per-stay room charges and business
  date rollover.
- Housekeeping tasks, checklists, inspection and room release.
- Maintenance requests with four-eyes approval and work orders that consume parts.
- Reporting: dashboard, occupancy, daily sales, trial balance.

**Restaurant**
- Outlets, menus, categories, items, tax and service charge.
- Table QR tokens, public menu and guest ordering without an account.
- POS orders, kitchen tickets with station routing, status flow, recipe ingredient deduction.
- Charge to guest folio without double-counting revenue; refunds with approval.

**Bar**
- Beverage menu, bar orders, stock deduction, cocktail recipes, folio charging.

**Finance and payments**
- Double-entry journals with fiscal periods, posting links and a balanced trial balance.
- Cash, bank transfer, POS terminal, Paystack and Flutterwave adapters.
- Signature-verified webhooks with replay protection and amount/currency checks.
- Refunds requiring a second authorised user.

**Inventory and procurement**
- Item master, stores, balances, movements, receipts, issues, adjustments.
- Suppliers, purchase orders with approval segregation, goods receipts, invoices.

**Workforce**
- Employee register with department, employment type, salary, branch and termination.
- Shift roster with a database exclusion constraint against overlapping shifts.
- Attendance clock-in/out records with source (manual/mobile/biometric).
- Payroll runs computing PAYE (consolidated relief, statutory bands) and pension, payslips per
  employee, one accrual posting (Dr payroll expense, Cr statutory payables and net pay payable),
  net-pay settlement from the bank; duplicate posting and duplicate payment are refused.

**Fixed assets**
- Asset register with acquisition cost, salvage value and useful life.
- Capitalisation posting (Dr fixed assets, Cr bank).
- One straight-line depreciation run per calendar month, capped at the depreciable base, posting
  Dr depreciation expense / Cr accumulated depreciation.
- Disposal that derecognises cost and accumulated depreciation and recognises gain or loss.

**Mobile**
- Responsive PWA.
- Offline sync API for housekeeping completion and maintenance requests, idempotent by command id,
  with recorded conflicts and supervisor resolution.

**Operations**
- Dockerfiles, Compose stack with healthchecks, nginx reverse proxy.
- Checksummed forward-only migrations, seeding, role bootstrap.
- Backup script (checksum + retention) and guarded restore script.
- Structured logs with secret redaction; `/healthz` and `/readyz`.

### Fixed during verification

- Date columns returned as JS `Date` produced invalid `timetz` ranges during allocation and night
  audit; normalised to `YYYY-MM-DD`.
- Folio creation referenced a non-existent `hotel.hotels.currency_code`; it now uses the tenant's
  functional currency.
- Reporting views ran as owner and leaked across tenants in the trial balance; migration 018 makes
  every application view `security_invoker` and fails if one does not.
- Finance officer role lacked refund/reversal permissions required by the four-eyes workflow.
- Offline conflicts were created pre-resolved; they are now `pending` for supervisor action.
- `-0` from money rounding normalised to `0`.
- Onboarding failed for tenants with more than one branch because every branch received the same placeholder bank account number; accounts are now one per branch with unique numbers.
- The runtime role retained `DELETE` on `finance.journal_entries`; migration 019 revokes it and fails if any destructive privilege survives on an append-only table.

### Verification

- 24 automated tests, 0 failures, against PostgreSQL 17.11.
- 20 migrations applied cleanly; 73 modules and 214 permissions seeded.
- 11 database integrity checks pass, including payroll-to-payslip reconciliation, asset
  accumulated-depreciation bounds and append-only grants on payslips/depreciation entries.
- API and web production builds succeed; both typecheck.
- Web client served and reachable through the preview proxy.

### Known limitations

- The remaining specialised hotel modules (spa, channel manager, CRM, revenue management, banquet,
  notifications, franchise standards, treasury, laundry) are licensed catalogue entries or partial
  implementations, not complete workflows. Workforce and fixed assets are implemented.
- Native Flutter apps are not built; mobile is a PWA plus sync API.
- No browser-driven E2E suite; acceptance tests are API-level.
- No performance/load measurements.
- Docker Compose, backup and restore were not executed in this build environment (no Docker daemon).
- Approval thresholds, offline licence validation, file uploads, notification delivery and
  monitoring are not implemented.
- Single functional currency per tenant; no FX revaluation.
- Nine capability codes are shared by more than one product (`core`, `pos`, `inventory`, `finance`,
  `analytics`, `procurement`, `customers`, `recipes`, `reservations`). Deactivating one product's copy
  does not lock the capability while another licensed product includes it; product-level separation
  (restaurant/bar without hotel) is enforced and tested.

### Upgrade notes

- This is the first release; install fresh.
- Migration 018 must be applied before the reporting pages are exposed to multiple tenants.
- After provisioning, set `ALLOW_API_SETUP=false` and restart the API.
