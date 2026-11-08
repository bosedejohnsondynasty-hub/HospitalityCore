# Compliance audit — Master AI Builder Prompt v2.5

**Subject:** Hospitality Core repository (`/workspace/chats/3d8bcf9d0591cd92e482ee26`)
**Source of truth:** *Hospitality Core — Master AI Builder Prompt, v2.5, 08 November 2026* (172 KB, read in
full for this audit), together with the consolidated master specification, product catalogue and PRD it
cites.
**Audit date:** 2026-11-08 · **Auditor:** builder (self-audit) · **Verdict: not compliant with the full
v1.0 build contract.**

## 1. What this audit is, and is not

This is a clause-level comparison of the specification against the working tree, the applied database
migrations and an executed test run. It is **not** a claim that the software is finished, and it does not
certify anything the specification reserves for independent validation (security assessment, penetration
test, legal/statutory sign-off, provider certification, UAT).

The specification's own rule (Part VI §16) is followed here: no capability is called implemented because
a menu, route, table or screen exists, and no scope is quietly dropped because it is large.

## 2. Evidence collected during this audit

| Check | Command / source | Result |
| --- | --- | --- |
| Migration chain | `node scripts/migrate.mjs` | 26 migrations applied on PostgreSQL 17.11, checksum tracked |
| Test suite | `npm test` (real DB) | 57 tests, 57 pass, 0 fail |
| Typecheck | `npm run typecheck` (api + web) | clean |
| Database integrity | `node scripts/verify-db.mjs` | 11/11 checks (3 products, 73 modules, 217 permissions) |
| Web build | `npm run build -w @hospitality/web` | 44 modules transformed, 313 kB JS |
| Route inventory | `apps/api/src/routes/index.ts` | ~150 endpoints across 28 groups |
| Schema inventory | `information_schema` query | 168 tables; 0 missing `created_at`/`updated_at` after this audit's fix |
| Placeholder scan | `grep -r "TODO\|FIXME\|coming soon\|lorem ipsum"` | no matches in `apps/`, `docs/`, `README.md` |
| Source catalogue | `licensing.module_catalogue` | exactly 44 hotel modules, 17 restaurant, 8 bar |
| Navigation | `apps/web/src/App.tsx` | 11 authenticated pages, all routed; no dead links |

## 3. Scorecard by Part

| Part | Area | Status | Summary |
| --- | --- | --- | --- |
| I | Depth standard (hierarchy, per-module spec pack, minimum depth, screen standard) | **Not met** | Most modules have one register + one create path, not multiple submodules with their own screens/workflows. No breadcrumbs, submodule navigation, record detail pages with tabs, or domain workspaces (room rack, housekeeping board, approval queue) |
| II | 44 canonical hotel modules | **Partial** | All 44 exist in the catalogue with storage/API surface; **none** meets the module Definition of Done. 2 modules are effectively unimplemented (Minibar, Tax & Statutory) |
| III | Restaurant & Bar depth | **Partial** | Order lifecycle, KDS routing, recipes/costing, QR ordering, reservations, loyalty exist. Split bills, tab lifecycle, happy-hour engine, delivery/dispatch, bottle/glass/keg depletion and gateway fee reconciliation do not |
| IV | Data, transaction and control requirements | **Mostly met (data), partial (controls)** | UUID/NUMERIC/TIMESTAMPTZ/snake_case, tenant FKs, RLS, append-only ledgers and exclusion constraints are in place. Audit stamps were missing on 136 tables and are fixed here; per-row actor columns, approval thresholds and several cross-module contracts are still missing |
| V | Execution gates 0–9 | **Partial** | Gates 4–6 partially evidenced. Gates 7–9 (cross-module, hardening, release) not evidenced: no performance, backup/restore, DR, accessibility or UAT evidence |
| VI | Operating rules and required outputs | **Partial** | No TODOs, fake APIs or local-only persistence. Required artefacts (ledger, crosswalk, decision register, product boundary matrix) were missing and are added here; ERDs, data dictionary, screen inventory, UAT scripts and DR runbooks remain missing |
| VII | Master instruction and portfolio | **Not met** | 3 of 6 product domains are absent (Website/CMS, Direct Booking Engine, Channel Manager/CRS). Zero-fee direct booking cannot be demonstrated because direct booking does not exist |
| Maintenance spec | Dedicated Maintenance & Engineering module | **Not met** | A generic request/work-order flow exists; the mandated checklist engine, guest-room location category, Electrical/Plumbing workspaces, statutory register, permits, PM scheduler, contractors and reliability reporting do not |
| VIII | Full-platform critical review | **Not met** | Control plane/subscription billing, privacy operations, deployment profiles, migration tooling, hardware gateway, AI governance and production operations are absent or partial |
| IX | v2.5 taxonomy, six product boundaries and additions | **Partial** | Ten domains exist as data groupings, not as navigation. Identity capture, locks, concierge, IT assets, revenue assurance, physical room lifecycle and emergency management are missing |

