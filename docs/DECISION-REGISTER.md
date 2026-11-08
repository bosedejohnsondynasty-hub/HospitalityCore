# Decision register

Open decisions that the governing specification says must **not** be invented by the builder
(Master AI Builder Prompt v2.5, Part IV §10, Part VI §16, Part VIII §1). Each entry states the safe
behaviour currently in force, the options, and what changes when the owner decides.

Status: `open` = awaiting owner; `provisional` = a working default is implemented and reversible;
`closed` = owner approved (none yet).

| ID | Decision | Owner | Status | Safe behaviour in force | Options / what changes |
| --- | --- | --- | --- | --- | --- |
| D-01 | **Payroll statutory jurisdiction** — which country's PAYE, pension and levies apply | Owner + accountant | provisional | Nigerian PAYE bands and pension rates are implemented in `apps/api/src/services/workforce.ts`. This is a hard-coded rule and is therefore a compliance gap (audit F-07) | Jurisdiction-specific rule tables with effective dates; payroll reads tenant configuration. Until chosen, the current numbers must be treated as demo configuration, not policy |
| D-02 | **Guest identity-data fields, lawful basis, retention, disclosure text** | Owner + legal | open | Only optional text fields on the guest record; no document/photo capture is built, so no unapproved collection exists | Which document types, which fields mandatory, retention per category, consent wording, whether photographs are allowed at all. Blocks identity-capture implementation |
| D-03 | **Biometric / facial matching** | Owner + legal | open | Not implemented and not planned; the spec forbids it without a separate approved lawful basis and impact assessment | If ever approved: separate consent, impact assessment, configuration flag, jurisdictional review |
| D-04 | **Direct booking fee** | Owner | open | No booking engine exists, so no fee can be charged | 0 % (specification default) or a disclosed fee within 0–1 % covering hosting only, reconciled separately from room revenue and tax |
| D-05 | **Tax engine scope** — VAT/sales tax/withholding, inclusive vs exclusive, fiscalisation | Owner + accountant | provisional | Outlet and item `tax_rate` columns, applied server-side; no fiscal invoice numbering | Effective-dated tax codes per jurisdiction, inclusive/exclusive flag, exemptions, fiscal device/e-invoicing integration, statutory returns |
| D-06 | **Payment providers and settlement accounts** | Owner | provisional | Paystack and Flutterwave adapters, HMAC-verified webhooks, no card data stored | Live credentials, settlement/fee ingestion, reconciliation ownership, chargeback handling, PCI scope confirmation |
| D-07 | **Deployment profile** — SaaS, private cloud, on-premise, hybrid | Owner | open | Single API + static web build, PostgreSQL; Docker files provided but unexecuted here | Supported profiles, update responsibility, LAN/offline behaviour, remote-support model, licence validation/grace |
| D-08 | **Offline workflow scope** | Owner + operations | open | Command-level idempotency and conflict queue only | Which workflows may run offline, cache TTL, device trust, conflict policy, operator-visible sync status |
| D-09 | **Licensing/commercial packaging** | Owner | provisional | Three products, 73 modules, per-module activation, licence events; no plans or subscription billing | Plans, add-ons, limits, trials, proration, grace, suspension, platform invoices |
| D-10 | **Legal entity, currency and consolidation model** | Owner + finance | open | Single currency per tenant/branch; no consolidation | Multi-entity intercompany, elimination rules, exchange-rate source and date, group reporting periods |
| D-11 | **Channel/provider connectivity** | Owner | open | Internal allocation register only; no connector is claimed live | Which OTAs/GDS first, certification requirements, ARI contract, commission handling, parity policy |
| D-12 | **Hardware integrations** — locks, encoders, printers, KDS, PBX, meters, BMS | Owner | open | No device adapters; manual fallback is the only behaviour | Supported models/protocols, vendor certification, failure modes, emergency override procedure |
| D-13 | **Accessibility target and verification** | Owner | provisional | Semantic HTML, labelled controls, keyboard-reachable forms; never audited | WCAG 2.2 AA (specification default) with a formal audit before release |
| D-14 | **Data retention and legal hold policy** | Owner + legal | open | No deletion automation; records are retained indefinitely | Retention schedule per record class, legal-hold rules, deletion approval and evidence |
| D-15 | **AI features** | Owner | open | No AI/ML feature exists in the product | If added: permission-filtered context, human approval for consequential actions, explainability, kill switch |
| D-16 | **Approval thresholds** | Owner + finance | provisional | Maker-checker on purchase orders, refunds, payroll, maintenance; no amount thresholds | Thresholds by amount/currency/role/transaction type; delegation and escalation rules |
| D-17 | **Service levels, RPO/RTO** | Owner + operations | open | No published SLO; health endpoints only | Availability/latency targets, RPO/RTO per deployment profile, support response times |

## How decisions are applied

1. The owner records the selected option and approval evidence in this table.
2. The builder implements the choice behind configuration (no code forks per customer).
3. The decision is referenced from the affected module specification and from
   `docs/COMPLIANCE-AUDIT-v2.5.md` where it closes a finding.
4. Nothing in this table authorises collecting additional personal data, charging a fee or claiming a
   certification.
