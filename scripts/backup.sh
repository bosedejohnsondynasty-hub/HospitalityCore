#!/bin/sh
# Hospitality Core database backup.
#
# Usage:
#   ./scripts/backup.sh                     # uses DATABASE_ADMIN_URL or PG* env vars
#   BACKUP_DIR=/backups ./scripts/backup.sh
#
# Produces a compressed custom-format dump, a SHA-256 checksum and a manifest.
set -eu

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DATABASE="${PGDATABASE:-hospitality_core}"
FILE="$BACKUP_DIR/hospitality_core_$STAMP.dump"

mkdir -p "$BACKUP_DIR"

echo "[backup] dumping $DATABASE to $FILE"
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file "$FILE" \
  "$DATABASE"

sha256sum "$FILE" > "$FILE.sha256"

cat > "$BACKUP_DIR/hospitality_core_$STAMP.manifest.json" <<EOF
{
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "$DATABASE",
  "file": "$(basename "$FILE")",
  "format": "pg_dump custom",
  "checksum_file": "$(basename "$FILE").sha256",
  "tool": "scripts/backup.sh"
}
EOF

echo "[backup] verifying checksum"
(cd "$BACKUP_DIR" && sha256sum -c "$(basename "$FILE").sha256")

echo "[backup] pruning archives older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -name 'hospitality_core_*' -type f -mtime "+$RETENTION_DAYS" -print -delete

echo "[backup] complete: $FILE"