## 4. Findings

Severity: **A** = release blocker under the specification, **B** = high, **C** = medium, **D** = low/
documentation.

### A. Scope and product boundaries

**F-01 (A) — Three product domains do not exist.**
*Requirement:* Part VII and Part IX §1 require six independently operable domains: Hotel ERP/PMS, Hotel
Website/CMS, Direct Booking Engine, Channel Manager/CRS, Restaurant, Bar.
*Evidence:* no code, schema or route for website/CMS, booking engine or channel connectivity
(`grep` for booking engine/CMS/channel manager returns nothing outside the internal
`guestops.channel_inventory` table).
*Impact:* the product portfolio is 3/6. Zero-fee direct booking, ARI distribution, stale-acknowledgement
handling and OTA reconciliation cannot be tested.
*Remediation:* build as separate deployable surfaces with their own entitlement rows; do not fake a
connector. First slice: booking engine availability→quote→hold→confirm against the existing reservation
service, then a channel provider adapter with a real sandbox credential.

**F-02 (A) — No module specification pack exists.**
*Requirement:* Part I §2 and the "Mandatory next-stage" §1 require, per module, a charter, submodule
register, role matrix, screen inventory, data dictionary, workflow catalogue, rule catalogue, API/event
catalogue, integration map, report catalogue, test pack and readiness notes.
*Evidence:* no such documents in `docs/`; `docs/REQUIREMENTS-TRACEABILITY.md` is a business-requirement
matrix, not a module specification.
*Remediation:* author one spec per module before deepening it. `docs/BUILD-LEDGER.md` now records status
so this can be done module by module without losing the register.

### B. Functional depth

**F-03 (A) — The enterprise UI standard is not met.**
*Requirement:* Part I §5 — role-aware module/submodule navigation, breadcrumbs, operational workspaces
(reservation calendar, room rack, housekeeping board, approval queues, cashier shift, function sheet),
record detail pages with tabs, bulk actions, tablet/mobile frontline flows, accessibility.
*Evidence:* 11 screens. `Operations.tsx` is a single generic register + create form for 27 resources —
exactly the "single generic Manage [module] page" the specification forbids as module evidence.
*Remediation:* introduce a module shell (breadcrumb, submodule tabs, contextual actions) and one real
workspace per operational domain, starting with Room rack and Housekeeping board.

**F-04 (A) — Core PMS workflows named in the global acceptance catalogue are missing.** *Amend, cancel and
no-show were built during this review; room move, split folio, direct bill and audit reopen remain.*
*Requirement:* Part V §14 — "Reservation amendments; no-show; room move; early/late check-in/out; split
folio; direct bill; night audit and reopen governance".
*Evidence:* reservations support create/allocate/check-in; amend, cancel and no-show now exist
(`PATCH /hotel/reservations/:id`, `POST …/cancel`, `POST …/no-show`, covered by a negative-path test).
Room move, split folio, direct bill and audit reopen still do not.
*Remediation done:* amend blocks changes under a live allocation, cancel requires a reason and releases
the room, no-show is refused before the business date reaches arrival. Next: room move, split folio,
direct bill.

