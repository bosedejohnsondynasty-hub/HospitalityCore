# Hospitality Core

Self-hosted hospitality management software for hotels, restaurants and bars, built as three
independently licensable products on one PostgreSQL core.

- **Hotel ERP** — 44 modules across core, back office and specialised categories.
- **Restaurant** — menu, QR ordering, POS, kitchen display, recipes, stock and payments.
- **Bar** — beverage menu, bar POS, stock, recipes, costing and guest billing.

Restaurant and Bar operate without the Hotel product. Starting with one product and adding
another later is supported without destructive migration: products are licensing entitlements,
not separate databases.

## What is implemented and proven

The repository contains a working API, a working web client, 26 versioned migrations and an
automated suite that runs against a real PostgreSQL server.

Verified by `npm test` (57 tests, all passing at the time of writing):

| Area | Evidence |
| --- | --- |
| Provisioning | Tenant, products, 73 modules, 217 permissions, 16 role templates and a 26-account chart of accounts are created in one transaction |
| Tenant isolation | A second tenant receives 404/empty results for another tenant's records; enforced by PostgreSQL RLS, not application filters |
| Double booking | Overlapping allocations are rejected by a GiST exclusion constraint; two concurrent allocations of one room yield exactly one success |
| Folio integrity | Posted folio entries cannot be updated or deleted by the runtime role; reversals are separate append-only entries |
| Night audit | Posts room charges once per stay and business date, advances the date, blocks on critical exceptions, records authorised overrides |
| Housekeeping | Task assignment, checklist completion and inspection update room readiness |
| Maintenance | Self-approval is refused, a second approver completes the request, work-order parts post a stock movement |
| Payroll | PAYE and pension computed per payslip; the run posts Dr payroll expense / Cr statutory payables and net pay once; a second post or payment is refused; net pay settlement clears the liability |
| Fixed assets | Capitalisation debits fixed assets, monthly straight-line depreciation posts once per calendar month, accumulated depreciation is capped, disposal derecognises cost and recognises gain/loss |
| Restaurant | Menu, table QR token, public menu, QR order, kitchen ticket, status flow, recipe ingredient deduction (10 kg − 0.4 kg = 9.6 kg) |
| Payments | Cash settlement recognises revenue once; Paystack signature verification, replay-safe webhook, amount tampering rejected |
| Cross-product | Restaurant and bar charges post to a guest folio with one revenue posting each and the liability on the guest ledger only |
| Authorisation | Cashier cannot refund, adjust stock or use offline sync; requester cannot approve their own refund or purchase order |
| Licensing | Deactivating a module returns `402 MODULE_NOT_LICENSED` from every gated route |
| Offline sync | Command replay is idempotent, later conflicting commands are recorded as pending conflicts |
| Back office | Budgets with variance from posted journals, treasury transfers posting one balanced journal, laundry accountability gate, agreements/insurance/quality/security/documents/training lifecycles |
| Guest and commercial | Banquets with server-computed charges, sales pipeline, CRM interactions, channel allocation guards, approved revenue forecasts, spa/tour/central-reservation and food-safety workflows |
| Corporate billing | Credit limit enforced, invoice posts Dr receivable / Cr revenue once, settlement posts once, second payment refused, tenant isolation |
| Outlets | Restaurant reservations protected by a GiST exclusion constraint, waitlist seating, append-only loyalty ledger, promotion quotes, recipe plate-cost report, bar event ticket capacity |
| Reporting | Trial balance reconciles with posted journals and is balanced |

## Quick start (local development)

Requirements: Node 22+, PostgreSQL 15+ (17 recommended).

```bash
npm install
cp .env.example .env          # set the database URLs, APP_DB_PASSWORD and SETUP_TOKEN
npm run db:setup              # create the restricted role, apply migrations, seed the catalogue
npm run dev                   # API on :4000, web on :3000
```

Open <http://localhost:3000>. The first-run screen creates the tenant, administrator and product
licences when `ALLOW_API_SETUP=true` and `SETUP_TOKEN` is set.

For a disposable local PostgreSQL without installing one, `node scripts/db-dev.mjs up` starts an
embedded server on port 5432 and `node scripts/db-dev.mjs reset` recreates the database.

Then:

```bash
npm test                                    # API unit + integration suite against real PostgreSQL
npm run typecheck -w @hospitality/api
npm run typecheck -w @hospitality/web
npm run build -w @hospitality/api
npm run build -w @hospitality/web
```

## Production deployment

