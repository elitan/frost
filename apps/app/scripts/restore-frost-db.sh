#!/usr/bin/env bash
# Restore Frost's own SQLite database from a snapshot.
# Usage: restore-frost-db.sh <snapshot.db> [data-dir]
# Stop Frost first (systemctl stop frost), then start it again afterwards.
set -euo pipefail

SNAPSHOT="${1:-}"
DATA_DIR="${2:-${FROST_DATA_DIR:-/opt/frost/data}}"
DB="$DATA_DIR/frost.db"

if [ -z "$SNAPSHOT" ] || [ ! -f "$SNAPSHOT" ]; then
  echo "usage: $0 <snapshot.db> [data-dir]" >&2
  echo "local snapshots live in $DATA_DIR/backups" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet frost 2>/dev/null; then
  echo "frost is running; stop it first: systemctl stop frost" >&2
  exit 1
fi

if [ -f "$DB" ]; then
  KEEP="$DB.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$DB" "$KEEP"
  for suffix in -wal -shm; do
    if [ -f "$DB$suffix" ]; then
      cp -p "$DB$suffix" "$KEEP$suffix"
    fi
  done
  echo "previous database saved to $KEEP"
fi

rm -f "$DB-wal" "$DB-shm"
cp "$SNAPSHOT" "$DB"
chmod 600 "$DB"
echo "restored $SNAPSHOT -> $DB"
echo "start frost again: systemctl start frost"
