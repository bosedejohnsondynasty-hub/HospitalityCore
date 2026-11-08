# API reference

Base path: `/api/v1`. JSON in, JSON out. The web client calls the same origin, so no API host is
needed in normal deployment.

## Authentication

```bash
curl -s https://hotel.example.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"...","tenantCode":"lagosgrand"}'
```

```json
{ "token": "hc_...", "expiresAt": "2026-11-07T22:00:00.000Z", "user": { "id": "...", "fullName": "..." } }
```

Send `Authorization: Bearer <token>` on every other request. Tokens are opaque; the server stores only
a SHA-256 digest and can revoke a session immediately. There are no cookies.

`GET /auth/me` returns the user, tenant, permissions, licensed modules and branch scope — use it to
drive a UI, never as an access control.

MFA: `POST /auth/mfa/enroll` → `{secret, otpauthUri}`; `POST /auth/mfa/activate {code}`; subsequent
logins require `mfaCode`.

## Errors

```json
{ "error": { "code": "ROOM_UNAVAILABLE", "message": "…", "details": { } } }
```

| Status | Meaning |
| --- | --- |
| 400 | Validation, bad reference, unbalanced journal, constraint violation |
| 401 | Missing/expired session, invalid credentials, invalid webhook signature |
| 402 | `MODULE_NOT_LICENSED` — the tenant's licence excludes the module |
| 403 | `FORBIDDEN` / `NOT_AUTHORIZED_DB` — permission or database grant denied |
| 404 | Not found or not visible in this tenant |
| 409 | Conflict: double booking, duplicate posting, already allocated, night-audit exceptions, duplicate record |
| 424 | `PROVIDER_NOT_CONFIGURED` — payment provider keys missing |
| 429 | `RATE_LIMITED` |
| 500 | Unexpected error; details are hidden in production and logged with the request id |

Common codes: `MODULE_NOT_LICENSED`, `ROOM_UNAVAILABLE`, `DUPLICATE_POSTING`,
`NIGHT_AUDIT_EXCEPTIONS`, `PERIOD_CLOSED`, `ORDER_ALREADY_PAID`, `CONFLICT_ALREADY_RESOLVED`,
`DUPLICATE_RECORD`, `UNBALANCED_JOURNAL`.

## Route groups

### Setup and auth

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/setup/status` | `{provisioned, apiSetupEnabled}` |
| POST | `/setup/bootstrap` | Requires `x-setup-token`; disabled unless `ALLOW_API_SETUP=true` |
| POST | `/auth/login` | Body: `email`, `password`, optional `tenantCode`, `mfaCode` |
| POST | `/auth/logout` | Revokes the session |
| GET | `/auth/me` | Session context |
| POST | `/auth/change-password` | Requires current password |
| POST | `/auth/mfa/enroll` · `/auth/mfa/activate` | TOTP |

### Hotel

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/hotel/hotels` | Licensed hotels |
| GET | `/hotel/rooms?hotelId=` | Room status board |
| GET | `/hotel/availability?hotelId=&from=&to=` | Rooms with `available` flag |
| GET/POST | `/hotel/guests` | Guest register |
| GET/POST | `/hotel/reservations` | List/create; body uses `guestId`, `roomTypeId`, `arrivalDate`, `departureDate` |
| PATCH | `/hotel/reservations/:id` | Amend dates, occupancy, room type or rate; `409 RESERVATION_HAS_ALLOCATION` while a room is allocated |
| POST | `/hotel/reservations/:id/cancel` | `{reason}` required; releases the room allocation; `409 ALREADY_CANCELLED` on a repeat |
| POST | `/hotel/reservations/:id/no-show` | Only once the business date reaches arrival; releases the allocation |
| POST | `/hotel/reservations/:id/allocate` | `{roomId}` or `{auto:true}`; `409` on overlap |
| POST | `/hotel/reservations/:id/checkin` | Opens the folio |
| POST | `/hotel/stays/:id/checkout` | `{allowOutstandingBalance}` |
| GET | `/hotel/folios/:id` | Folio, entries, balance |
| POST | `/hotel/folios/:id/charges` | `{entryType, description, amount}` |
| POST | `/hotel/folios/:id/settle` | `{amount, method, reference}` |
| POST | `/hotel/folio-entries/:id/reverse` | `{reason}`; append-only reversal |
| GET | `/hotel/business-date?hotelId=` | Open business date |
| POST | `/hotel/night-audit` | `{hotelId, overrideReason?}` |
| GET/POST | `/hotel/housekeeping/tasks` | `{hotelId, roomId, taskCode}` |
| POST | `/hotel/housekeeping/tasks/:id/complete` | `{notes, checklist}` |
| POST | `/hotel/housekeeping/tasks/:id/inspect` | `{result, score}` |
| GET/POST | `/hotel/maintenance/requests` | Requires a different approver |
| POST | `/hotel/maintenance/requests/:id/approve` | Four-eyes |
| GET/POST | `/hotel/maintenance/work-orders` | Completion can consume parts |

