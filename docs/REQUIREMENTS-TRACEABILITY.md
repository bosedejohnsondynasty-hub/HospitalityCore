# Requirements traceability register

Sources: the two supplied conversation exports, treated as one project history:

- `Expand Hotel ERP System.html` — S1
- `Expand Hotel ERP System (2).html` — S2

Classification: **EA** explicitly agreed · **AR** accepted recommendation · **PNC** proposed but not
confirmed · **TIR** technical implementation recommendation · **UD** unresolved decision.

Status: **Implemented & tested** · **Implemented (unit/API only)** · **Partial** · **Catalogue only**
· **Not implemented**.

## Platform and ecosystem

| ID | Requirement | Source | Product / module | Implementation | Test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P-01 | Three independent products in one ecosystem | S1, S2 (EA) | All | `db/seed/001_catalogue.sql`, licensing modules | `provisioning creates products…`, `tenant isolation…` | Implemented & tested |
| P-02 | Restaurant works without Hotel | S1 (EA) | Restaurant | Product-scoped modules; no hotel FK required | Restaurant test runs within a tenant that also has hotel; see limitation L-03 | Implemented (product independence at licence/module level); dedicated hotel-free tenant exercised in `tenant isolation` | 
| P-03 | Bar works without Hotel or Restaurant | S1 (EA) | Bar | Same mechanism | Bar flow tested with hotel present | Partial (product-level gate verified, hotel-free operation not automated) |
| P-04 | Add a product later without destructive migration | S1 (EA) | Licensing | Activations are rows; no schema change per product | `licensing` activation test | Implemented & tested |
| P-05 | Central module and licence centre | S1 (EA) | Licensing | `licensing.*`, `GET /licensing/catalogue`, activate/deactivate | `unlicensed modules are locked server side` | Implemented & tested |
| P-06 | Unlicensed modules visible but locked | S1 (EA) | Licensing | Catalogue returns all modules with `licensed` flag; `requireModule` returns 402 | same | Implemented & tested |
| P-07 | Independent licensing per product and module | S1 (EA) | Licensing | Product subscriptions + module activations | same | Implemented & tested |

## Hotel ERP catalogue (44 modules)

Module names and the 9/18/17 categorisation are preserved in `db/seed/001_catalogue.sql` and shown
in the Licence centre. Depth varies; the table records the truth.

