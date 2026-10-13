#!/usr/bin/env bash
# Render deploy/docker-compose.yml and require each Anvil command to stay one argument.
# The Foundry image entrypoint is `sh -c`, which executes only its next argument.
# Compose shell-splits a YAML string, so `command: "anvil --host 0.0.0.0 ..."`
# becomes argv [anvil, --host, ...] and Anvil never sees --host.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required to render the compose config" >&2
  exit 1
fi
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
docker compose -f "$ROOT/deploy/docker-compose.yml" config --format json > "$rendered"
python3 - "$rendered" << 'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {
    "anvil-a": "anvil --host 0.0.0.0 --port 8545 --chain-id 31337",
    "anvil-b": "anvil --host 0.0.0.0 --port 8545 --chain-id 31338",
}
services = doc.get("services") or {}
failed = False
for name, want in expected.items():
    got = (services.get(name) or {}).get("command")
    if got != [want]:
        print(f"{name}: rendered command {got!r}", file=sys.stderr)
        print(f"  want a one-item list [{want!r}]", file=sys.stderr)
        print("  Compose shell-splits a string; sh -c then runs only the first word.", file=sys.stderr)
        failed = True
if failed:
    sys.exit(1)
print("anvil-a and anvil-b commands are a single sh -c argument")
PY