### Maintenance & Engineering depth

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/hotel/maintenance/teams` | Trades (Electrical, Plumbing, HVAC, General; extensible by the property) |
| GET/POST | `/hotel/maintenance/locations` | Location register; guest rooms are projected from `hotel.rooms` as a first-class category |
| GET/POST | `/hotel/maintenance/checklists` | Checklist templates with frequency, days/weeks, due time, grace and verification flag |
| GET | `/hotel/maintenance/checklists/:id` | Template plus ordered items |
| POST | `/hotel/maintenance/checklists/generate` | `{hotelId, date}`; idempotent — a retry cannot create duplicate occurrences |
| GET | `/hotel/maintenance/checklist-instances?hotelId&status` | Scheduled occurrences |
| GET | `/hotel/maintenance/checklist-instances/:id` | Occurrence with items and recorded results |
| POST | `/hotel/maintenance/checklist-instances/:id/complete` | `{results:[{itemId, result, numericValue?, remark?}], note?}`; mandatory items and exception reasons enforced; failed items raise routed faults |
| POST | `/hotel/maintenance/faults` | Housekeeping/front-office handoff: `{hotelId, roomId?, locationId?, category, priority?, description, affectsRoomReadiness?, housekeepingTaskId?}`; trade and SLA resolved server-side |
| POST | `/hotel/maintenance/requests/:id/reject` | `{reason}` required |
| POST | `/hotel/maintenance/work-orders/:id/transition` | `{status, reason?}`; guarded state machine, reason for hold/cancel/reopen, four-eyes verification |
| GET | `/hotel/maintenance/rooms/:roomId/history` | Faults, work orders, inspections and checklists for a room |
| GET/PATCH | `/hotel/maintenance/sla-policies` | Per-hotel acknowledge/resolve targets by priority |

A room-affecting work order that is open, or completed and awaiting verification, blocks
`POST /hotel/housekeeping/tasks/:id/inspect` with `409 ROOM_MAINTENANCE_HOLD`.

### Restaurant

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/restaurant/outlets` | Licensed outlets |
| GET | `/restaurant/outlets/:id/menu` | Menu + categories/items + outlet |
| POST | `/restaurant/menus/:menuId/categories` | `{name, displayOrder}` |
| POST | `/restaurant/menus/:menuId/items` | `{sku, name, price, taxRate, kitchenStationId}` |
| GET | `/restaurant/outlets/:id/tables` · `/stations` | Floor and routing |
| GET/POST | `/restaurant/outlets/:id/qr` | List/create QR tokens (`{tableId?, label?}`) |
| GET | `/restaurant/orders?outletId=&status=` | Orders |
| POST | `/restaurant/orders` | `{outletId, channel, items:[{itemId, quantity}]}`; totals server-side |
| POST | `/restaurant/orders/:id/status` | `{status}`; completing issues recipe ingredients |
| POST | `/restaurant/orders/:id/void` | Audited void |
| POST | `/restaurant/orders/:id/charge-to-folio` | `{folioId}`; revenue once |
| GET | `/restaurant/kitchen?outletId=` | Kitchen tickets |
| POST | `/restaurant/menu-items/:id/recipe` | `{ingredients:[{itemSku, quantity, unit}]}` |

