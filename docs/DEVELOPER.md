# Developer guide

## Setup

```bash
npm install
cp .env.example .env        # local database URLs, APP_DB_PASSWORD, SETUP_TOKEN
node scripts/db-dev.mjs up  # embedded PostgreSQL 17 on :5432 (or use your own)
npm run db:setup
npm run dev:api             # :4000
npm run dev:web             # :3000, proxies /api to :4000
```

The API refuses to start with a superuser/owner connection. `scripts/db-bootstrap.mjs` creates
`hospitality_app` with the right attributes and grants.

## Layout

```
apps/api/src
  config.ts        environment schema (zod)
  db.ts            pools, withTenant (RLS transaction), withScopedLookup, security check
  auth.ts          session resolution, requirePermission, requireModule, SoD
  errors.ts        AppError + typed helpers
  security.ts      scrypt, HMAC, token generation, TOTP
  audit.ts         append-only audit helper
  catalogue.ts     products, 73 modules, role templates, COA, permission matcher
  services/        domain logic (hotel, restaurant, bar, finance, inventory, payments, reports, onboarding)
  routes/index.ts  HTTP surface (auth → permission → module → service)
apps/api/test
  env.ts           test environment (real PostgreSQL, no mocks)
  helpers.ts       app boot, tenant seeding, HTTP helper
  unit.test.ts     pure functions (pattern matcher, hashing, TOTP, money)
  integration.test.ts  end-to-end scenarios against PostgreSQL
db/migrations      001…019, forward-only
db/seed            001_catalogue.sql, 002_permissions.sql
apps/web/src       api client, components, pages
```

## Conventions

- TypeScript strict, ESM with `.js` import specifiers. `tsc --noEmit` must pass for both apps.
- SQL is explicit; no ORM. Always parameterise. Snake_case columns, `NUMERIC(18,4)` money,
  `TIMESTAMPTZ`, UUID primary keys, `(tenant_id, id)` unique keys for composite FKs.
- Tenant-scoped tables carry `tenant_id`, have RLS enabled and a policy comparing it to
  `current_setting('app.tenant_id')::uuid`.
- Any new tenant table must be added to migration `015`-style grants: `SELECT/INSERT/UPDATE/DELETE`
  to `hospitality_app` except append-only tables, which get `SELECT/INSERT` only, plus an explicit
  `REVOKE`.
- Domain services take `(db: Queryable, ctx: AuthContext, input)`. They never open their own
  transaction. Routes wrap them in `tenantHandler`/`moduleHandler`.
- Every state change writes an audit event with a stable action name.
- Financial effects go through `finance.postJournal` with `sourceType`/`sourceId`/`purpose` so the
  posting link enforces exactly-once.
- Views must be created with `WITH (security_invoker = true)`; migration 018 fails otherwise.

## Adding a migration

1. Create `db/migrations/019_short_description.sql` (next number, never reuse).
2. Write idempotent DDL where possible (`IF NOT EXISTS`), enable RLS and grants for new tables.
3. Run `node scripts/migrate.mjs`; the runner stores a SHA-256 checksum.
4. Add a check to `scripts/verify-db.mjs` if the migration introduces an invariant.
5. Never edit an applied migration: the runner refuses a changed checksum. Add a repair migration.

## Adding a route

```ts
app.get('/api/v1/hotel/example', async (req) =>
  moduleHandler(req, 'front_office', 'hotel.frontdesk.view', async (ctx, db) => {
    // ctx.tenantId, ctx.userId, ctx.permissions
    return { items: [] };
  }),
);
```

`moduleHandler` authenticates, checks the permission, checks the licence and opens the RLS
transaction. Use `tenantHandler` only for platform-level routes that are not module-gated.

## Testing

The suite is integration-first: it provisions real tenants in a real PostgreSQL database, boots the
Fastify app in-process and calls it over HTTP. There are no mocks of the database or the payment
provider signature.

```bash
npm test               # unit + integration, serial
npm run test:unit
TEST_VERBOSE=true npm test   # surface pino errors from failing requests
```

Tests are order-coupled by design (they share one seeded tenant to exercise a realistic day). Add
new scenarios to `integration.test.ts` at the end and assert on database rows where correctness
matters (posting links, movement counts), not only on HTTP status.

## Debugging

- API logs are structured JSON; set `LOG_LEVEL=debug` and `TEST_VERBOSE=true`.
- PostgreSQL errors are mapped centrally in `apps/api/src/app.ts`; `409` with `constraint` details is
  usually a database invariant doing its job.
- To inspect RLS as the runtime role:
  `psql "$DATABASE_URL" -c "BEGIN; SELECT set_config('app.tenant_id','<uuid>',true); SELECT * FROM hotel.folios;"`.
- `node scripts/verify-db.mjs` catches missing RLS, missing `security_invoker`, grants on ledger
  tables, unbalanced journals and orphaned folios.
- Reset local data with `node scripts/db-dev.mjs reset` (drops and recreates the database).

## Web client

- `src/api.ts` is the only place that talks to HTTP. Add endpoints there or call `api()` directly in
  a page; both are typed by the generic parameter.
- `useAsync(loader, deps)` handles loading/error and exposes `reload`. `useAction()` wraps mutations
  with busy/error/notice state.
- `Table`, `Card`, `Stat`, `Badge`, `Field`, `Input`, `Select` are the primitives. Keep pages
  declarative; no global store.
- Navigation is hash-based; add a page to `NAV` in `App.tsx` and gate it with a module code so the
  lock is visible (the API remains the control).

## Release checklist

1. `bash scripts/verify.sh` (typecheck, builds, DB integrity, tests).
2. Update `RELEASE-NOTES.md` and, if scope changed, the traceability register.
3. Re-run the readiness report's gate table honestly.
4. Take a backup before applying migrations in production.