**F-05 (A) — Maintenance & Engineering is a ticket log, not the specified module.** *Partially remediated:
trades, locations, checklist engine, handoff, verification and the room gate are now built; permits,
statutory register, PM scheduler, contractors and screens remain.*
*Requirement:* dedicated Maintenance specification §1–§12 and the critical-review §1–§16: guest-room
location category, separate Housekeeping/Maintenance/Electrical/Plumbing workspaces, configurable
checklist engine with weekly/monthly/custom recurrence and versioning, HK→Maintenance handoff with
traceability, room-readiness verification gate, statutory compliance register, permits/isolation,
emergency intake, PM and meter triggers, contractors, critical spares, reliability metrics.
*Evidence:* migration 025 adds `maintenance.teams` (Electrical, Plumbing, HVAC, General, extensible),
`maintenance.locations` plus a `security_invoker` guest-room projection, checklist templates/items with
recurrence and versioning, duplicate-safe instances, recorded results and configurable SLA targets.
`POST /hotel/maintenance/faults` performs the housekeeping handoff with trade routing; work orders now
inherit room, location, team and readiness impact; verification is four-eyes; housekeeping cannot mark a
room ready while a room-affecting job is open (`ROOM_MAINTENANCE_HOLD`). Covered by three integration
tests.
*Remaining:* permit-to-work/isolation, statutory compliance register and certificates, preventive
scheduler with meter triggers, contractor governance, critical spares, technician handover, dashboards
and operator screens.

**F-06 (A) — Guest registration, identity capture and lock integration are absent.**
*Requirement:* Part IX §4.1/4.3 and §5 — document/photo capture, private storage, masking, provenance,
retention/legal hold, least-privilege permissions, no-device fallback; lock credential lifecycle.
*Evidence:* no schema, route or storage abstraction; `hotel.guests` holds text contact fields only.
*Remediation:* start with a storage abstraction + metadata table + masked read + permission split
(view metadata / view image / capture / verify / export / delete) before any UI.

**F-07 (B) — Tax and statutory rules are hard-coded rather than configurable.**
*Requirement:* Part IV §10 and Part VI §16 — do not hard-code country-specific tax/payroll/statutory
rules; keep them configurable and recorded for owner approval.
*Evidence:* `workforce.ts` implements Nigerian PAYE bands and pension percentages inline; outlet and item
`tax_rate` columns are static values with no jurisdiction, effective dating, inclusivity or fiscal
numbering.
*Remediation:* tenant-scoped, effective-dated tax code and payroll-rule tables; current Nigerian
schedule becomes seeded demo configuration, recorded as decision D-01.

**F-08 (B) — Approval thresholds and maker-checker coverage are partial.**
*Requirement:* Part IV §10 — approval thresholds by amount/currency/branch/role; maker-checker for
purchasing, payments, refunds, discounts, payroll, journals, stock adjustments, rate overrides, audit
overrides.
*Evidence:* enforced for purchase orders, refunds, maintenance requests and payroll posting. Manual
journals, stock adjustments, discounts/voids and night-audit overrides have permission checks but no
second approver or amount threshold.
*Remediation:* a configurable approval-limit service (amount, currency, role, transaction type) used by
those paths.

**F-09 (B) — Cashiering has no shift/till lifecycle.**
*Requirement:* Part II §13 and Part III §6 — float issue/return, cash drops, handover, variance, shift
close, settlement reconciliation.
*Evidence:* payment intents, refunds and folio settlement only; `restaurant.pos_sessions` has no API.
*Remediation:* till/shift open → movements → close with counted cash and variance approval.

