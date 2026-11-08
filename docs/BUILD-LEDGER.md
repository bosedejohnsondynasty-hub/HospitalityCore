# Build ledger

Live status of every canonical module and product domain against the governing source:
**Hospitality Core — Master AI Builder Prompt v2.5** (`docs/` source-of-truth Markdown supplied 2026-11-08),
read together with the consolidated master specification, product catalogue and PRD referenced by it.

Status vocabulary is the specification's own (Part VI §18):

| Status | Meaning |
| --- | --- |
| Not started | No storage, service, route or screen |
| In progress | Some workflows exist; the module Definition of Done is **not** met |
| Blocked | Needs an owner decision, credential, hardware or external certification |
| Implemented-unverified | Built, automated tests pass, no UAT / manual evidence |
| Verified complete | Every DoD gate evidenced, including UAT — **no module currently qualifies** |

Last updated: 2026-11-08. Every row below was checked against the working tree, the applied
migrations and the executed test suite in this session; nothing is marked complete on the strength
of a menu item or a table.

## Evidence base

| Artefact | Where |
| --- | --- |
| Migrations | `db/migrations/001…026` (26 applied on PostgreSQL 17.11) |
| API services | `apps/api/src/services/*.ts` |
| Routes | `apps/api/src/routes/index.ts` (single registration point, licence-gated) |
| Tests | `apps/api/test/*.test.ts` — 57 tests, 57 passing |
| Web client | `apps/web/src/pages/*.tsx` (11 authenticated screens + QR menu) |
| Traceability | `docs/REQUIREMENTS-TRACEABILITY.md` (business-requirement level) |
| Compliance audit | `docs/COMPLIANCE-AUDIT-v2.5.md` (clause level, this review) |

## Hotel ERP — 44 canonical modules

Status is deliberately conservative: an endpoint plus a test is **In progress**, because the DoD also
requires the module's own screens, all submodules, UAT and operational evidence.

