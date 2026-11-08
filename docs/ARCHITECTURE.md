# Architecture

## Shape

Hospitality Core is a modular monolith: one deployable API, one PostgreSQL database, one web client.
Domain boundaries are explicit schemas, services and database policies rather than network services,
which keeps on-premises installation to a database plus two containers.

```
React 19 SPA (Vite)
        │  JSON over HTTPS, bearer token
        ▼
Fastify 5 API ── domain services ── PostgreSQL 15+ (RLS, triggers, exclusion constraints)
        │                                  │
        └── structured logs                └── pg_dump backups
```

## Domain schemas

| Schema | Responsibility |
| --- | --- |
| `platform` | Tenants, organizations, legal entities, branches, departments, document numbering |
| `identity` | Users, credential hashes, MFA secrets, sessions, password history |
| `access` | Roles, permissions, role permissions, user role and branch assignments |
| `licensing` | Products, module catalogue, subscriptions, activations, licence events |
| `hotel` | Hotels, room types, rooms, rates, guests, reservations, allocations, stays, folios, business dates, night audit |
| `housekeeping` | Tasks, checklist templates and results, inspections, linen/minibar discrepancies |
| `maintenance` | Requests, approvals, work orders, parts, preventive schedules |
| `restaurant` | Outlets, dining areas, tables, menus, categories, items, QR tokens, orders, lines, kitchen tickets, recipes, reservations |
| `bar` | Bar outlets, beverages, recipes, orders, lines, stock issues |
| `inventory` | Items, stores, balances, movements, receipts, issues, adjustments, stocktakes |
| `procurement` | Suppliers, requisitions, purchase orders, goods receipts, invoices, three-way matching |
| `finance` | Chart of accounts, fiscal periods, journals, journal lines, posting links, bank accounts, trial balance |
| `payments` | Intents, transactions, webhook events, refunds, settlements |
| `mobile` | Devices, sync commands, sync conflicts |
| `audit` | Append-only audit events |
| `integration` | Outbox events for downstream consumers |
| `notification` | Notification queue drained by a delivery worker with retry and backoff (email via SMTP when configured, SMS/push pending a provider adapter) |
| `backoffice` | Budgets and budget lines, treasury transfers, laundry cycles and items, agreements, insurance policies and claims, quality inspections and actions, utility meters and readings, security incidents and patrols, document register and actions, training courses and enrolments |
| `guestops` | Banquet events and charges, sales campaigns and opportunities, CRM segments and interactions, channel allocations, revenue forecasts, spa resources/bookings, tour packages/bookings, call logs, central reservations, food-safety checks and logs, corporate accounts/invoices, franchise standards/audits/actions |
| `reporting` | Reporting helpers/views where defined |

## Runtime invariants

**Tenant isolation is enforced by the database.** The API connects as a non-owner, non-superuser,
non-`BYPASSRLS` role. Every unit of work runs in a transaction that sets `app.tenant_id`; RLS
policies compare `tenant_id` to that setting. Reporting views are `security_invoker` so they inherit
the caller's policies — a defect found by the test suite and corrected in migration 018.

**Money is numeric.** All monetary columns are `NUMERIC(18,4)`; the API rounds with a single helper
and the database checks document totals (`total = subtotal + tax + service_charge − discount`).

**Posted data is append-only.** The runtime role has no `UPDATE`/`DELETE` on `hotel.folio_entries`,
`finance.journal_lines`, `inventory.movements`, `audit.events`, `licensing.license_events` and
`restaurant.loyalty_ledger`. Corrections are new rows with `reverses_entry_id` /
`reversed_by_entry_id` and a reason. Journal entries may move only from `posted` to `reversed`;
loyalty corrections are a new `adjustment` movement, never an edit of a posted balance.

**Exactly-once posting.** `finance.posting_links` has a unique key on
`(tenant_id, source_type, source_id, purpose)`. Revenue for a restaurant order is keyed
`('restaurant_order', id, 'revenue')`; posting the same order to a folio does not create a second
revenue entry, and settlement of the folio is keyed separately.

