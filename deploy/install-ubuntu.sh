#!/usr/bin/env bash
# Install the paper/test stack on an Ubuntu server.
# Published ports stay on 127.0.0.1. This script does not open a public listener
# and does not deploy to mainnet.
#
# Usage:
#   deploy/install-ubuntu.sh
#   deploy/install-ubuntu.sh --https-port 8443
#
# Exported POSTGRES_PASSWORD and DID_AUTHORITY are read by docker compose.
# The default password is rwaix and the default DID authority is 127.0.0.1:8787.
# A boot unit example is deploy/rwaix.service. An existing nginx /app/ proxy
# is documented in docs/operations.md. This script does not install either.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTTPS_PORT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --https-port)
      HTTPS_PORT="${2:?--https-port needs a port}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -n "$HTTPS_PORT" ]; then
  case "$HTTPS_PORT" in
    ''|*[!0-9]*) echo "--https-port must be numeric" >&2; exit 2 ;;
  esac
  if [ "$HTTPS_PORT" -lt 1 ] || [ "$HTTPS_PORT" -gt 65535 ]; then
    echo "--https-port out of range" >&2
    exit 2
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required. Install Docker Engine, then re-run this script." >&2
  exit 1
fi

cd "$ROOT"
docker compose -f deploy/docker-compose.yml up -d --build

if [ -n "$HTTPS_PORT" ]; then
  cat > deploy/Caddyfile <<EOF
{
  admin off
}
https://127.0.0.1:${HTTPS_PORT} {
  tls internal
  reverse_proxy 127.0.0.1:8787
}
EOF
  docker rm -f rwaix-caddy >/dev/null 2>&1 || true
  docker run -d --name rwaix-caddy --network host \
    -v "$ROOT/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2 caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "Caddy internal TLS is on https://127.0.0.1:${HTTPS_PORT} and proxies the paper UI."
fi

echo "Paper/test UI: http://127.0.0.1:8787"
echo "Postgres: 127.0.0.1:5432  Anvil A: 127.0.0.1:8545  Anvil B: 127.0.0.1:8546"
echo "Mode is paper/test only. Tokens are local placeholders. This is not certification."
