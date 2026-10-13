#!/usr/bin/env bash
# Exit 0 when the paper API health and metrics endpoints answer on localhost.
set -euo pipefail
BASE="${1:-http://127.0.0.1:8787}"
health="$(curl -fsS "$BASE/health")"
printf '%s\n' "$health" | grep -q '"paperTestOnly":true'
curl -fsS "$BASE/metrics" | grep -q 'rwaix_paper_test_only 1'
echo "healthy $BASE"
