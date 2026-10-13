#!/usr/bin/env bash
# Snapshot the paper/test database. Does not back up a mainnet or a custody system.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-$ROOT/data/backups}"
mkdir -p "$OUT"
if [ -n "${DATABASE_URL:-}" ]; then
  FILE="$OUT/rwaix-$STAMP.sql"
  pg_dump --dbname="$DATABASE_URL" --no-owner --file="$FILE"
  echo "$FILE"
  exit 0
fi
DIR="${DATA_DIR:-$ROOT/data/pglite}"
if [ ! -d "$DIR" ]; then
  echo "no DATA_DIR at $DIR and DATABASE_URL is unset" >&2
  exit 1
fi
FILE="$OUT/rwaix-pglite-$STAMP.tar"
tar -C "$(dirname "$DIR")" -cf "$FILE" "$(basename "$DIR")"
echo "$FILE"