```bash
cp .env.example .env    # fill POSTGRES_SUPERUSER_PASSWORD, APP_DB_PASSWORD, SETUP_TOKEN, APP_ORIGIN
docker compose up -d --build
```

The API container waits for PostgreSQL, ensures the restricted runtime role, applies migrations,
seeds the catalogue and starts. `web` serves the SPA and proxies `/api` to the API on an internal
network. The database is not published to the host. See [docs/INSTALL.md](docs/INSTALL.md).

Backups and restore:

```bash
docker compose --profile ops run --rm backup     # pg_dump + SHA-256 + retention
CONFIRM_RESTORE=restore-hospitality-core ./scripts/restore.sh backups/<file>.dump
```

## Repository layout

```
apps/api        Fastify + TypeScript API, domain services, route layer
apps/web        React 19 + Vite single-page client (responsive, offline-tolerant)
db/migrations   Forward-only ordered migrations, applied with checksums
db/seed         Product, module (72) and permission (214) reference data
scripts         migrate, seed, db-bootstrap, embedded dev PostgreSQL, backup, restore
docs            Installation, architecture, security, administration, API and readiness evidence
```

## Security model (short version)

- The API refuses to start if its database role is a superuser, has `BYPASSRLS`, or owns tables.
- Every request runs in a transaction with `app.tenant_id` set; RLS policies scope all tenant tables,
  and reporting views are `security_invoker` so they cannot leak across tenants.
- Sessions are opaque bearer tokens stored as SHA-256 digests; passwords use scrypt with per-user salt;
  TOTP MFA is implemented with `node:crypto`.
- Financial and inventory rows are append-only for the runtime role: postings are corrected by
  reversal entries that reference the original, never by editing posted data.
- Payment confirmation comes only from a signature-verified server-side webhook whose amount,
  currency, provider and reference match the stored intent. A browser return never marks an order paid.

Full detail, threat model and residual risks: [docs/SECURITY.md](docs/SECURITY.md).

## Status and limitations

This is a substantial, tested implementation of the operational core, not a claim that all 72
modules are feature-complete. Workforce (employees, rosters, attendance, payroll) and fixed assets
(register, depreciation, disposal) now have working workflows, screens and ledger postings. The
remaining back-office and specialised catalogue (spa, channel manager, CRM, revenue management,
franchise standards, banquet/events, treasury, and others) is present as licensed catalogue entries
with shared foundation tables, but not every submodule has a finished workflow or screen. Mobile experiences are delivered as a responsive PWA plus an offline sync API, not as
native Flutter applications. Offline licence validation and monitoring dashboards are not
implemented. Docker Compose has not been executed in this build environment because no Docker
daemon is available.

One licensing nuance is recorded in the readiness report: nine capability codes (`core`, `pos`,
`inventory`, `finance`, `analytics`, `procurement`, `customers`, `recipes`, `reservations`) exist under
more than one product, and the runtime check resolves by code, so deactivating that code under one
product does not lock the capability while another licensed product still includes it. Product-level
separation (restaurant or bar without hotel) is enforced and tested.

The honest gate-by-gate assessment is in [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md).
The clause-level audit against the v2.5 build contract, the per-module status ledger, the open owner
decisions and the source/product crosswalk are in
[docs/COMPLIANCE-AUDIT-v2.5.md](docs/COMPLIANCE-AUDIT-v2.5.md),
[docs/BUILD-LEDGER.md](docs/BUILD-LEDGER.md), [docs/DECISION-REGISTER.md](docs/DECISION-REGISTER.md)
and [docs/COMPLETENESS-PACK.md](docs/COMPLETENESS-PACK.md).
The requirement-to-implementation mapping is in
[docs/REQUIREMENTS-TRACEABILITY.md](docs/REQUIREMENTS-TRACEABILITY.md).

## Documentation

- [Installation](docs/INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Administrator guide](docs/ADMIN.md)
- [User guide](docs/USER-GUIDE.md)
- [API reference](docs/API.md)
- [Mobile and offline](docs/MOBILE.md)
- [Developer guide](docs/DEVELOPER.md)
- [Compliance audit v2.5](docs/COMPLIANCE-AUDIT-v2.5.md)
- [Build ledger](docs/BUILD-LEDGER.md)
- [Decision register](docs/DECISION-REGISTER.md)
- [Completeness pack](docs/COMPLETENESS-PACK.md)
- [Requirements traceability](docs/REQUIREMENTS-TRACEABILITY.md)
- [Production readiness](docs/PRODUCTION-READINESS.md)
- [Release notes](RELEASE-NOTES.md)