**Concurrency.** Room overlap is prevented by
`EXCLUDE USING gist (room_id WITH =, stay_period WITH &&) WHERE (status = 'active')`. Restaurant
tables use the same mechanism over a half-open `tstzrange` dining period
(`restaurant_reservations_no_overlap`), so a second booking for an overlapping seating is rejected
by the database rather than by a race-prone read. The API maps `23P01` to `409`. Ingredient and stock
deduction use a partial unique index on movement reference and `ON CONFLICT DO NOTHING`, so retries
cannot double-deduct. Spa bookings and bar ticket sales check capacity inside the same transaction
that locks the resource row.

**Treasury and corporate credit post through the same ledger path.** A treasury transfer is one
journal entry (Dr destination bank GL, Cr source bank GL) behind a `posting_links` row keyed
`('treasury_transfer', id, 'transfer')`; a corporate invoice is keyed `('corporate_invoice', id,
'invoice')` and its settlement `('corporate_invoice', id, 'payment')`, so neither can post twice.

**Idempotency.** Payment webhooks are stored under a unique `(provider, event_id)`; a replay returns
`200 duplicate` without applying effects. Offline commands carry a client-generated `command_id`
unique per tenant; a replay returns the stored result.

**Night audit.** Critical exceptions (in-house stay without an open folio) block the run. An
authorised override requires a reason and is recorded with the exception list. Room charges are keyed
by stay and business date, so a re-run cannot charge twice.

## API layer

- Fastify with `@fastify/helmet`, `@fastify/cors` (explicit origin allowlist), `@fastify/rate-limit`.
- Routes are thin: authenticate → permission check → module licence check → domain service → JSON.
- Domain services accept a `Queryable` (transaction-scoped client) and a tenant-scoped auth context.
- Errors are typed (`AppError`) with stable codes (`ROOM_UNAVAILABLE`, `MODULE_NOT_LICENSED`,
  `NIGHT_AUDIT_EXCEPTIONS`, `DUPLICATE_POSTING`, …); PostgreSQL error codes are mapped centrally.
- The raw request body is preserved for webhook signature verification.

## Web layer

React 19 + Vite, no state-management dependency. `src/api.ts` holds the bearer token in
`localStorage` and throws a typed `ApiError`. Navigation is hash-based so the SPA works behind any
static host. Module-locked navigation is a UX hint only; the API is the enforcement point.

The **Business tools** page is data-driven: a resource table describes list path, create path and field
metadata for each back-office, guest-operation and outlet module, so new modules become a screen by
extending that table rather than writing a bespoke page. Lifecycle transitions stay on the API and
their dedicated screens.

The public QR route (`#/qr/<token>`) is unauthenticated and calls only
`/api/v1/public/qr/:token/*`, which resolves the outlet and tenant from the token through a narrowly
scoped `SECURITY DEFINER` lookup.

## Deliberate technology choices

| Choice | Rationale |
| --- | --- |
| PostgreSQL + RLS | Financial correctness and isolation belong in the database, not only in code |
| Fastify + `pg` | Small dependency surface, explicit SQL, no ORM hiding constraints |
| Numeric money | Avoids floating-point drift in ledgers |
| Opaque tokens + SHA-256 | No JWT revocation problem; sessions are rows that can be revoked instantly |
| No cookies | Removes CSRF surface; bearer token must be protected by TLS and client hygiene |
| Vite SPA | Simple, cacheable static hosting; works on a LAN with no Node server for the UI |
| PWA instead of native apps | Delivers the required mobile workflows without a second toolchain (see MOBILE.md) |

## Not built

Redis is not used: PostgreSQL provides the transaction boundaries, unique constraints and
`FOR UPDATE`/exclusion semantics the system needs. Notification messages are drained by a
polled worker (`npm run worker`) that claims rows per tenant with `FOR UPDATE SKIP LOCKED` and
retries transient failures with exponential backoff; unconfigured channels fail visibly instead of
faking a send. Domain events accumulate in `integration.outbox` (the unit of work that writes
them) and are relayed by the same worker into notification messages with backoff retries
(`OUTBOX_MAX_ATTEMPTS`); events with no consumer are recorded, not silently dropped. Reporting
warehouse extracts, channel-manager integrations and offline licence signature validation are
not implemented.