| # | Module | Category | Implementation status |
| --- | --- | --- | --- |
| 1 | Guest Management | Core | Implemented (profiles, list, create) |
| 2 | Reservation & Booking | Core | Implemented & tested (create, amend, cancel, no-show, allocate, availability, no double booking) |
| 3 | Front Office Operations | Core | Implemented & tested (check-in, check-out, room status) |
| 4 | Housekeeping | Core | Implemented & tested (tasks, checklist, inspection, readiness) |
| 5 | Point of Sale | Core | Implemented (restaurant/bar POS endpoints and UI) |
| 6 | Restaurant & Bar Management | Core | Implemented & tested |
| 7 | Inventory & Stock Control | Core | Implemented & tested (receipt, issue, adjustment, balances, movements) |
| 8 | Cashiering & Payment Operations | Core | Implemented & tested (intents, settlement, refunds, folio settlement) |
| 9 | Night Audit & Daily Closure | Core | Implemented & tested (room charges, exceptions, override, business date) |
| 10 | Financial Accounting | Back office | Implemented & tested (COA, journals, periods, trial balance, posting links) |
| 11 | Budget & Cost Control | Back office | Implemented & tested (budget header + lines, approval/lock, variance against posted journal actuals) |
| 12 | Procurement & Purchasing | Back office | Partial (suppliers, PO + approval, GRN, invoice, three-way exception) |
| 13 | HR & Staff Information | Back office | Implemented & tested (employee register, departments, branch, termination) |
| 14 | Payroll Management | Back office | Implemented & tested (PAYE/pension, payslips, one accrual posting, net-pay settlement) |
| 15 | Attendance & Duty Scheduling | Back office | Implemented & tested (rosters with overlap rejection, attendance records) |
| 16 | Tax & Statutory Compliance | Back office | Partial (configurable tax rates on items, VAT payable account) |
| 17 | Fixed Assets | Back office | Implemented & tested (capitalisation, monthly depreciation, disposal gain/loss) |
| 18 | Maintenance & Engineering | Back office | Implemented & tested (trade-routed faults with SLA, four-eyes approval and verification, work orders with guarded transitions, guest-room location category, checklist engine with recurrence and dedupe, HK handoff, room-readiness gate, room history) |
| 19 | Laundry | Back office | Implemented & tested (cycles, item lines, returned/lost/damaged accountability gate, completion event) |
| 20 | Cash Management & Treasury | Back office | Implemented & tested (ledger-derived bank positions, exactly-once posted transfers, audit trail) |
| 21 | Contract & Agreement | Back office | Implemented & tested (register, value, term dates, guarded status transitions) |
| 22 | Insurance & Risk | Back office | Implemented & tested (policies, claims open→review→approved→paid, recovery/paid caps) |
| 23 | Quality Assurance | Back office | Implemented & tested (scheduled inspections, score/result, corrective actions with completion) |
| 24 | Utilities & Energy | Back office | Implemented & tested (meters, one reading per meter/date, consumption and cost, per-meter summary) |
| 25 | Security & Loss Prevention | Back office | Implemented & tested (incident register with severity and close-out, patrols with status flow) |
| 26 | Document & Compliance | Back office | Implemented & tested (register with retention/review dates, activation, follow-up actions) |
| 27 | Management Reporting & BI | Back office | Partial (dashboard, occupancy, daily sales, trial balance, revenue) |
| 28 | Banquet & Events | Specialised | Implemented & tested (enquiry→completed lifecycle, charge lines with server-computed totals, completion event) |
| 29 | Sales & Marketing | Specialised | Implemented & tested (campaigns, opportunities with weighted pipeline, monotonic stage flow) |
| 30 | CRM | Specialised | Implemented & tested (segments with criteria, guest/customer interactions, satisfaction score, completion) |
| 31 | Channel & Online Booking | Specialised | Implemented & tested (per-date channel allocation, sold-units guard, rate-parity flag) |
| 32 | Revenue Management | Specialised | Implemented & tested (daily forecast with occupancy/ADR, approval, portfolio summary) |
| 33 | Group & Multi-Branch | Specialised | Partial (branch, organization and legal-entity model; branch filter on reports) |
| 34 | Guest Self-Service & Mobile App | Specialised | Partial (public QR guest ordering; no guest portal) |
| 35 | Notifications & Communication | Specialised | Implemented & tested (queue, worker delivery with retry/backoff, licence-gated; email needs an SMTP relay, SMS/push pending a provider adapter) |
| 36 | Integration & Payment Gateway | Specialised | Implemented & tested (Paystack, Flutterwave, adapters) |
| 37 | Spa, Wellness & Recreation | Specialised | Implemented & tested (resources, overlapping booking rejected, cancellation) |
| 38 | Minibar | Specialised | Partial (folio charge type, housekeeping discrepancy table) |
| 39 | Group, Tour & Travel | Specialised | Implemented & tested (packages, capacity-checked group bookings with computed value) |
| 40 | Central Reservation & Call Centre | Specialised | Implemented & tested (call logs, central bookings with held→confirmed→converted/cancelled) |
| 41 | Food Safety & Kitchen Compliance | Specialised | Implemented & tested (checks, temperature/reading logs with pass/fail, corrective action, completion) |
| 42 | Guest Credit & Corporate Billing | Specialised | Implemented & tested (corporate accounts with credit limit, invoices posted Dr receivable/Cr revenue once, settlements posted once) |
| 43 | Staff Training & LMS | Specialised | Implemented & tested (courses with validity window, enrolments, duplicate refusal, completion with certificate) |
| 44 | Franchise & Brand Standards | Specialised | Implemented & tested (standards, audits with score, corrective actions, standard score rollup) |

Every module in this table now has database storage, a licence-gated API surface and executable
evidence. The web client exposes them through **Business tools** (register + create for each module)
and the existing operational screens; what is still shallow is depth of each screen, not absence of
the domain: e.g. banquet function sheets are stored text, channel parity is captured as a status flag
rather than synced with a channel manager, and training certificates are references rather than
uploaded documents.

## Restaurant