**F-10 (B) — Reporting lacks governed KPI definitions and drill-through.**
*Requirement:* Part VIII §9 — every KPI with owner, formula, numerator/denominator, basis, timezone,
currency, freshness and reconciliation source; exception workbenches.
*Evidence:* reports are computed in `reports.ts`/services from live data (good) but formulas are not
registered or documented per KPI, there is no drill-through to source rows, no as-of reporting and no
revenue-assurance exception queue.
*Remediation:* KPI registry table + report endpoints returning source references.

### C. Data, security and operations

**F-11 (B) — Per-row actor auditing is missing (this audit fixed timestamps only).**
*Requirement:* Part IV §8 — every mutable record carries `created_at/by`, `updated_at/by`, tenant and
scope; Part IX §5 requires capture provenance for identity data.
*Evidence:* audit stamps were missing on 136 of 168 tables. **Fixed** by migration 024 (all business
tables now have `created_at`/`updated_at` and a shared touch trigger, verified on a live row). 158 tables
still have no `created_by`/`updated_by` because actor identity is not propagated into the unit of work.
*Remediation:* extend `withTenant()` to accept the authenticated actor and set
`app.actor_id`; a BEFORE INSERT/UPDATE trigger fills the columns. This is a one-migration, one-helper,
plus call-site change.

**F-12 (B) — Privacy operations do not exist.**
*Requirement:* Part VIII §5 — data inventory/classification, consent, retention, legal hold, subject
access/export/correction/erasure with evidence.
*Evidence:* consent fields exist on guest rows; no request workflow, retention schedule or legal hold.
*Remediation:* privacy request table + workflow + permission split; block on owner/legal decision D-02.

**F-13 (B) — Deployment, backup and recovery are unverified.**
*Requirement:* Part V §15 and Part VIII §11 — RPO/RTO, tested restore, DR, deployment profiles,
feature flags, health checks.
*Evidence:* `Dockerfile.api`, `Dockerfile.web`, `docker-compose.yml` and health endpoints exist; this
environment has no Docker daemon and no `pg_dump`/`pg_restore`, so restore has **not** been demonstrated.
*Remediation:* run restore rehearsal on a host with PostgreSQL client tools; record timings in
`docs/PRODUCTION-READINESS.md`.

**F-14 (B) — No performance, accessibility or penetration evidence.**
*Requirement:* Part V §15, Part VIII §11 (WCAG 2.2 AA), Part VIII §5 (OWASP ASVS, SAST/DAST/SCA, SBOM,
pen test).
*Evidence:* none of these have been executed. The UI uses semantic elements but has not been audited
with a screen reader or keyboard-only pass.
*Remediation:* none of this can be asserted without running the tools; schedule before any release claim.

**F-15 (C) — Subledgers and financial statements are incomplete.**
*Requirement:* Part VIII §4 — AR/AP subledgers, ageing, statements, bank reconciliation, P&L, balance
sheet, cash flow, period close/reopen, consolidation, tax/fiscalisation.
*Evidence:* double-entry ledger, trial balance, period-open guard and revenue report; no statements, no
bank reconciliation, no consolidation, single-currency.
*Remediation:* statements first (they are deterministic from the ledger), then bank reconciliation.

**F-16 (C) — Inventory lacks counts, transfers, batches and valuation reporting.**
*Requirement:* Part II §19.
*Evidence:* receipts/issues/adjustments/balances with append-only movements; no transfer, count,
batch/expiry/serial or valuation report.
*Remediation:* transfer + count (with approval on variance) are the next highest-value pair.

**F-17 (C) — Procurement stops before receiving and payables.**
*Requirement:* Part II §20 and Part IV §9 (procurement → inventory/AP contract).
*Evidence:* supplier, PO, approval and invoice three-way match; no GRN route and no payable creation.
*Remediation:* GRN against PO lines, then AP invoice registration with match status.