| # | Module (code) | Status | Built and tested | Principal gaps |
| --- | --- | --- | --- | --- |
| 1 | Guest Management (`guest_management`) | In progress | Guest register (`GET/POST /hotel/guests`), guest rows with contact data | Identity documents/photos, classifications, preferences, merge governance, complaints, privacy/data-subject requests, statements, blacklist |
| 2 | Reservation & Booking (`reservations`) | In progress | Availability search, create, amend (dates/occupancy/room type/rate), cancel with reason and allocation release, no-show with business-date guard, allocate, check-in, exclusion-constraint overlap guard | Deposits & guarantees, packages/add-ons, groups, waitlist, overbooking controls, vouchers, source/commission, room move |
| 3 | Front Office (`front_office`) | In progress | Arrivals/in-house via reservation & stay, check-in, checkout, folio view/charge/settle/reverse | Registration cards, ID/photo capture, room moves, key issue/revoke, in-house list screen, cashier handover, express checkout, exception queue |
| 4 | Night Audit (`night_audit`) | In progress | Business date, blocked-exception run, authorised override with reason, keyed charges (no double posting) | Pre-audit checklist screen, cashier/POS/tax reconciliation, day-end report pack, controlled reopen |
| 5 | Housekeeping (`housekeeping`) | In progress | Task list/create/complete/inspect, checklist read, room-status change, maintenance fault handoff table | Assignment/reassignment, boards, cleaning templates & recurrence, minibar capture, linen, lost property, discrepancy, productivity reports |
| 6 | Laundry (`laundry`) | In progress | Cycle create/list/detail, item accounting gate, complete/cancel, `laundry.completed` event | Guest laundry orders & pricing, linen par, vendor dispatch/receipt, inspection, folio posting, cost reporting |
| 7 | Minibar (`minibar`) | Not started | Storage hint only (`housekeeping.minibar_records`); no API or screen | Catalogue, par levels, consumption, posting, spoilage, variance |
| 8 | Guest Self-Service (`guest_self_service`) | In progress | Public QR menu + order + payment intent (F&B only) | Guest account/auth, pre-arrival, digital registration, service requests, folio view/pay, digital checkout, feedback, localisation |
| 9 | Notifications (`notifications`) | In progress | Queue, retries/backoff, requeue, worker sweep, email via SMTP, outbox relay | Consent/preferences, quiet hours, templates editor, SMS/push/WhatsApp adapters, campaign integration, analytics |
| 10 | POS (`pos`) | In progress | Orders, tables, stations, KDS tickets, status/void, charge-to-folio, recipes, QR ordering, server-side totals | Cashier shift/till/float, split/merge/transfer, tender capture, receipts/invoices, applied discounts at POS, offline queue |
| 11 | Restaurant & Bar, hotel-integrated (`restaurant_bar`) | In progress | Outlets, menus, tables, reservations, orders, bar tabs/orders, room-charge settlement | Outlet operating calendar, staffing, outlet P&L, service recovery, price control screens |
| 12 | Food Safety (`food_safety`) | In progress | Checks + logs create, complete with result/corrective action | Checklist library, receiving inspection, batch/expiry traceability, allergens, sanitation, pest control, calibration, evidence, dashboard |
| 13 | Cashiering (`cashiering`) | In progress | Payment intents, four-eyes refunds, folio settlement, gateway webhooks | Till/shift/float, cash drops, paid-outs, handover & variance, receipts, settlement reconciliation, gateway lookup |
| 14 | Financial Accounting (`financial_accounting`) | In progress | CoA, balanced journals, trial balance, revenue report, period-open guard, immutable lines | AR/AP subledgers, bank reconciliation, P&L/balance sheet/cash flow, recurring journals, accruals, consolidation, close/reopen workflow |
| 15 | Budget & Cost Control (`budget_cost_control`) | In progress | Budget + lines, approve, lock, variance from posted journals | Versions/scenarios, CAPEX/OPEX split, commitments, allocations, variance commentary & thresholds |
| 16 | Treasury (`treasury`) | In progress | Ledger-derived bank positions, transfers posting one balanced journal behind a posting link | Petty cash, cash forecasting, FX & revaluation, bank statements/reconciliation, mandates |
| 17 | Guest Credit & Corporate Billing (`guest_credit`) | In progress | Corporate accounts, credit limit, invoice posting (Dr 1100/Cr 4300) once, settlement once | City ledger transfer, routed/master folios, statements, ageing, credit notes/disputes, collections, write-off approval |
| 18 | Revenue Management (`revenue_management`) | In progress | Forecasts + approval, portfolio occupancy/ADR/revenue summary, per-channel allocation caps | Rate plans & rate calendar screens, restrictions, competitor data, pickup/pace, yield recommendations, displacement, publishing |
| 19 | Inventory (`inventory`) | In progress | Items, stores, balances, movements, receipts, issues, adjustments, append-only ledger | Transfers, counts/cycle counts, batches/serials/expiry, valuation report, reorder rules, reservations, recall/quarantine |
| 20 | Procurement (`procurement`) | In progress | Suppliers, POs, creator≠approver, invoice three-way match exception | Requisitions, RFQ/bid comparison, contracts/pricing, GRN routes, supplier returns/credit notes, scorecards, spend analytics |
| 21 | Fixed Assets (`fixed_assets`) | In progress | Register, capitalisation, disposal with gain/loss, depreciation runs and posting | Categories, tagging, custodian transfers, impairment/revaluation, physical verification, warranty/insurance linkage, schedules |
| 22 | Maintenance & Engineering (`maintenance`) | In progress | Fault intake with trade routing and SLA, four-eyes approval, work orders with a guarded state machine and four-eyes verification, configurable trades (Electrical/Plumbing/HVAC/General), guest rooms as a first-class location category, location register for other areas, weekly/monthly/custom checklist templates with versioning, duplicate-safe generation, mandatory-item and exception-reason rules, failed-item → routed fault, housekeeping helpdesk handoff, room-readiness gate, room history, configurable SLA targets, completion consuming parts, downtime log | Permit-to-work/isolation, statutory compliance register and certificates, preventive-maintenance scheduler and meter triggers, contractor governance, critical spares, technician shifts/handover, dashboards, operator screens (see audit F-05) |
| 23 | Human Resources (`hr`) | In progress | Employee register/create/amend/terminate, department & position fields | Recruitment, contracts/documents, qualifications, leave, disciplinary (restricted), performance, offboarding access revocation, HR analytics |
| 24 | Payroll (`payroll`) | In progress | Run calculation, payslips, accrual posting, net-pay payment, guard triggers | Pay profiles, allowances/deductions configuration, overtime/premiums, tips/service charge, jurisdiction tax configuration, bank file, reversals/off-cycle |
| 25 | Attendance & Scheduling (`attendance_scheduling`) | In progress | Shift roster create with overlap refusal, attendance clock records | Shift templates, demand-based staffing, swaps, overtime approval, timesheets, absence, labour analytics |
| 26 | Training (`training`) | In progress | Courses, enrolments, completion with score/certificate reference | Competency framework, sessions, assessments, certificate files, expiry/renewal, mandatory training, skills matrix |
| 27 | Sales & Marketing (`sales_marketing`) | In progress | Campaigns, opportunities, forward-only stages, weighted pipeline | Leads/accounts, proposals/quotations, activities, targets/commissions, attribution, consent |
| 28 | CRM (`crm`) | In progress | Segments, interactions with satisfaction, completion | Unified identity, consent, service cases/escalation, retention/win-back, audiences, duplicate merge, lifetime value |
| 29 | Channel & Online Booking (`channel_management`) | In progress | Internal channel allocation register with sold-vs-allocation guard | **No external connector**: provider registry, mapping, ARI publish, reservation import, sync queue, parity, commission, health |
| 30 | Group, Tour & Travel (`tours_travel`) | In progress | Tour packages, bookings with capacity guard, cancellation | Group enquiries, agent accounts, quotations, room blocks/allotments, rooming lists, release dates, itineraries, group billing |
| 31 | Central Reservation & Call Centre (`central_reservation`) | In progress | Call logs, central reservations, held→confirmed | Multi-property availability search, agent workspace, queue/assignment, follow-ups, conversion & quality monitoring |
| 32 | Banquet & Events (`banquet_events`) | In progress | Events with lifecycle, server-computed charges, `banquet.completed` | Venue inventory/availability, packages/menus, quotations, contracts/deposits, function sheets, floor plans, resources, run sheets, post-event costing |
| 33 | Spa & Wellness (`spa_wellness`) | In progress | Resources, bookings, overlap refusal, cancellation | Treatment catalogue, therapist profiles, packages/memberships, consent, check-in/execution, retail, utilisation reports |
| 34 | Tax & Statutory (`tax_compliance`) | Not started | Tax rates are columns on items (`tax_rate`) | Jurisdiction/registration, effective-dated tax codes, inclusive/exclusive, withholding, exemptions, fiscal numbering, returns, rule versioning |
| 35 | Insurance & Risk (`insurance`) | In progress | Policies, claims, guarded claim flow, recovery cap | Risk register & scoring, controls, coverage/limits/deductibles, insured assets, renewal calendar, broker contacts, premiums |
| 36 | Quality Assurance (`quality_assurance`) | In progress | Inspections with score/result, corrective actions | Standards library, audit schedules, root-cause, repeat-failure tracking, trend dashboards |
| 37 | Security & Loss Prevention (`security_loss_prevention`) | In progress | Incidents, patrols, status transitions, restricted permission | Investigation case file, evidence/chain of custody, key/access control, loss investigation, analytics, emergency response |
| 38 | Document & Compliance (`documents`) | In progress | Register, actions, activation/close transitions | Versioning, approval, signatures, expiry alerts, distribution, retention/legal hold, policy acknowledgement, evidence packs |
| 39 | Franchise & Brand Standards (`franchise`) | In progress | Standards, audits with scores, corrective actions, per-standard rollup | Brand hierarchy, versioned requirements, self-assessment, evidence, waivers, benchmarking, portfolio reporting |
| 40 | Hotel Group & Multi-Branch (`multi_branch`) | In progress | Tenants, organisations, legal entities, branches, branch-scoped access | Group hierarchy, config inheritance, central policy, inter-branch transfers, consolidation, intercompany, property onboarding, portfolio reporting |
| 41 | Contracts (`contracts`) | In progress | Agreements register with guarded status transitions | Counterparty register, templates/clauses, approval & signature, obligations, renewals/amendments, alerts, performance |
| 42 | Utilities (`utilities`) | In progress | Meters, one reading per meter/day, consumption summary | Provider accounts, tariffs, cost allocation, anomaly alerts, KPIs, sustainability/emissions, invoice validation |
| 43 | Integration & Payment Gateway (`integrations`) | In progress | Paystack/Flutterwave intents + HMAC-verified webhooks, refund approval, outbox, notification adapters, device registration | Provider/credential registry & rotation, gateway settlement/fees, reconciliation, dead-letter ops, health monitoring, versioned contracts, hardware/IoT gateway |
| 44 | Management Reporting & BI (`management_reporting`) | In progress | Dashboard, daily sales, occupancy, trial balance, revenue, food cost, budget variance, utilities & franchise summaries | KPI catalogue with owners/formulas, drill-through, as-of reporting, scheduled delivery, exports, consolidation, exception workbenches, lineage |

