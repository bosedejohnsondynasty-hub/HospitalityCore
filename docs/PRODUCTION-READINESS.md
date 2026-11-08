# Production readiness evidence report

Assessment date: 2026-11-08 · Version 0.1.0

This report states what was executed and observed in the build environment, and what was not.
A gate is only **PASS** where the evidence below was produced by a command whose output is known.

> **This is not a production-readiness declaration.** The v2.5 build contract requires all six product
> domains, module Definition-of-Done evidence, UAT, performance, accessibility, security assessment,
> backup/restore and owner acceptance before that phrase may be used. None of those is complete.
> The clause-level position is in [COMPLIANCE-AUDIT-v2.5.md](COMPLIANCE-AUDIT-v2.5.md); per-module
> status is in [BUILD-LEDGER.md](BUILD-LEDGER.md); open owner decisions are in
> [DECISION-REGISTER.md](DECISION-REGISTER.md).

## Gate A — Requirements

**Status: PARTIAL**

| Criterion | Result |
| --- | --- |
| Both HTML sources reviewed | Done; treated as one history (S1, S2) |
| Requirements register completed | `docs/REQUIREMENTS-TRACEABILITY.md` maps themes, module catalogue, cross-product, security, mobile and operations; it is not a sentence-by-sentence mapping of a truncated chat export |
| Module catalogue reconciled | 44 hotel (9 core / 18 back office / 17 specialised) + 17 restaurant + 11 bar = 72, seeded and asserted by tests |
| Critical unresolved decisions identified | Six recorded (UD-1…UD-6), notably native mobile, offline licence validation and approval thresholds |
| Acceptance criteria defined | Yes, as executable scenarios in `apps/api/test/integration.test.ts` and the tables in the register |

Why not PASS: the register still carries partial rows (procurement depth, statutory tax
configurability, multi-branch consolidation, guest self-service, minibar, mobile apps). Everything
that was previously catalogue-only — budget/cost control, treasury, laundry, contracts, insurance,
quality, utilities, security, documents, training, banquets, sales, CRM, channel allocations,
revenue management, spa, tours, central reservations, food safety, corporate credit and franchise
standards — now has storage, licence-gated endpoints and tests, but acceptance criteria for those
domains are API scenarios rather than signed-off business sign-off.

## Gate B — Architecture and database

**Status: PASS (single-node, PostgreSQL 17.11)**

| Criterion | Evidence |
| --- | --- |
| Architecture documented | `docs/ARCHITECTURE.md` |
| Migrations execute in a clean environment | 26 migrations applied in order on PostgreSQL 17.11; `Applied N migration(s)` with checksum tracking |
| Referential integrity verified | Composite tenant FKs (`(tenant_id, id)`), `scripts/verify-db.mjs` orphan check |
| Tenant isolation verified | RLS policies + restricted role; cross-tenant test returns 404/empty; direct SQL check shows no leakage; reporting views fixed to `security_invoker` (migration 018) |
| Concurrency controls tested | Two simultaneous allocations of one room → exactly one `200`, one `409`; exclusion constraint `room_allocations_no_overlap` |
| Migration upgrade strategy tested | Forward-only checksummed runner verified; editing an applied migration is refused. Rollback is restore-from-backup, not down-migrations |

Residual: the suite runs against a single PostgreSQL instance, not a replicated cluster or a
different major version (15/16 were not exercised).

## Gate C — Functional implementation

**Status: PARTIAL**

Proven end-to-end (database → API → UI callable) by tests:

- Tenant onboarding with 26-account chart of accounts, 16 roles, 73 modules, 217 permissions.
- Reservations, availability, allocation, double-booking rejection, check-in, folio charges,
  reversal, night audit with exception override, housekeeping completion/inspection.
- Maintenance request approval segregation, work order completion with parts stock movement.
- Restaurant menu, QR token, public menu, QR order with server-calculated totals, kitchen routing,
  status flow, recipe ingredient deduction, idempotent completion.
- Cash and Paystack payments, signature verification, replay handling, amount tampering rejection.
- Bar sale with stock deduction and folio charging.
- Cross-product restaurant + bar → folio with exactly one revenue posting per order and settlement
  clearing the receivable.