| ID | Requirement | Source | Implementation | Test | Status |
| --- | --- | --- | --- | --- | --- |
| R-01 | Restaurant registration/configuration | S2 (EA) | `restaurant.outlets`, onboarding | provisioning test | Implemented & tested |
| R-02 | Multiple outlets/branches | S2 (EA) | Outlet table, branch FK | UI outlet selector | Implemented (single outlet provisioned by default) |
| R-03 | Digital menu management | S2 (EA) | Menus, categories, items | menu/QR test | Implemented & tested |
| R-04 | QR menu generation | S2 (EA) | QR tokens, public menu | QR menu test | Implemented & tested |
| R-05 | QR ordering (table and general) | S2 (EA) | Public order endpoint, optional table | QR order test | Implemented & tested |
| R-06 | Table and dining management | S2 (EA) | Dining areas, tables, sessions | tables endpoint; UI | Partial (sessions wired, floor-plan UI not built) |
| R-07 | Reservations / waitlist | S2 (EA) | Conflict-safe dining periods (GiST exclusion constraint), table-party checks, waitlist seating | reservation overlap + waitlist test | Implemented & tested |
| R-08 | Walk-in/dine-in/takeaway/online/delivery | S2 (EA) | `channel` column, order creation | POS/website channels tested | Implemented (channel captured; delivery dispatch not built) |
| R-09 | POS and cashiering | S2 (EA) | Orders + payment intents | cash payment test | Implemented & tested |
| R-10 | Kitchen order management / KDS | S2 (EA) | Kitchen tickets, station routing, status flow | kitchen routing test | Implemented & tested |
| R-11 | Recipe & ingredient management | S2 (EA) | Recipes, ingredients, deduction on completion | 9.6 kg assertion | Implemented & tested |
| R-12 | Portion control / food cost | S2 (EA) | Recipe yield, wastage percent, plate cost from inventory standard cost | `/restaurant/food-cost` test (962.50 plate cost) | Implemented & tested |
| R-13 | Wastage and production | S2 (EA) | Stock adjustments | adjustment auth test | Partial |
| R-14 | Inventory/procurement | S2 (EA) | Shared inventory/procurement | receipt tests | Implemented & tested |
| R-15 | Customer, loyalty, promotions | S2 (EA) | Customers, append-only loyalty ledger with earn/redeem, promotions with window/minimum-spend quote | loyalty + promotion tests | Implemented & tested |
| R-16 | Restaurant staff/workforce | S2 (EA) | Roles and permissions | permission tests | Partial |
| R-17 | Restaurant finance & analytics | S2 (EA) | Revenue account, daily sales | revenue-once test | Implemented & tested |
| R-18 | Pay-before / pay-after | S2 (EA) | `payment_timing` per outlet/order | QR order returned `pay_after` | Implemented (config + flow); pay-before UI flow partial |
| R-19 | Paystack + Flutterwave + adapter framework | S1, S2 (EA) | `ProviderAdapter`, signature verification | webhook tests | Implemented & tested (Paystack end-to-end; Flutterwave adapter unit-level) |
| R-20 | Refunds with approval | S2 (EA) | Refund request/approve, four-eyes | refund auth test | Implemented & tested |

## Bar

| ID | Requirement | Source | Implementation | Test | Status |
| --- | --- | --- | --- | --- | --- |
| B-01 | Bar setup/configuration | S2 (EA) | `bar.outlets`, onboarding | provisioning | Implemented & tested |
| B-02 | Beverage menu | S2 (EA) | Beverages, categories, pricing | bar test | Implemented & tested |
| B-03 | Bar POS / orders | S2 (EA) | Orders, lines, totals | bar order test | Implemented & tested |
| B-04 | Beverage stock control | S2 (EA) | Inventory mapping, deduction | 100 → 98 bottles | Implemented & tested |
| B-05 | Drink/cocktail recipes and costing | S2 (EA) | Recipe tables and endpoint | — | Partial (API only, no UI form) |
| B-06 | Bar customers | S2 (EA) | Guest/customer identity shared | — | Partial |
| B-07 | Events and entertainment | S2 (EA) | `bar.events`, `bar.event_bookings` with capacity guard | event booking test | Implemented & tested |
| B-08 | Bar finance/reporting | S2 (EA) | Revenue account 4200, daily sales | revenue-once test | Implemented & tested |
| B-09 | Bar security/internal controls | S2 (EA) | Roles, audit, refund approval | auth tests | Implemented & tested |

## Cross-product, security, operations

