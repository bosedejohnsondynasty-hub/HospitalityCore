# Completeness pack (v2.5)

The specification (Part VIII §13, Part IX §9) requires a completeness pack before broad
implementation. This is the current version for this repository. It is deliberately written as
**current state + plan**, not as a certificate.

Companion documents: [BUILD-LEDGER](BUILD-LEDGER.md) · [COMPLIANCE-AUDIT](COMPLIANCE-AUDIT-v2.5.md) ·
[DECISION-REGISTER](DECISION-REGISTER.md) · [REQUIREMENTS-TRACEABILITY](REQUIREMENTS-TRACEABILITY.md).

## 1. Source register

| Source | Version / date | Authority | Use in this repo |
| --- | --- | --- | --- |
| Hospitality Core — Master AI Builder Prompt (`..._Source_of_Truth_Master_AI_Builder_Prompt.md`) | 2.5 · 2026-11-08 | Governing build contract | Full read for this audit; drives BUILD-LEDGER and this pack |
| Hospitality Core — Enterprise Architecture & Functional Completeness (`.docx`) | 2.5 · 2026-11-08 | Same content, originating document | Cross-checked; identical scope |
| Global Hospitality Management Platform Consolidated Master Specification | v2.5 | Referenced by the prompt | **Not in this repository** — mapped from the 44-module catalogue; details beyond it are unverified |
| Hospitality ERP + PMS Product Feature Catalogue | v1.0 (revised) | Referenced | **Not supplied** — requirement-level mapping is therefore incomplete |
| Hospitality ERP + PMS PRD | v1.0 (revised) | Referenced | **Not supplied** |
| Original conversation/source exports | — | Referenced | **Not supplied** |
| `docs/REQUIREMENTS-TRACEABILITY.md` | in-repo | Derived | Business requirement ↔ module ↔ status, no source IDs |

**Consequence:** the bidirectional crosswalk required by Part VIII §1 cannot be complete for sources
that were never supplied. What exists maps the 44 canonical modules and the ten v2.5 domains; the
"every source requirement" claim is not made.

## 2. Ten functional domains ↔ 44 canonical modules

The prompt (Part IX §2) classifies the modules into ten domains. The repository groups storage the same
way where ownership is shared, but navigation is still per product page, not per domain.

| # | Domain | Canonical modules | Repo navigation |
| --- | --- | --- | --- |
| 1 | Guest Experience & Hotel Operations | 1 Guest, 2 Reservations, 3 Front Office, 4 Night Audit, 5 Housekeeping, 6 Laundry, 7 Minibar, 8 Guest Self-Service, 9 Notifications | Hotel, Business tools |
| 2 | Food & Beverage Operations | 10 POS, 11 Restaurant & Bar, 12 Food Safety (+ standalone Restaurant, Bar) | Restaurant, Bar, Business tools |
| 3 | Financial Management & Accounting | 13 Cashiering, 14 Financial Accounting, 15 Budget, 16 Treasury, 17 Guest Credit, 18 Revenue Management, 20 Integration & Payment Gateway (financial ownership) | Finance, Business tools |
| 4 | Supply Chain, Procurement & Assets | 19 Inventory, 20 Procurement, 21 Fixed Assets, 22 Maintenance | Inventory, Fixed assets, Business tools |
| 5 | Human Capital & Workforce | 23 HR, 24 Payroll, 25 Attendance & Scheduling, 26 Training | Workforce, Business tools |
| 6 | Commercial, Sales & Distribution | 27 Sales, 28 CRM, 29 Channel, 30 Group/Tour, 31 Central Reservation (+ Website/CMS, Booking Engine, Channel Manager products) | Business tools (no domain workspace) |
| 7 | Events, Leisure & Ancillary | 32 Banquet, 33 Spa | Business tools |
| 8 | Governance, Risk, Compliance & Quality | 35 Insurance, 36 Quality, 37 Security, 38 Documents, 39 Franchise | Business tools |
| 9 | Corporate, Property & Contract | 40 Multi-branch, 41 Contracts | Business tools, Administration |
| 10 | Technology, Integration & BI | 42 Utilities, 43 Integration, 44 Reporting | Finance, Business tools, Dashboard |