### Public QR (no session)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/public/qr/:token/menu` | Menu for the token's outlet |
| POST | `/public/qr/:token/orders` | `{items:[{itemId, quantity}], customerName?}` |
| GET | `/public/qr/:token/orders/:orderId` | Status |
| POST | `/public/qr/:token/orders/:orderId/pay` | Creates a provider intent for pay-before outlets |

Rate-limited and scoped by the token; an expired or inactive token returns `404`.

### Bar

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/bar/outlets` | Licensed bars |
| GET | `/bar/outlets/:id/beverages` | Beverage menu |
| POST | `/bar/beverages` | `{barId, sku, name, category, salePrice, inventorySku}` |
| POST | `/bar/beverages/:id/recipe` | Cocktail recipe |
| GET/POST | `/bar/orders` | `{barId, items:[{beverageId, quantity}]}` |
| POST | `/bar/orders/:id/charge-to-folio` | `{folioId}` |

### Inventory and procurement

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/inventory/items` · `/stores` · `/balances?storeId=` · `/movements` | Stock ledger |
| POST | `/inventory/items` | Item master |
| POST | `/inventory/receipts` | `{storeId, supplierId?, items:[{itemId, quantity, unitCost}]}` |
| POST | `/inventory/issues` · `/adjustments` | Append-only movements |
| GET | `/procurement/suppliers` · `/purchase-orders` | |
| POST | `/procurement/purchase-orders` | Creator cannot approve |
| POST | `/procurement/purchase-orders/:id/approve` | |
| POST | `/procurement/invoices` | Three-way match exception |

### Finance

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/finance/accounts` | Chart of accounts |
| GET | `/finance/trial-balance` | `{accounts, totalDebit, totalCredit, balanced}` |
| GET/POST | `/finance/journals` | Manual journal; must balance |
| GET | `/finance/reports/revenue?from=&to=` | Revenue by stream |

### Payments

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/payments/intents` | `{relatedType, relatedId, provider, customerEmail?}`; amount derived server-side |
| GET | `/payments/intents/:id` | Status |
| POST | `/payments/refunds` | Request; requester cannot approve |
| POST | `/payments/refunds/:id/approve` | Four-eyes |
| POST | `/webhooks/paystack` | Signature-verified; raw body |
| POST | `/webhooks/flutterwave` | Signature-verified; raw body |

### Workforce

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/workforce/employees` | Employee register with monthly PAYE estimate |
| POST | `/workforce/employees` | Add an employee (employee number generated when omitted) |
| PATCH | `/workforce/employees/:id` | Amend name, contact, job, department, salary |
| POST | `/workforce/employees/:id/terminate` | Terminate and cancel future scheduled shifts |
| GET | `/workforce/shifts?from&to` | Roster window |
| POST | `/workforce/shifts` | Schedule a shift; overlapping shifts return `409 SHIFT_OVERLAP` |
| GET | `/workforce/attendance` | Attendance records with hours |
| POST | `/workforce/attendance` | Record clock-in/clock-out |
| GET | `/workforce/payroll-runs` | Payroll runs |
| POST | `/workforce/payroll-runs` | Calculate a run for a period (one per branch and period) |
| GET | `/workforce/payroll-runs/:id` | Run totals and payslips |
| POST | `/workforce/payroll-runs/:id/post` | Post the accrual exactly once |
| POST | `/workforce/payroll-runs/:id/payment` | Settle net pay from the bank exactly once |

### Fixed assets

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/assets` | Register with net book value and remaining depreciable amount |
| POST | `/assets` | Register and capitalise an asset (Dr 1500, Cr 1010) |
| POST | `/assets/:id/dispose` | Dispose with proceeds, posting gain or loss |
| GET | `/assets/depreciation-runs` | Depreciation runs |
| POST | `/assets/depreciation-runs` | Calculate one calendar month of straight-line depreciation |
| GET | `/assets/depreciation-runs/:id` | Run and per-asset entries |
| POST | `/assets/depreciation-runs/:id/post` | Post depreciation exactly once |