- Permission denials (refund, stock adjustment, offline sync), refund four-eyes approval,
  purchase-order approval segregation.
- Module deactivation → `402`, reactivation → allowed; another tenant unaffected.
- Offline sync idempotency, conflict recording and resolution.
- Workforce: employee register, rosters with overlap rejection, attendance, payroll with PAYE and
  pension, one accrual posting per run, net-pay settlement, duplicate post/payment refused.
- Fixed assets: capitalisation posting, one straight-line depreciation run per calendar month,
  accumulated-depreciation cap, disposal with gain/loss posting, duplicate disposal refused.
- Notifications: queued messages, worker-claimed delivery with retry and backoff; in-app delivery
  verified, email via SMTP when configured, unconfigured channels fail permanently with an honest
  error detail instead of a faked send; module deactivation blocks queuing with 402.
- Budget and cost control: draft→approved→locked budget with lines, locked budgets refuse edits, and
  variance is computed from posted journal lines for the fiscal year.
- Treasury: bank positions derived from ledger balances; one balanced journal per transfer behind a
  posting link; same-account transfers refused.
- Laundry: item-level returned/lost/damaged accountability must reconcile before completion; an
  unaccounted line blocks completion; completion emits `laundry.completed`.
- Contracts, insurance, quality, security, documents and training: guarded status transitions,
  claim recovery caps, inspection scores with corrective actions, one reading per meter/day, one
  enrolment per employee per course.
- Banquets: charge totals computed server-side, lifecycle to `completed`, completion event, no
  charges after close.
- Sales, CRM and revenue: weighted pipeline, monotonic opportunity stages, segment interaction
  rollup, approved forecasts and a portfolio occupancy/ADR summary.
- Channel allocations: one allocation per channel/room type/date, sold units capped at allocation.
- Spa, tours and central reservations: overlapping spa bookings rejected, tour pax capped at
  package capacity, same-day stays refused.
- Food safety: pass/fail readings and corrective action recorded before completion.
- Corporate billing: credit limit enforced, invoice posts Dr guest receivable / Cr other revenue
  once, settlement posts Dr bank / Cr receivable once, second payment refused, tenant isolation
  on the invoice list.
- Franchise: standards, audits with score, corrective actions and a per-standard score rollup.
- Restaurant operations: GiST-protected table reservations, waitlist seating as a one-way state,
  append-only loyalty ledger with earn/redeem and insufficient-points refusal, promotion quoting
  with window/minimum-spend rules, recipe-based food-cost report.
- Bar events: on-sale lifecycle, capacity-checked ticket bookings, cancellation.
- Dashboard and trial balance reconcile with posted journals.

Not complete: the web client's **Business tools** page gives every new module a register and a
create form, but deeper per-module screens (banquet function sheets, rate-parity sync, spa rosters,
campaign attribution, certificate uploads) are not built. Guests still have no portal. Email
delivery needs an SMTP relay configured (SMTP_HOST) and SMS/push still need a provider adapter;
without them those channels fail visibly rather than silently.

## Gate D — Security

**Status: PARTIAL**

| Control | Evidence |
| --- | --- |
| Authentication | scrypt hashing, opaque hashed session tokens, lockout, TOTP MFA — unit tested |
| Authorisation | RBAC wildcard matcher unit tested against the seeded catalogue; role templates resolve; denials win |
| Tenant isolation | Integration test + direct SQL assertion |
| Payment verification | Paystack HMAC-SHA512 signature, replay, amount/currency checks — integration tested |
| Refund authorisation | Four-eyes enforced — integration tested |
| Append-only financial data | Direct `UPDATE`/`DELETE` rejected by grants and triggers — integration tested |
| Rate limiting / headers / CORS | Enforced by `@fastify/rate-limit` + `@fastify/helmet` + `@fastify/cors`; automatically tested in `apps/api/test/security.test.ts` (helmet headers present, no `x-powered-by`, allowed origin reflected, disallowed origin not reflected, 429 after the 300-request budget) |
| Threat model | `docs/SECURITY.md`, including residual risks |
| Licence granularity | Module-level enforcement tested, including product-scoped activation (`POST /licensing/modules/:code/:action` requires the owning product) and product-scoped route gating, both verified in `apps/api/test/product-scoping.test.ts`. Nine capability codes are shared across products (`core`, `pos`, `inventory`, `finance`, `analytics`, `procurement`, `customers`, `recipes`, `reservations`). Product-prefixed routes gate on the owning product's copy via the 3-arg `licensing_is_module_licensed` (route prefix → product, with payment intents mapped by `relatedType`); deactivating the bar copy of `recipes` or `core` no longer locks restaurant routes, and deactivating the restaurant copy of `reservations` no longer locks hotel routes. Cross-product endpoints (`/inventory/*`, `/procurement/*`) intentionally gate on any licensed copy, matching the shared-capability rule. Public QR menu and ordering respect the restaurant licensing state (402 when deactivated). |