**F-18 (C) — Channel, central reservation and group sales lack their core workflows.**
*Requirement:* Part II §29–§31, Part VIII §2.
*Evidence:* internal allocation register, call logs and tour packages only; no provider adapter,
multi-property availability search, rooming lists or group billing.
*Remediation:* multi-property availability is a prerequisite for both CRS and booking engine; do it first.

**F-19 (C) — Offline support is command-level only.**
*Requirement:* Part VIII §6 — per-workflow offline policy, cached data, expiry, device trust, conflict
policy, operator-visible sync status.
*Evidence:* `mobile.sync_commands` with `command_id` idempotency and a conflict queue; no offline policy
per workflow and no UI.
*Remediation:* document the allowed offline workflows and expose sync status before claiming offline.

**F-20 (C) — No data migration tooling.**
*Requirement:* Part VIII §7 — mapping, dry runs, control totals, exception queues, repeatable imports.
*Evidence:* seed and demo scripts only.
*Remediation:* import templates + dry-run/control-total harness.

**F-21 (D) — Builder artefact trail was incomplete.**
*Requirement:* Part VI §16–§17 — live build ledger, source crosswalk, decision register, risk register,
product boundary matrix, acceptance catalogue.
*Evidence:* none existed before this audit. **Fixed** by adding `docs/BUILD-LEDGER.md`,
`docs/COMPLETENESS-PACK.md` (source register, crosswalk, boundaries, system of record, risks,
acceptance catalogue, sequence) and `docs/DECISION-REGISTER.md`.
*Remaining:* ERD, data dictionary, screen inventory, wireframes, UAT scripts, training material.

**F-22 (D) — No version-control evidence.**
*Requirement:* Part VI §18 — evidence cites a commit/build reference.
*Evidence:* the whole tree is untracked (`git status` shows no commits). Nothing has been committed,
pushed or deployed in this work.
*Remediation:* commit in reviewable increments once the owner authorises it.

## 5. Instructions the builder did carry out

Reported so the owner can see behaviour compliance separately from feature compliance:

| Instruction | Status |
| --- | --- |
| Do not ask the owner to repeat requirements already stated | Followed; this audit works from the supplied source |
| Do not silently downgrade scope | Followed; gaps are listed rather than dropped |
| Do not claim a migration/test/deployment ran unless it did | Followed; every command in §2 was executed and its exit status checked |
| Do not represent a module as complete on menus/tables/CRUD | Followed; no module is marked complete |
| Maintain a live build ledger and update it per increment | Now complied (`docs/BUILD-LEDGER.md`) |
| Do not invent statutory/tax/payroll policy | **Not yet complied in code** (F-07); recorded as decision D-01 |
| Keep tenant data isolated in UI, API, jobs, exports, logs | Complied and tested (`security.test.ts`, RLS, tenant-scoped queries) |
| Use real database-backed data; no fake APIs or browser storage | Complied; the one browser-stored item is the session token |
| No TODOs, placeholder pages, fake buttons | Complied by scan; the Business tools page performs real writes for every resource it lists |
| Record unimplemented scope honestly | Complied; this document is the record |

## 6. Verdict and release position

The repository is a **test-backed foundation**, not a completed v1.0 product. Concretely:

- **Delivered and proven here:** tenant isolation, RLS, licensing/entitlement gating, double-entry
  ledger with immutable postings, reservation/folio/check-in, POS to folio, recipe depletion, night
  audit blocking, payroll posting, fixed assets, 44-module catalogue with storage and licence-gated
  endpoints, and 57 passing tests against a real database.
- **Missing before any production claim:** 3 product domains, module specification packs, operational
  workspaces, PMS amendments/no-show/room-move, maintenance depth, identity capture, tax/payroll
  configuration, privacy operations, performance/accessibility/security testing, backup-restore
  rehearsal, migration tooling and UAT.
- **Release declaration:** not made. `docs/PRODUCTION-READINESS.md` continues to describe gates rather
  than a certified release, and this audit supersedes any earlier wording that implied breadth equals
  completeness.