### Business tools — back office (hotel product)

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/hotel/budgets` | Budget register; create with `lines:[{accountId, category, amount}]` |
| POST | `/hotel/budgets/:id/lines` · `/approve` · `/lock` | Lines only while `draft`; lock only from `approved` |
| GET | `/hotel/budgets/:id/variance` | Budget vs posted journal actuals, per line and total |
| GET | `/hotel/treasury/positions` · `/transfers` | Ledger-derived bank positions; transfer register |
| POST | `/hotel/treasury/transfers` | `{sourceBankAccountId, destinationBankAccountId, amount, reference}`; one balanced journal |
| GET/POST | `/hotel/laundry` | Cycles with item lines |
| GET | `/hotel/laundry/:id` | Cycle and its items |
| POST | `/hotel/laundry/:id/complete` · `/cancel` | Completion requires every piece accounted for |
| GET/POST | `/hotel/agreements` | Contracts; `/hotel/agreements/:id/status` moves the state |
| GET/POST | `/hotel/insurance/policies` · `/claims` | Policies and claims |
| POST | `/hotel/insurance/policies/:id/status` · `/claims/:id/status` | Claim flow `open→in_review→approved→paid` |
| GET/POST | `/hotel/quality/inspections` · `/actions` | Inspections and corrective actions |
| POST | `/hotel/quality/inspections/:id/complete` · `/actions/:id/status` | Score 0–100 with `result` |
| GET/POST | `/hotel/utilities/meters` · `/readings` | Meters and readings (one per meter/day) |
| GET | `/hotel/utilities/summary` | Consumption and cost per meter |
| GET/POST | `/hotel/security/incidents` · `/patrols` | Incidents and patrols |
| POST | `/hotel/security/incidents/:id/status` · `/patrols/:id/status` | Close-out and patrol progress |
| GET/POST | `/hotel/documents` · `/actions` | Document register and follow-ups |
| POST | `/hotel/documents/:id/status` · `/actions/:id/status` | Activation and completion |
| GET/POST | `/hotel/training/courses` · `/enrollments` | Courses with validity and enrolments |
| POST | `/hotel/training/enrollments/:id/complete` | Score and certificate reference |

### Business tools — guest and commercial (hotel product)

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/hotel/banquets` | Events; `/hotel/banquets/:id/status` moves the lifecycle |
| GET/POST | `/hotel/banquets/:id/charges` | Charge lines with server-computed amounts |
| GET/POST | `/hotel/sales/campaigns` · `/opportunities` | Campaigns and pipeline |
| POST | `/hotel/sales/campaigns/:id/status` · `/opportunities/:id/stage` | Forward-only stages |
| GET/POST | `/hotel/crm/segments` · `/interactions` | Segments and interactions |
| POST | `/hotel/crm/interactions/:id/complete` | Close an interaction |
| GET/POST | `/hotel/channels/inventory` | Per-channel, per-date allocation |
| POST | `/hotel/channels/inventory/:id/update` | `{soldUnits, netRate?, parityStatus?}`; cannot exceed the allocation |
| GET/POST | `/hotel/revenue/forecasts` | Daily forecast (`occupancyPercent`, `adr`, `forecastRevenue`) |
| POST | `/hotel/revenue/forecasts/:id/approve` | Forecast approval |
| GET | `/hotel/revenue/summary` | Occupancy, ADR and forecast revenue per hotel |
| GET/POST | `/hotel/spa/resources` · `/bookings` | Resources and bookings; overlap → `409` |
| GET/POST | `/hotel/tours/packages` · `/bookings` | Packages and capacity-checked group bookings |
| GET/POST | `/hotel/callcentre/calls` · `/reservations` | Call logs and central bookings |
| GET/POST | `/hotel/foodsafety/checks` · `/logs` | Checks and readings |
| POST | `/hotel/foodsafety/checks/:id/complete` | `{result, correctiveAction?}` |
| GET/POST | `/hotel/corporate/accounts` · `/invoices` | Corporate credit accounts and invoices |
| POST | `/hotel/corporate/invoices/:id/pay` | Settles against the receivable once |
| GET/POST | `/hotel/franchise/standards` · `/audits` · `/actions` | Brand standards, audits and corrective actions |
| POST | `/hotel/franchise/audits/:id/complete` · `/actions/:id/status` | Scores and close-out |