## Standalone products

| Product | Status | Notes |
| --- | --- | --- |
| Hotel ERP/PMS | In progress | All 44 modules have some surface; none meets the DoD |
| Restaurant Management | In progress | 17 modules licensed separately; shares platform services; no delivery/dispatch, no restaurant-only accounting boundary, no independent deployment proof |
| Bar Management | In progress | 11 modules; tabs exist as storage only (no tab lifecycle API), no happy-hour engine, no bottle/glass conversion beyond recipes |
| Hotel Website & CMS | Not started | No theme, page builder, content, SEO, domains, publishing or hosting capability |
| Direct Booking Engine | Not started | Availability/quote/payment/confirmation for direct web bookings does not exist; only F&B QR ordering |
| Channel Manager / CRS distribution | Not started (internal only) | Internal allocation register only; no OTA/GDS provider adapter, ARI push, import or reconciliation |

## Mandatory v2.5 additions

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Front Desk Guest Registration, Identity & Digital Capture | Not started | No document/photo storage, OCR, signature or registration record |
| Electronic Lock & Physical Access | Not started | No device registry or credential lifecycle |
| Guest Services & Concierge | Not started | No request/task lifecycle, luggage, wake-up, transport, lost-and-found |
| IT & Digital Infrastructure Management | Not started | No IT asset register, service desk or licence tracking |
| Revenue Assurance & Financial Control | Not started | No exception workbench for unposted charges, unsettled gateway lines, comps/voids |
| Physical Room & Space Lifecycle | In progress | `hotel.rooms` + status change; no blockers, connecting rooms, day-use/house-use, OOO/OOS workflow with authority |
| Business Continuity / Emergency Management | Not started | No plans, incident command, drills or accountability |
| Permit-to-work / isolation | Not started | No permit types, approvals or start-blocking |
| Statutory compliance register | In progress | Documents module can hold certificate references; no compliance calendar, certificates, inspection evidence |
| Preventive-maintenance scheduler | In progress | `maintenance.pm_schedules` storage only; no generation, recurrence or meter triggers |
| Platform control plane & subscription billing | In progress | Tenant provisioning, module activation, licence events; no plans, proration, grace, suspension, platform invoices |
| Privacy / data-subject requests | Not started | No inventory, consent, SAR/erasure workflow or legal hold |
| AI & automation governance | Not started | No AI features exist, so no governance surface |
| Offline operation | In progress | Device registry, command idempotency, conflict queue; no workflow-level offline policy, expiry or replay UI |
| Data migration tooling | Not started | No import templates, dry runs or control totals |
| Hardware / IoT adapters | Not started | No lock, printer, KDS, PBX, BMS or meter adapters |

## Next increments (dependency-aware)

1. **Maintenance & Engineering depth (partially done)** — trades, checklist engine with recurrence and
   duplicate protection, HK handoff, four-eyes verification and the readiness gate are built and tested.
   Remaining: permit-to-work/isolation, statutory compliance register, PM scheduler with meter triggers,
   contractor governance, critical spares and the operator screens.
2. **Guest registration & identity capture** — private document storage abstraction, masked numbers,
   retention/legal-hold hooks, no-device fallback.
3. **Tax & statutory configuration** — effective-dated tax codes replacing item `tax_rate` columns;
   blocking for any jurisdiction-specific sale.
4. **Cashiering & revenue assurance** — till/shift lifecycle plus the exception workbench.
5. **Channel manager core** — provider registry, mapping, ARI outbox and import, with one certified
   provider before any "live" claim.
6. **Website/CMS + direct booking engine** — separate product deployment with 0% fee default.

Each increment must land as a vertical slice (screen → route → service → constraint → audit/event →
report → tests) before the next starts.
