#!/bin/sh
# Deploy the local reference contracts onto the two compose Anvil chains.
# Chain 31337 is the lock side. Chain 31338 is the mint side. Chain id 1 is refused.
set -eu
KEY="${PRIVATE_KEY:?set PRIVATE_KEY to the local Anvil account}"
wait_for() {
  name="$1"
  url="$2"
  i=0
  while [ "$i" -lt 60 ]; do
    if cast chain-id --rpc-url "$url" >/dev/null 2>&1; then
      echo "$name ready"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "$name did not answer" >&2
  return 1
}
wait_for anvil-a http://anvil-a:8545
wait_for anvil-b http://anvil-b:8545
forge script script/Deploy.s.sol --rpc-url http://anvil-a:8545 --private-key "$KEY" --broadcast
forge script script/Deploy.s.sol --rpc-url http://anvil-b:8545 --private-key "$KEY" --broadcast
echo "local deploy finished; this is not a mainnet deployment"