### Business tools — outlets

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/restaurant/reservations` | Table reservations; overlapping seating → `409 TABLE_ALREADY_RESERVED` |
| POST | `/restaurant/reservations/:id/status` | `seated`, `completed`, `cancelled`, `no_show` |
| GET/POST | `/restaurant/waitlist` | Queue with position |
| POST | `/restaurant/waitlist/:id/seat` · `/abandon` | One-way closure |
| GET/POST | `/restaurant/customers` | Customer register; `/customers/:id/segment` |
| GET | `/restaurant/customers/:id/loyalty` | Balance and last 50 movements |
| POST | `/restaurant/customers/:id/loyalty/earn` · `/redeem` | Append-only points movement |
| GET/POST | `/restaurant/promotions` | Promotion register |
| POST | `/restaurant/promotions/:id/status` · `/restaurant/promotions/quote` | Activation; discount quote with window and minimum spend |
| GET | `/restaurant/food-cost?outletId=` | Plate cost from recipes and standard cost |
| GET/POST | `/bar/events` · `/bar/events/bookings` | Events and ticket register |
| POST | `/bar/events/:id/bookings` · `/bar/events/:id/status` | Capacity-checked sale; lifecycle |
| POST | `/bar/events/bookings/:id/cancel` | Cancel a ticket booking |

### Licensing, platform, sync, reports

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/licensing/catalogue` | Products and modules with `licensed` |
| POST | `/licensing/modules/:moduleCode/:action` | `activate` or `deactivate` |
| GET | `/platform/users` · `/roles` · `/branches` · `/audit` | Administration |
| POST | `/platform/users` | `{email, fullName, password, roles[], branchIds[]}` |
| POST | `/sync/devices` | Register a device |
| POST | `/sync/commands` | Offline command, `commandId` is the idempotency key |
| GET | `/sync/conflicts` | Pending/handled conflicts |
| POST | `/sync/conflicts/:id/resolve` | `{resolution, note}` |
| GET | `/reports/dashboard?hotelId=` · `/daily-sales` · `/occupancy` | |
| GET | `/healthz` · `/readyz` | Unauthenticated health checks |

## Webhook example

```bash
BODY='{"event":"charge.success","data":{"id":123,"reference":"HC-...","amount":117500,"currency":"NGN","status":"success"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac "$PAYSTACK_SECRET_KEY" | awk '{print $2}')
curl -s https://hotel.example.com/api/v1/webhooks/paystack \
  -H 'content-type: application/json' -H "x-paystack-signature: $SIG" -d "$BODY"
```

Responses: `200 {"status":"processed"}`, `200 {"status":"duplicate"}`, `400 {"status":"rejected"}`,
`401 {"status":"invalid_signature"}`, `404 {"status":"unknown_reference"}`.

## Conventions

- Lists are capped (100–200 rows) and ordered deterministically; there is no cursor pagination yet.
- Money is decimal; send numbers, never formatted strings.
- Dates are ISO `YYYY-MM-DD`; timestamps are ISO 8601 UTC.
- Idempotency keys: `commandId` for sync, provider `event_id` for webhooks, posting links for
  financial effects. There is no generic `Idempotency-Key` middleware.
