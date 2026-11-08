# Administrator guide

## First run

1. Deploy the stack (`docs/INSTALL.md`) and open the web client.
2. If no tenant exists and `ALLOW_API_SETUP=true`, the first-run form is shown. Supply the setup
   token, tenant identity, administrator account and the products to license.
3. Alternatively run `SETUP_TOKEN=... node scripts/provision-tenant.mjs ...` (see `--help`).
4. Sign in as the administrator, confirm the Licence centre shows the expected modules, then set
   `ALLOW_API_SETUP=false` and restart the API.

The bootstrap creates the tenant, branch, organization, legal entity, fiscal calendar, chart of
accounts, 16 role templates and module activations in a single transaction. It also creates the
hotel/restaurant/bar structures you supplied (rooms, tables, kitchen stations).

## Users, roles and separation of duties

`Administration → Create user` assigns one or more role templates:

| Role | Typical holder | Notable limits |
| --- | --- | --- |
| `owner` | Proprietor | All modules and permissions |
| `general_manager` | GM | Broad operational access; cannot change licences |
| `front_desk` | Reception | Reservations, check-in/out, folios; no refunds |
| `housekeeping_supervisor` | Head housekeeper | Tasks, inspection, room release |
| `maintenance_officer` | Engineer | Requests and work orders; cannot approve own request |
| `restaurant_manager` | Restaurant manager | Menu, orders, staff; refund approval |
| `waiter` | Service staff | Order taking; no refunds, no stock adjustments |
| `kitchen_chef` | Kitchen | Kitchen tickets, recipes |
| `bar_manager` / `bartender` | Bar | Beverages, orders; manager approves refunds |
| `cashier` | Cashier | Payments; cannot approve refunds |
| `finance_officer` | Finance | Journals, reports, refund approval |
| `procurement_officer` | Purchasing | POs; cannot approve own PO |
| `internal_auditor` | Auditor | Read-only plus audit trail |
| `storekeeper` | Store | Stock receipts/issues/adjustments |
| `revenue_manager` | Commercial | Rates and revenue reporting |

Denials always win over allows. A user with both `restaurant_manager` and `waiter` keeps the manager
permissions; a user with an explicit deny loses the permission regardless of other roles.

Refunds and purchase orders require a second authorised user: the requester cannot approve their own
document. Use separate accounts — sharing a login defeats the control and the audit trail.

## Licence centre

`Licence centre` lists every product and module with a licensed/locked badge. Activating or
deactivating a module takes effect immediately on the API (`402 MODULE_NOT_LICENSED`). Deactivation
never deletes data; reactivation restores access. The navigation also shows a lock, but the server is
the enforcement point.

Only deactivate modules staff no longer use. Deactivating `front_office` blocks check-in; deactivating
`inventory` blocks stock receipts for every outlet.

## Business date and night audit

The hotel has one open business date. `Hotel → Night audit`:

1. Collects exceptions (in-house stay without an open folio is critical; negative folio balance,
   arrival without room, stale restaurant order are warnings).
2. Refuses to run with critical exceptions unless an override reason is supplied.
3. Posts one room charge per in-house stay for that business date.
4. Closes the date, opens the next, and records the run with exceptions and summary.

Run it after the last arrival and before reports are distributed. Re-running is safe: the posting
key prevents a second charge for the same stay and date.

## Payments

Set provider keys in `.env` (never in the database or the UI):

```dotenv
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_PUBLIC_KEY=pk_live_...
FLUTTERWAVE_SECRET_KEY=FLWSECK-...
FLUTTERWAVE_SECRET_HASH=<dashboard webhook hash>
```

Register the webhook URLs with each provider:

- Paystack: `https://<your-host>/api/v1/webhooks/paystack`
- Flutterwave: `https://<your-host>/api/v1/webhooks/flutterwave`

Requirements:

- The API must be reachable over HTTPS from the provider.
- The secret used for the signature must match the one in `.env`.
- `PAYMENTS_ALLOW_OFFLINE_VERIFY=false` in production. `true` exists only for local development
  without provider credentials and still requires a valid signature.

A payment is marked successful only after a verified webhook with matching amount, currency and
provider. If a guest says they paid but the order is unpaid, check `GET /api/v1/payments/intents/:id`
and the provider dashboard; do not mark orders paid manually. There is no override endpoint.

Refunds: a cashier or manager requests, a different authorised user approves. Both actions are
audited. Gateway refunds require the provider's API and are recorded against the original intent.

## Cashiering and folios

Folio charges posted from the front desk, restaurant or bar are append-only. To correct a mistake,
reverse the entry with a reason; the reversal is a new row and the original remains visible.
Settlement clears the guest receivable; it does not recognise revenue a second time.

## Reports

- **Dashboard** — occupancy, in-house, arrivals/departures, ledger balance, today's outlet sales.
- **Trial balance** — posted journals only, with debit/credit totals and a balanced badge. If it is
  not balanced, stop and investigate before closing the day.
- **Occupancy / daily sales** — by date range and outlet.

Reports read the ledger; they do not recompute revenue from orders. If an order is unpaid, its
revenue is absent by design (cash basis on settlement/charge).

## Backups and recovery

Nightly: `docker compose --profile ops run --rm backup`. Copy the `backups/` directory off the host.
Quarterly: restore the latest archive into a scratch database and check the trial balance. Record the
drill date and result.

The database is the only stateful component. The API containers can be recreated freely.

## Security checklist

- [ ] TLS in front of the web container; HTTP redirects to HTTPS.
- [ ] `ALLOW_API_SETUP=false` after provisioning.
- [ ] Distinct, random `POSTGRES_SUPERUSER_PASSWORD`, `APP_DB_PASSWORD`, `SETUP_TOKEN`.
- [ ] `DATABASE_URL` uses `hospitality_app`, not the owner.
- [ ] Database port not reachable from the internet.
- [ ] Backups encrypted before leaving the host.
- [ ] MFA enabled for owner, GM and finance accounts.
- [ ] Provider webhook secrets set; test webhook verified in the provider dashboard.
- [ ] Audit log reviewed weekly for refunds, licence changes and failed sign-ins.
- [ ] Dormant staff accounts deactivated (there is no delete; set status inactive in the database
      until a UI action exists).

## Routine calendar

| Frequency | Task |
| --- | --- |
| Daily | Night audit, check trial balance, review cash-up, verify backup ran |
| Weekly | Review refunds and voided orders, check stock variances, review audit log |
| Monthly | Reconcile bank and gateway settlements, review licences, rotate staff who left |
| Quarterly | Restore drill, dependency updates, access review |

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Everyone gets `402` for a module | Licence centre: module deactivated |
| `409 ROOM_UNAVAILABLE` | Overlapping allocation; check the reservation dates and the room's active allocation |
| Night audit returns `409 NIGHT_AUDIT_EXCEPTIONS` | Resolve the listed critical exceptions (usually an in-house stay without an open folio) or override with a written reason |
| `424 PROVIDER_NOT_CONFIGURED` | Provider keys absent; set them and restart |
| Login locked | Wait 15 minutes or reset the password as an administrator |
| API will not start | Read the message: it refuses to run as a database owner/superuser by design |