Module numbers are canonical from Parts II and IX. Note the prompt's own numbering skips 34 in the
domain listing (Tax & Statutory appears as 34 in Part II and 19 in Domain 3); this repository keeps
`tax_compliance` as a single distinct module and does **not** renumber anything.

## 3. Product boundary and entitlement matrix

| Product | Independent operation | Entitlement surface | Current state |
| --- | --- | --- | --- |
| Hotel ERP/PMS | Yes | `hotel.*` modules, hotel routes | Partial |
| Restaurant Management | Yes, by licence | `restaurant.*` modules, restaurant routes | Partial; shares hotel platform services and one database |
| Bar Management | Yes, by licence | `bar.*` modules, bar routes | Partial |
| Hotel Website & CMS | Must stand alone | None exists | **Not started** |
| Direct Booking Engine | Yes, 0 % fee default | None exists | **Not started** |
| Channel Manager / CRS distribution | Yes | `channel_management` module only (internal register) | **Not started as a product** |

Entitlement enforcement today: `licensing.module_activations` per product+module, route prefix maps to a
product, `productForPath()` resolves the owning product copy, and `MODULE_NOT_LICENSED` (402) is returned
server-side. Covered by `product-scoping.test.ts` and `security.test.ts` (unlicensed module locked).
Jobs and exports inherit the same tenant licence because they call the same services; this is **not**
covered by a dedicated test yet.

## 4. System-of-record matrix

| Entity / ledger | System of record | Consumers must not |
| --- | --- | --- |
| Guest master identity | Guest Management | Duplicate guest rows per outlet |
| Stay registration / check-in evidence | Front Office | Overwrite history |
| Reservation state, room-type availability, room assignment | Reservations/PMS | Compute availability independently |
| Room attributes and operational restrictions | Property/room master | Flip sellability from maintenance or housekeeping |
| Cleanliness/readiness | Housekeeping | Mark ready on task completion alone |
| Technical condition | Maintenance | Close without verification when required |
| General ledger | Financial Accounting | Post journals outside the posting contracts |
| Gateway transaction state | Payment operations | Treat a browser redirect as payment |
| Stock quantity and valuation | Inventory | Adjust stock inside POS code |
| Purchasing lifecycle | Procurement | Create payables without match rules |
| Employee records | HR | Store payroll-only employee copies |
| Login identities, roles, permissions | Identity & Access | Grant access from HR records directly |
| Device/provider technical state | Integration platform | Claim a command succeeded without acknowledgement |

## 5. Integration, provider and hardware matrix

| Integration | Direction | Status | Evidence / blocker |
| --- | --- | --- | --- |
| Paystack | Inbound webhook + intent | Implemented-unverified against live provider | HMAC-SHA512 verification, replay-safe, amount/currency checked; no live credential |
| Flutterwave | Inbound webhook + intent | Implemented-unverified | Hash verification implemented; no live credential |
| Email (SMTP) | Outbound | Implemented | Unconfigured → permanent failure with honest error |
| SMS / push / WhatsApp | Outbound | Not started | Needs provider decision (D-06 adjacent) |
| Channel manager (OTA/GDS) | Bidirectional | Not started | D-11 |
| Booking engine | Outbound/inbound API | Not started | F-01 |
| Door locks / encoders | Outbound + events | Not started | D-12 |
| Receipt/kitchen printers, KDS | Outbound | Not started (KDS is an in-app screen) | D-12 |
| PBX / telephony | Both | Not started | D-12 |
| BMS / meters / IoT | Inbound | Manual meter readings only | D-12 |
| Biometric attendance | Inbound | Manual attendance only | D-12 |
| Object storage for documents | Internal | Not started | F-06 |
| Accounting export | Outbound | Not started | Native GL is authoritative |

## 6. Risk register

