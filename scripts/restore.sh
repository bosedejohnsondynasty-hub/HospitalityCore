#!/bin/sh
# Hospitality Core database restore.
#
# Usage:
#   CONFIRM_RESTORE=restore-hospitality-core ./scripts/restore.sh backups/hospitality_core_20260101T000000Z.dump
#
# The restore is destructive: it replaces objects in the target database.
# Always restore into a fresh database first and verify before switching traffic.
set -eu

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "usage: $0 <backup.dump>" >&2
  exit 2
fi

if [ "${CONFIRM_RESTORE:-}" != "restore-hospitality-core" ]; then
  echo "Refusing to restore without CONFIRM_RESTORE=restore-hospitality-core" >&2
  exit 3
fi

DATABASE="${PGDATABASE:-hospitality_core}"

if [ -f "$FILE.sha256" ]; then
  echo "[restore] verifying checksum"
  (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256")
else
  echo "[restore] WARNING: no checksum file found next to $FILE"
fi

echo "[restore] terminating existing connections to $DATABASE"
psql -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DATABASE' AND pid <> pg_backend_pid();"

echo "[restore] restoring $FILE into $DATABASE"
pg_restore \
  --dbname "$DATABASE" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$FILE"

echo "[restore] re-applying the restricted runtime role and grants"
node "$(dirname "$0")/db-bootstrap.mjs"
node "$(dirname "$0")/migrate.mjs"

echo "[restore] complete. Start the API and verify /readyz before reopening the desk."
