#!/usr/bin/env bash
# Deploy the $RWAIX and DCNFT shells with the operator's own wallet.
# This script never reads a private key, never writes one, and never signs.
# Foundry's --interactive flag prompts for a raw private key, so it is refused.
# Signers: --ledger, --trezor, or --browser (injected wallet / WalletConnect in the UI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTRACTS="$ROOT/contracts"
cd "$CONTRACTS"

refuse_secrets() {
  if [[ -n "${PRIVATE_KEY:-}${FOUNDRY_PRIVATE_KEY:-}${DEPLOYER_PRIVATE_KEY:-}${MNEMONIC:-}${FOUNDRY_MNEMONIC:-}" ]]; then
    echo "refusing a private key or mnemonic in the environment" >&2
    exit 2
  fi
  local arg
  for arg in "$@"; do
    case "$arg" in
      --private-key|--private-keys|--mnemonic|--mnemonics|--keystore|--password|--password-file|--interactive|--interactives|-i|--unlocked)
        echo "refusing ${arg}: this script does not accept raw keys or forge's private-key prompt" >&2
        exit 2
        ;;
    esac
  done
}

usage() {
  echo "Usage: RWAIX_NETWORK=local|sepolia|mainnet RWAIX_RPC_URL=... RWAIX_ADMIN=0x... $0 --ledger|--trezor|--browser [--estimate-only]" >&2
  echo "Mainnet also needs RWAIX_MAINNET_OPT_IN=1. You will type MAINNET and DEPLOY before any broadcast." >&2
  echo "The browser path opens the paper UI. The wallet signs. This process does not." >&2
}

refuse_secrets "$@"

MODE=""
ESTIMATE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --ledger) MODE="ledger" ;;
    --trezor) MODE="trezor" ;;
    --browser) MODE="browser" ;;
    --estimate-only) ESTIMATE_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  usage
  exit 2
fi

NETWORK="${RWAIX_NETWORK:-local}"
RPC="${RWAIX_RPC_URL:-${CHAIN_A_RPC:-}}"
ADMIN="${RWAIX_ADMIN:-}"

case "$NETWORK" in
  local) EXPECT_CHAIN=31337 ;;
  sepolia) EXPECT_CHAIN=11155111 ;;
  mainnet) EXPECT_CHAIN=1 ;;
  *) echo "unknown RWAIX_NETWORK=$NETWORK" >&2; exit 2 ;;
esac

if [[ "$NETWORK" == "mainnet" && "${RWAIX_MAINNET_OPT_IN:-}" != "1" ]]; then
  echo "mainnet requires RWAIX_MAINNET_OPT_IN=1 before this script will estimate or deploy" >&2
  exit 2
fi

if [[ "$MODE" == "browser" ]]; then
  echo "Browser deployment does not run forge broadcast."
  echo "Start the UI with: pnpm start"
  echo "Open http://127.0.0.1:8787/deploy.html"
  echo "Choose ${NETWORK}, connect an injected wallet (MetaMask, Rabby, or a WalletConnect session that injects window.ethereum)."
  echo "The page estimates gas, requires a typed confirmation on mainnet, and asks the wallet to sign. This shell does not sign."
  exit 0
fi

if [[ -z "$RPC" || -z "$ADMIN" ]]; then
  echo "RWAIX_RPC_URL and RWAIX_ADMIN (the hardware wallet address, not a key) are required" >&2
  exit 2
fi
if [[ ! "$ADMIN" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "RWAIX_ADMIN must be a 20-byte hex address" >&2
  exit 2
fi

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
if [[ "$CHAIN_ID" != "$EXPECT_CHAIN" ]]; then
  echo "RPC chain id ${CHAIN_ID} does not match ${NETWORK} (${EXPECT_CHAIN})" >&2
  exit 2
fi

forge build --silent

estimate_one() {
  local name="$1"
  local bytecode args data gas
  bytecode="$(forge inspect "$name" bytecode)"
  args="$(cast abi-encode "constructor(address)" "$ADMIN")"
  data="${bytecode}${args#0x}"
  gas="$(cast estimate --rpc-url "$RPC" --from "$ADMIN" --create "$data")"
  echo "$gas"
}

TOKEN_GAS="$(estimate_one RwaixToken)"
DCNFT_GAS="$(estimate_one RwaixDcnft)"
GAS_PRICE="$(cast gas-price --rpc-url "$RPC")"
TOTAL_GAS=$((TOKEN_GAS + DCNFT_GAS))
# shellcheck disable=SC2046
COST_WEI=$(python3 - <<PY
print($TOTAL_GAS * $GAS_PRICE)
PY
)
echo "network: ${NETWORK} chain-id: ${CHAIN_ID}"
echo "admin (signer address only): ${ADMIN}"
echo "RwaixToken estimated gas: ${TOKEN_GAS}"
echo "RwaixDcnft estimated gas: ${DCNFT_GAS}"
echo "gas price wei: ${GAS_PRICE}"
echo "estimated max cost wei: ${COST_WEI}"
echo "deployment mints nothing. MINTER and REGISTRAR stay ungranted. issuanceEnabled stays false."
echo "Issuance later requires legal and compliance sign-off. This script will not send that transaction."

if [[ "$ESTIMATE_ONLY" == "1" ]]; then
  echo "estimate only; no broadcast"
  exit 0
fi

if [[ ! -t 0 ]]; then
  echo "refusing to broadcast without a typed confirmation on a terminal" >&2
  exit 2
fi

if [[ "$NETWORK" == "mainnet" ]]; then
  echo "Type MAINNET to confirm this is Ethereum mainnet:"
  read -r typed
  if [[ "$typed" != "MAINNET" ]]; then
    echo "confirmation was not MAINNET; nothing was broadcast" >&2
    exit 2
  fi
  export RWAIX_MAINNET_CONFIRMATION=MAINNET
fi

echo "Type DEPLOY to ask the hardware wallet to sign the two creation transactions:"
read -r deploy_word
if [[ "$deploy_word" != "DEPLOY" ]]; then
  echo "confirmation was not DEPLOY; nothing was broadcast" >&2
  exit 2
fi

SIGNER=(--sender "$ADMIN")
if [[ "$MODE" == "ledger" ]]; then
  SIGNER+=(--ledger)
else
  SIGNER+=(--trezor)
fi

echo "Broadcasting through the hardware wallet. Confirm each transaction on the device. This process does not hold the key."
forge script script/DeployIssuance.s.sol \
  --rpc-url "$RPC" \
  --broadcast \
  --slow \
  "${SIGNER[@]}"
echo "Record the two deployed addresses. Do not grant MINTER or REGISTRAR unless legal and compliance sign-off is complete."
