#!/bin/sh
set -eu

echo "[entrypoint] waiting for PostgreSQL…"
attempt=1
while [ "$attempt" -le 60 ]; do
  if node -e "import('pg').then(async ({default: pg}) => { const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL }); await c.connect(); await c.query('SELECT 1'); await c.end(); })" >/dev/null 2>&1; then
    echo "[entrypoint] PostgreSQL is reachable"
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if [ "$attempt" -gt 60 ]; then
  echo "[entrypoint] PostgreSQL did not become reachable" >&2
  exit 1
fi

echo "[entrypoint] ensuring restricted runtime role…"
node scripts/db-bootstrap.mjs

echo "[entrypoint] applying migrations…"
node scripts/migrate.mjs

echo "[entrypoint] seeding catalogue and permissions…"
node scripts/seed.mjs

echo "[entrypoint] starting API…"
exec node apps/api/dist/server.js
