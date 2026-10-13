#!/usr/bin/env bash
# Local dry run of the issuance deploy against an Anvil mainnet fork.
# Nothing is broadcast to Ethereum. The unlocked signer is Anvil's local impersonation
# of its well-known test account, and only on 127.0.0.1.
# A real Sepolia or mainnet deployment still uses deploy-issuance.sh with a hardware wallet
# or the browser page. This script does not ask for a funded test key.
set -euo pipefail

if [[ -n "${PRIVATE_KEY:-}${FOUNDRY_PRIVATE_KEY:-}${MNEMONIC:-}" ]]; then
  echo "refusing a private key in the environment" >&2
  exit 2
fi

FORK_URL="${RWAIX_FORK_RPC_URL:-}"
if [[ -z "$FORK_URL" ]]; then
  echo "Set RWAIX_FORK_RPC_URL to an Ethereum mainnet HTTP endpoint, then re-run." >&2
  echo "Example: RWAIX_FORK_RPC_URL=https://your-mainnet-endpoint contracts/script/fork-dry-run.sh" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/contracts"
PORT="${RWAIX_FORK_PORT:-18545}"
SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ANVIL_PID=""

cleanup() {
  if [[ -n "$ANVIL_PID" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL_PID=$!

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if cast chain-id --rpc-url "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

CHAIN_ID="$(cast chain-id --rpc-url "http://127.0.0.1:${PORT}")"
if [[ "$CHAIN_ID" != "1" ]]; then
  echo "fork chain id is ${CHAIN_ID}, expected 1" >&2
  exit 1
fi

echo "Local fork is chain id 1 on 127.0.0.1:${PORT}. This is not a mainnet broadcast."

RWAIX_MAINNET_OPT_IN=1 \
RWAIX_MAINNET_CONFIRMATION=MAINNET \
forge script script/DeployIssuance.s.sol \
  --rpc-url "http://127.0.0.1:${PORT}" \
  --broadcast \
  --unlocked \
  --sender "$SENDER"

TOKEN="$(jq -r '.transactions[] | select(.contractName=="RwaixToken") | .contractAddress' broadcast/DeployIssuance.s.sol/1/run-latest.json | head -1)"
DCNFT="$(jq -r '.transactions[] | select(.contractName=="RwaixDcnft") | .contractAddress' broadcast/DeployIssuance.s.sol/1/run-latest.json | head -1)"
SUPPLY="$(cast call "$TOKEN" "totalSupply()(uint256)" --rpc-url "http://127.0.0.1:${PORT}")"
ENABLED="$(cast call "$TOKEN" "issuanceEnabled()(bool)" --rpc-url "http://127.0.0.1:${PORT}")"
NFT_ENABLED="$(cast call "$DCNFT" "issuanceEnabled()(bool)" --rpc-url "http://127.0.0.1:${PORT}")"
echo "fork dry run token=${TOKEN} supply=${SUPPLY} issuanceEnabled=${ENABLED} dcnft=${DCNFT} dcnftIssuance=${NFT_ENABLED}"
if [[ "$SUPPLY" != "0" || "$ENABLED" != "false" || "$NFT_ENABLED" != "false" ]]; then
  echo "fork dry run deployed a contract that is not an empty issuance-disabled shell" >&2
  exit 1
fi
echo "fork dry run passed: no premine, issuance disabled, local fork only"
