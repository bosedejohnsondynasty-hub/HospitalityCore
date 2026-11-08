# Security

## Authentication

- Passwords are hashed with scrypt (`N=16384, r=8, p=1`, 32-byte key, 16-byte random salt) and
  compared with `timingSafeEqual`. The encoded format is `scrypt$N$r$p$salt$hash`.
- Password policy: minimum 12 characters, at least one letter and one number (`PASSWORD_MIN_LENGTH`).
- Sessions are opaque 32-byte random tokens. Only the SHA-256 digest is stored in
  `identity.sessions`; the plaintext token exists only in the client. Sessions expire
  (`SESSION_TTL_MINUTES`) and can be revoked instantly (`revoked_at`), which a self-contained JWT
  cannot do.
- Repeated failed sign-ins increment `failed_login_attempts`; eight failures lock the account for
  15 minutes.
- TOTP MFA is implemented with `node:crypto` (RFC 6238, 30-second step, ±1 step skew). Enrolment
  stores the secret but leaves MFA inactive until a valid code is presented.
- No cookies are used, so there is no CSRF surface. The bearer token must be protected by TLS and by
  the client; the API sets `credentials: false` on CORS.

## Authorisation

- Permissions are named `product.area.action` and resolved from role templates at provisioning time
  into `access.role_permissions`. Wildcards support `*` for one segment and a trailing `*` for a
  subtree; denials always win.
- Every route calls `requirePermission` before touching data, then `requireModule` for licence
  enforcement. Hiding UI is never the control: a direct HTTP call receives `403 FORBIDDEN` or
  `402 MODULE_NOT_LICENSED`.
- Separation of duties is enforced in code and re-checked in SQL where relevant:
  - a refund cannot be approved by the user who requested it;
  - a purchase order cannot be approved by its creator;
  - a maintenance request cannot be approved by its creator;
  - cashier and waiter roles cannot approve refunds or adjust stock.
- Approval limits, branch scoping and record-level scopes exist in the permission model
  (`access.user_branch_access`, permission scopes in the catalogue). Per-transaction monetary
  approval thresholds are **not** implemented as a configurable matrix; refunds and POs require a
  second authorised user instead (see limitations).

## Tenant isolation

- The runtime database role is `hospitality_app`: `NOSUPERUSER`, `NOBYPASSRLS`, and not the owner of
  any table. The API refuses to start otherwise (`REQUIRE_RESTRICTED_DB_ROLE=true`).
- RLS is enabled on every tenant table with policies comparing `tenant_id` to
  `current_setting('app.tenant_id')::uuid`, set per transaction by `withTenant`.
- Reporting views are `security_invoker = true` (migration 018). Before that fix, the trial balance
  view ran as its owner and aggregated all tenants — the integration suite caught it and the
  migration fails if any application view bypasses RLS.
- Five `SECURITY DEFINER` functions exist for pre-authentication lookups (login, session, tenant
  code, QR token, payment reference). Each is narrowly scoped, uses `SET search_path = pg_catalog,
  public`, and returns only the columns the caller needs.
- Test evidence: a second tenant receives `404` for another tenant's folio and empty lists for rooms
  and guests; a direct SQL check confirms no cross-tenant rows are visible.

## Financial and inventory integrity

- `hotel.folio_entries`, `finance.journal_lines`, `inventory.movements`, `audit.events` and
  `licensing.license_events` are append-only for the runtime role. Triggers additionally reject
  updates/deletes on posted financial rows, including for the owner.
- Reversals are new rows carrying the original reference and a mandatory reason.
- `finance.posting_links` enforces one posting per `(source_type, source_id, purpose)`, preventing
  duplicate revenue and duplicate settlements.
- Room overlap is prevented by a GiST exclusion constraint, so allocation is concurrency-safe even
  with multiple API processes.
- Stock movements use a partial unique index on reference and `ON CONFLICT DO NOTHING`, making
  ingredient deduction idempotent.
- Journal entries must balance (debit = credit, > 0) before insertion; the trial balance must be
  balanced after every test run.

