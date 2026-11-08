# Installation guide

Hospitality Core is designed for customer-hosted installation. Core hotel, restaurant and bar
operations do not require any vendor cloud service.

## 1. Sizing

| Deployment | CPU | RAM | Disk | Notes |
| --- | --- | --- | --- | --- |
| Single property, ≤ 40 rooms | 2 vCPU | 4 GB | 40 GB SSD | PostgreSQL and API on one host |
| Multi-outlet property | 4 vCPU | 8 GB | 100 GB SSD | Separate database host recommended |
| Group / multi-branch | 8 vCPU | 16 GB | 250 GB SSD | Managed PostgreSQL, replicated backups |

PostgreSQL 15 or later is required. PostgreSQL 17 is what the automated suite runs against.

## 2. Docker Compose (recommended)

```bash
git clone <repository> hospitality-core
cd hospitality-core
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
POSTGRES_SUPERUSER_PASSWORD=<long random secret>
APP_DB_PASSWORD=<long random secret>
SETUP_TOKEN=<long random secret>
APP_ORIGIN=https://hotel.example.com
CORS_ORIGINS=https://hotel.example.com
```

Generate secrets with `openssl rand -hex 32`. Never reuse the database superuser password for the
application role; the API refuses to start as a superuser on purpose.

Start the stack:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

The API entrypoint waits for PostgreSQL, creates the restricted `hospitality_app` role, applies all
migrations, seeds the product/module/permission catalogue and starts the server. The `web` service
serves the SPA and proxies `/api` internally.

Verify:

```bash
curl -s http://localhost:8080/healthz      # {"status":"ok",...}
curl -s http://localhost:8080/api/v1/setup/status
```

Open `http://<host>:8080` and complete the first-run screen, or provision from the CLI:

```bash
docker compose exec api node scripts/provision-tenant.mjs --help
```

After the first tenant exists, set `ALLOW_API_SETUP=false` and restart the API so the setup endpoint
cannot be used again.

### TLS

Terminate TLS at a reverse proxy in front of `web` (Caddy, nginx, Traefik) and set `APP_ORIGIN` and
`CORS_ORIGINS` to the public HTTPS origin. Session tokens are bearer tokens, so TLS is mandatory for
any network deployment.

## 3. Manual installation (without Docker)

```bash
npm ci
npm run build -w @hospitality/api
npm run build -w @hospitality/web
```

Create the database and role:

```bash
sudo -u postgres psql -c "CREATE DATABASE hospitality_core;"
sudo -u postgres psql -c "CREATE ROLE hospitality_app LOGIN PASSWORD '...';"
```

Configure `.env`:

```dotenv
NODE_ENV=production
API_PORT=4000
APP_ORIGIN=https://hotel.example.com
DATABASE_ADMIN_URL=postgres://postgres:<password>@127.0.0.1:5432/hospitality_core
DATABASE_URL=postgres://hospitality_app:<password>@127.0.0.1:5432/hospitality_core
APP_DB_USER=hospitality_app
APP_DB_PASSWORD=<password>
REQUIRE_RESTRICTED_DB_ROLE=true
ALLOW_API_SETUP=true
SETUP_TOKEN=<random>
CORS_ORIGINS=https://hotel.example.com
```

Then:

```bash
npm run db:setup     # grants, migrations, seed
node apps/api/dist/server.js
```

Serve `apps/web/dist` with nginx using `docker/nginx.conf` as the template (change
`proxy_pass http://api:4000` to `http://127.0.0.1:4000`).

Run the API under systemd or another supervisor; it is a stateless process. Do not run it as root.

## 4. Upgrades

Migrations are forward-only and checksummed. The runner refuses to run if a previously applied
migration changed.

```bash
git pull
docker compose build
docker compose run --rm --entrypoint sh api -c "node scripts/migrate.mjs"   # apply first
docker compose up -d
```

If a release adds a new migration, take a backup before applying it. There is no automatic
down-migration: recovery is restore-from-backup (see below) or a forward-repair migration.

Recommended sequence for production:

1. `docker compose --profile ops run --rm backup`
2. Apply migrations.
3. Start the new containers.
4. Check `/readyz`, then sign in and run one read-only report.

## 5. Backup

```bash
docker compose --profile ops run --rm backup
```

`scripts/backup.sh` writes `backups/hospitality_core_<timestamp>.dump` (custom format, compressed),
a SHA-256 checksum and a JSON manifest, then prunes archives older than `BACKUP_RETENTION_DAYS`.

Schedule it nightly from cron on the host:

```cron
15 2 * * * cd /opt/hospitality-core && docker compose --profile ops run --rm backup >> /var/log/hc-backup.log 2>&1
```

Copy `backups/` off the host (object storage, NAS or tape). A backup that only exists on the same
disk is not a backup.

## 6. Restore

Restore into a **new** database first, verify, then switch the API to it.

```bash
createdb hospitality_core_restore
PGDATABASE=hospitality_core_restore \
CONFIRM_RESTORE=restore-hospitality-core ./scripts/restore.sh backups/hospitality_core_<ts>.dump
```

The script verifies the checksum, terminates existing connections, restores with `--clean`, then
re-applies the runtime role and migrations. Point `DATABASE_URL` and `DATABASE_ADMIN_URL` at the
restored database and start the API. Sign in, open the trial balance and confirm it is balanced
before reopening the front desk.

Restore drill is required before go-live; see `docs/PRODUCTION-READINESS.md` (Gate E).

## 7. Operations

| Task | Command |
| --- | --- |
| Health | `curl /healthz` |
| Readiness (database) | `curl /readyz` |
| Logs | `docker compose logs -f api` |
| Apply migrations | `node scripts/migrate.mjs` |
| Re-seed catalogue | `node scripts/seed.mjs` (idempotent) |
| Backup | `scripts/backup.sh` |
| Restore | `scripts/restore.sh <dump>` |

The API logs structured JSON (pino). Authorization headers, setup tokens and passwords are redacted.
Ship logs to your own collector; no telemetry leaves the installation.

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| API exits with "Refusing to start: database role … can bypass row level security" | `DATABASE_URL` uses a superuser/owner. Use `hospitality_app` (created by `scripts/db-bootstrap.mjs`). |
| `402 MODULE_NOT_LICENSED` | The module is deactivated for the tenant. Activate it in the Licence centre. |
| `409 ROOM_UNAVAILABLE` | Another active allocation overlaps those dates. Choose another room or change dates. |
| `424 PROVIDER_NOT_CONFIGURED` | Paystack/Flutterwave keys are unset. Set them in `.env` and restart. |
| Login says "Multiple accounts use this email" | Supply the tenant code on the sign-in screen. |
| Migration checksum mismatch | A previously applied migration file was edited. Restore the original file; add a new migration instead. |