| ID | Risk | Likelihood | Impact | Mitigation in force | Residual |
| --- | --- | --- | --- | --- | --- |
| R-01 | Owner believes the product is complete because 44 modules have endpoints | High | High | BUILD-LEDGER, this audit, no "production-ready" claim | Open until owner reads the ledger |
| R-02 | Statutory payroll/tax wrong for the deployment country | High | High | Numbers isolated in one service and one decision entry | **Open** until D-01/D-05 |
| R-03 | Guest identity data collected without lawful basis | Low now | High | Feature not built; decision D-02 required first | Controlled |
| R-04 | Restore/DR fails in a real incident | Medium | High | Daily-use DB verified; restore not demonstrated here | **Open** (F-13) |
| R-05 | UI depth causes operational workarounds (e.g. no room move) | High | Medium | Honest gap list; operational screens exist for desk/kitchen/stock | Open |
| R-06 | A connector is mistaken for live | Medium | High | No connector shipped; matrix states status explicitly | Controlled |
| R-07 | Tenant leakage through a new endpoint | Low | Critical | RLS + tenant-scoped pool + tests; new routes follow the same helper | Monitored by tests |
| R-08 | Concurrency bug in a new workflow | Medium | High | Exclusion constraints, `FOR UPDATE`, unique idempotency keys | Tested per workflow |
| R-09 | Uncommitted work lost | Medium | High | Everything is in the working tree only | **Open** — no commits exist |
| R-10 | Performance unknown at real volume | High | Medium | Indexed hot paths; no load test | **Open** (F-14) |

## 7. Acceptance-test catalogue

Required by Part V §14 and Part VIII §12. "Automated" means an executed test in this repository; it does
not replace the UAT evidence the specification also demands.

| Required domain | Automated coverage | Missing scenarios |
| --- | --- | --- |
| Tenant & access isolation | `security.test.ts` — cross-tenant read hidden, unlicensed module blocked, permissions enforced | Branch/department scope, inactive-user revocation, entitlement in jobs/exports, mobile |
| Concurrency | Double booking blocked by exclusion constraint; simultaneous approvals on POs/refunds | Concurrent stock issue, stale record update, duplicate cashier submit |
| Financial integrity | Webhook replay, amount check, posted-entry immutability, balanced journals, period guard | Partial refund, wrong currency, period close with open exception, duplicate folio posting |
| Inventory integrity | Recipe depletion, receipt/issue/adjustment, append-only movements | Negative-stock policy, unit conversion, batch expiry, transfer in transit, count variance approval |
| Hotel operations | Allocation, check-in, folio immutability, night audit + exceptions, checkout | Amendments, no-show, room move, early/late, split folio, direct bill, audit reopen |
| Housekeeping/maintenance | Task assign/complete/inspect; checklist generation with duplicate protection; HK fault handoff with trade routing; four-eyes verification; room-readiness gate; SLA application; parts on completion | Task reassignment, PM due generation, meter triggers, permits, offline replay |
| Restaurant/bar | QR order, kitchen routing, recipes, split? (no), tab? (storage), capacity, loyalty | Split bill, tab transfer, bottle/glass depletion, gateway failure, happy hour |
| Integration resilience | Retry/backoff, replay safety, unconfigured channel failure, outbox relay | Timeout, malformed payload, provider outage, dead-letter recovery, credential rotation |
| Deployment & recovery | Migration chain applies cleanly | Fresh install on new host, upgrade path, rollback, restore, offline/LAN, DR |
| Reporting & audit | Trial balance reconciles; revenue/daily sales/occupancy computed | Restricted report access, export audit, as-of reporting, FX consolidation |
| v2.5 additions | None | Identity capture + masking, lock degraded mode, concierge SLA, revenue-assurance exception, emergency incident, KPI drill-through, offline duplicate replay, suspended tenant |

## 8. Dependency-aware sequence (current plan)

1. **Foundations to finish** — actor-level audit stamps (F-11), approval-threshold service (F-08),
   KPI registry (F-10).
2. **PMS core** — reservation amend/cancel/no-show, room move, split folio, direct bill (F-04).
3. **Maintenance depth** — location/trade model, checklist engine + scheduler, HK handoff, verification
   gate, statutory register, permits (F-05).
4. **Identity & privacy** — private document storage abstraction, capture provenance, retention hooks
   (F-06/F-12, needs D-02).
5. **Money** — tax engine (D-05), cashiering shifts (F-09), financial statements and bank
   reconciliation (F-15), procurement GRN → AP (F-17).
6. **Commercial** — multi-property availability, then booking engine and channel adapter (F-01/F-18).
7. **Experience** — enterprise navigation, module workspaces, record detail pages (F-03).
8. **Hardening & release** — performance, accessibility, security testing, restore rehearsal, UAT,
   migration tooling (F-13/F-14/F-20), then the readiness declaration.

This is sequencing, not a reduction of scope: every module in the ledger keeps its full catalogue entry
and its gaps are recorded.