Not done: external penetration test, dependency CVE audit, TLS configuration test, file-upload
hardening (no upload feature), encryption-at-rest configuration, monitoring/alerting.

## Gate E — Operations

**Status: PARTIAL / UNVERIFIED on target host**

| Criterion | Evidence |
| --- | --- |
| On-premises installation tested | Not executed here: no Docker daemon is available in this environment. Compose file, Dockerfiles, entrypoint, healthchecks and nginx config are provided and reviewed |
| Cloud/hybrid deployment | Same container images apply; documented, not executed |
| Health checks | `GET /healthz` and `/readyz` verified locally against the running API |
| Logs | Structured pino JSON observed; secrets redacted |
| Backup completed | Script implemented (`scripts/backup.sh`) with checksum and retention; **not executed against a container** |
| Restore successfully tested | Script implemented (`scripts/restore.sh`) with checksum verification and `CONFIRM_RESTORE` guard; **not executed** |
| Upgrade procedure | Forward-only migration runner verified; full upgrade cycle not rehearsed on a container |
| Monitoring | Not implemented (no Prometheus/Grafana/alerting) |

Do not go live until a backup→restore drill passes on the customer host.

## Gate F — Release

**Status: PARTIAL**

| Criterion | Evidence |
| --- | --- |
| Automated suite passes | 57 tests, 0 failures (`npm test`, real PostgreSQL 17.11) |
| End-to-end acceptance tests | API-level acceptance scenarios pass; browser-driven E2E (Playwright) not written |
| Performance results documented | **Not measured.** No load test was run; no throughput/latency figures are claimed |
| Known limitations documented | Yes (README, this report, register) |
| Release notes | `RELEASE-NOTES.md` |
| Installation and admin documentation | `docs/INSTALL.md`, `docs/ADMIN.md`, `docs/USER-GUIDE.md`, `docs/API.md`, `docs/DEVELOPER.md` |

## Verification commands and observed results

```
npm test                     → tests 57, pass 57, fail 0 (unit + product-scoping + security + notifications + outbox + expanded modules + integration)
npm run build -w @hospitality/api → exit 0
npm run build -w @hospitality/web → exit 0 (43 modules, ~292 kB JS, 87 kB gzip)
npm run typecheck (api, web)  → exit 0
GET /healthz                 → {"status":"ok","service":"hospitality-core-api"}
GET /readyz                  → database reachable
node scripts/verify-db.mjs    → 11 integrity checks, all passed
node scripts/seed.mjs         → 73 modules, 217 permissions seeded
migrations                   → 26 applied, checksums tracked
```

## Go-live conditions (must be met by the operator)

1. Run `scripts/verify.sh` on the target host and keep the output.
2. Provision the tenant, set `ALLOW_API_SETUP=false`, restart.
3. Configure TLS, restrict database network access, rotate all example secrets.
4. Take a backup, restore it into a scratch database, and verify the trial balance.
5. Run a pilot shift in parallel with the legacy system before cutover.
6. Train staff on the workflows that exist; treat "register + create" screens as data capture, not
   as the full process for that module.

## Honest summary

The operational core of a hotel, restaurant and bar — reservations through folio settlement,
kitchen routing, stock, payments, licensing, audit and tenant isolation — is implemented, exercised
by an automated suite against a real database, and exposed through a working web client. The 44-module
hotel catalogue now has storage, endpoints and tests behind every module rather than catalogue
placeholders. Native mobile apps, container execution, performance data, a penetration test, and
process depth inside several specialised modules are **not** delivered. Treat this as a strong,
test-backed foundation, not as a certified complete ERP.