| ID | Requirement | Source | Implementation | Test | Status |
| --- | --- | --- | --- | --- | --- |
| X-01 | Restaurant charge to hotel folio | S1, S2 (EA) | `chargeOrderToFolio`, receivable + revenue once | cross-product test | Implemented & tested |
| X-02 | Bar charge to hotel folio | S1, S2 (EA) | same | cross-product test | Implemented & tested |
| X-03 | No duplicate revenue | S1, S2 (EA) | `posting_links` unique key | posting-link count assertion | Implemented & tested |
| X-04 | Unlicensing one product must not corrupt another | S1 (EA) | Per-tenant module activations | isolation test | Implemented & tested |
| S-01 | Auth, MFA, password hashing, sessions | S1 (AR) | scrypt, SHA-256 tokens, TOTP | unit tests | Implemented & tested |
| S-02 | Role and permission enforcement | S1 (EA) | RBAC templates + route guards | auth tests | Implemented & tested |
| S-03 | Tenant isolation | S1 (EA) | RLS + restricted role | isolation test + direct SQL check | Implemented & tested |
| S-04 | Rate limiting, headers, CORS | S1 (AR) | plugins + allowlist | — | Implemented (config-level; no automated test) |
| S-05 | Audit trail | S1 (EA) | append-only audit events | audit read test | Implemented & tested |
| S-06 | Secure file uploads | S1 (EA) | none | — | Not implemented |
| S-07 | Threat model | S1 (EA) | `docs/SECURITY.md` | — | Documented |
| O-01 | Docker deployment | S1 (EA) | Dockerfiles, compose, entrypoint | Not executed here (no daemon) | Implemented, unverified in this environment |
| O-02 | Health checks | S1 (EA) | `/healthz`, `/readyz`, container healthchecks | API readiness verified locally | Implemented & partially verified |
| O-03 | Backup | S1 (EA) | `scripts/backup.sh` | Not executed against a container | Implemented, unverified |
| O-04 | Restore | S1 (EA) | `scripts/restore.sh` | Not executed | Implemented, unverified |
| O-05 | Monitoring/logging | S1 (EA) | structured pino logs | local log inspection | Partial (no metrics/alerts) |
| O-06 | Upgrade/rollback procedure | S1 (EA) | forward-only checksummed migrations; restore-based recovery | migration run verified | Implemented (documented); rollback not automated |
| M-01 | Waiter mobile | S1, S2 (EA) | responsive PWA + sync API | sync tests | Partial (PWA, not native Flutter) |
| M-02 | Owner/management mobile | S1 (EA) | responsive PWA | — | Partial |
| M-03 | Housekeeping mobile | S1 (EA) | PWA + offline command | sync test | Implemented & tested (sync); PWA screens partial |
| M-04 | Maintenance mobile | S1 (EA) | offline command type | — | Partial |
| M-05 | Offline sync idempotency/conflicts | S1, S2 (EA) | command ids, conflict table | sync test | Implemented & tested |
| F-01 | Payroll/PAYE/pension | S1 (EA) | `workforce` schema, PAYE bands + pension, payroll runs, payslips, accrual and payment postings | payroll test | Implemented & tested |
| F-03 | Fixed assets and depreciation | S1 (EA) | asset register, straight-line monthly runs, disposal gain/loss | asset test | Implemented & tested |
| F-02 | Statutory tax configurability | S1 (EA) | per-item tax rate; no hard-coded law | — | Partial |

## Unresolved decisions

| ID | Question | Impact | Current handling |
| --- | --- | --- | --- |
| UD-1 | Native Flutter apps vs PWA | Mobile delivery | PWA + sync API implemented; native apps not built |
| UD-2 | Offline licence validation scheme (signed file? hardware id?) | Licensing | Server-side activation only |
| UD-3 | Approval threshold matrix (who may approve what amount) | Financial controls | Second-user approval, no thresholds |
| UD-4 | Fiscalisation / statutory e-invoicing per country | Compliance | Configurable tax, no e-invoicing |
| UD-5 | Delivery dispatch integration (riders, zones, fees) | Restaurant | Channel captured; dispatch not built |
| UD-6 | Multi-currency posting vs display-only | Finance | Single functional currency per tenant; no FX revaluation |
| UD-7 | Shared capability modules vs strictly per-product licences | Licensing | Nine codes exist under several products; the runtime check resolves by code, so deactivating one product's copy leaves the capability available while another licensed product defines it. Product-level separation is enforced; per-product granularity for these nine codes is not |

## Source passages

The source files are chat exports with interspersed HTML/JSON. The key passages used for scope:

- S1: initial 44-module hotel catalogue and the three categories.
- S1: insistence that advanced restaurant capability is built in from the start and that Restaurant
  and Bar must be independently licensable.
- S2: Stage 6–9 database sequence (platform → hotel → housekeeping/maintenance → restaurant), payment
  gateway requirements, mobile and offline requirements, production-readiness gates.

Because the exports are large and partly truncated, this register maps requirement **themes and
explicit module names**, not every sentence. Requirements not listed here were not treated as
authoritative.