## Payments

- Supported providers: Paystack, Flutterwave, plus cash, bank transfer and POS terminal.
- Paystack signature: `HMAC-SHA512(rawBody, PAYSTACK_SECRET_KEY)` compared with `x-paystack-signature`
  using a constant-time comparison.
- Flutterwave: static `verif-hash` compared to `FLUTTERWAVE_SECRET_HASH`, or
  `HMAC-SHA256(rawBody, FLUTTERWAVE_SECRET_KEY)` via `flutterwave-signature`.
- The raw request body is preserved before JSON parsing, so the signature is over exactly the bytes
  the provider signed.
- After signature verification the stored intent is checked for amount, currency, provider and
  status. Mismatch returns `400 rejected` and does not mark the order paid.
- Replays are prevented by a unique `(provider, event_id)` row; a replay returns `200 duplicate` and
  applies no effects.
- Card data is never received or stored. Hosted checkout links are generated from the configured
  origin; no PAN, CVV or expiry ever reaches this system.
- A customer returning from checkout cannot mark an order paid: only the webhook path calls
  `applySuccessfulPayment`.

## Transport and headers

- Helmet sets standard security headers; CSP is disabled in the API because it serves JSON only. The
  web container adds `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy`.
- CORS is an explicit allowlist from `CORS_ORIGINS`; unknown origins receive an error.
- Rate limiting defaults to 300 requests per minute per client (`RATE_LIMIT_MAX`).
- Request bodies are capped at 1 MiB. There is no general file-upload endpoint; document storage is
  not implemented.
- TLS termination is required in front of the web container for any network deployment.

## Audit

`audit.events` records actor, action, entity, before/after metadata where applicable, IP and user
agent. It is append-only and readable through `GET /api/v1/platform/audit` by holders of
`platform.audit.view`. Financial postings, refunds, approvals, licence changes, sync conflicts and
sign-in events are all recorded.

## Threat model (summary)

| Threat | Control | Residual risk |
| --- | --- | --- |
| Cross-tenant data access | RLS + restricted role + `security_invoker` views | A database owner credential leak bypasses RLS; guard the admin URL |
| Privilege escalation via API | Permission checks server-side, denials win, role templates | Custom roles are template-based; per-record scopes are only partially used |
| Forged payment webhook | HMAC signature over raw body, constant-time compare | Provider key compromise; rotate keys |
| Replay / duplicate payment | Unique provider event id, posting links, idempotent effects | Provider retries with new event ids for the same charge are rejected on amount/intent state |
| Amount tampering | Server derives amount from the order; webhook amount must match | Client-side price display can differ until refresh |
| Double booking | Exclusion constraint | Requires `btree_gist`; installation depends on it |
| Ledger tampering | Append-only grants + triggers + reversals | Superuser can still alter data; protect backups and admin credentials |
| Refund fraud | Four-eyes approval, audit trail | No monetary threshold matrix |
| Offline sync abuse | Command idempotency, permission check, conflict records | No device attestation; a stolen token is a valid session until revoked |
| Session theft | Opaque tokens, revocable, TLS required | Token stored in `localStorage`; XSS would expose it (no user-generated HTML is rendered) |
| Brute force | Lockout after 8 failures, rate limiting | Distributed attempts are only rate-limited per IP |

## Residual risks and hardening backlog

1. No external penetration test or dependency CVE scan has been run in this environment.
2. Encryption at rest is delegated to the host volume / managed PostgreSQL; no application-level
   field encryption is implemented.
3. Offline licence validation (signed licence file) is not implemented; licences are database rows.
4. Backup files contain personal data and must be encrypted by the operator (e.g. `age`/GPG) before
   off-site storage.
5. No Web Application Firewall or IDS configuration is supplied.
6. Monitoring/alerting on failed sign-ins, webhook rejections and ledger imbalance is not wired to a
   collector.

## Reporting a vulnerability

Treat this repository as customer-hosted software: report issues to the maintainers privately,
include reproduction steps, and do not test against a live property without written authorisation.
