# Install and deploy

The default network is local Anvil chain id `31337`. Sepolia and mainnet are explicit switches. This file is the procedure the operator runs. The reference process does not sign, does not store a private key, and does not mint.

`$RWAIX` and `DCNFT` deployment creates two empty shells. `totalSupply` stays 0. `issuanceEnabled` stays false. `MINTER` and `REGISTRAR` are not granted. Turning issuance on later requires legal and compliance sign-off. This repository does not send that transaction. A Slither run and the Forge tests are not a professional audit.

Foundry's `--interactive` flag prompts for a raw private key. `contracts/script/deploy-issuance.sh` refuses that flag, `--private-key`, mnemonics, and any `PRIVATE_KEY` in the environment.

## Local paper stack

```bash
corepack enable
pnpm install
pnpm test
pnpm start
```

The UI is `http://127.0.0.1:8787`. Compose, health, and backups are in `docs/operations.md`.

Before `docker compose up`, export `POSTGRES_PASSWORD` and `DID_AUTHORITY` if the local defaults (`rwaix` and `127.0.0.1:8787`) are not what you want. `GET /health` reports `issuerDid`. A systemd example is `deploy/rwaix.service`.

An existing nginx can publish this stack under `/app/` while compose keeps listening on `127.0.0.1:8787`. The pages request absolute paths, so the server needs locations for `/app/`, `/api/`, `/app.js`, and `/app.css`. With `DID_AUTHORITY=example.com:app` the public id is `did:web:example.com:app` and the document is `https://example.com/app/did.json`. The full snippet is in `docs/operations.md`.

## What you type yourself

Use one signer. Do not export a key for this repository.

| Signer | How |
| --- | --- |
| Ledger | `deploy-issuance.sh --ledger` after the gas print and the typed words |
| Trezor | `deploy-issuance.sh --trezor` after the same confirmation |
| Browser wallet | `deploy-issuance.sh --browser`, then `http://127.0.0.1:8787/deploy.html` with MetaMask, Rabby, or a WalletConnect session that injects `window.ethereum` |

The shell script prints estimated gas and wei cost, then waits. Mainnet waits until you type `MAINNET`, then `DEPLOY`. Any other word exits without a broadcast. The browser page shows a `MAINNET` banner, asks the wallet for `eth_estimateGas` before `eth_sendTransaction`, and will not enable the sign button until the checkbox is set. On mainnet the page also posts the typed word `MAINNET` to the API, which accepts it only when the server was started with `RWAIX_MAINNET_OPT_IN=1`.

## Mainnet deployment

1. Install Foundry (`forge` and `cast` 1.x) and Node 22. Open the hardware wallet's Ethereum app, or install a browser wallet. Fund that address with enough ETH for two contract creations. This repository cannot estimate your exact fee until you point it at your RPC.
2. Choose an HTTPS RPC you control. Do not commit it. A URL with an API key stays in your shell for one process and is redacted to the host in `/api/network`.
3. Export only these values. Do not export a private key.

```bash
export RWAIX_NETWORK=mainnet
export RWAIX_CHAIN_ID=1
export RWAIX_RPC_URL='https://your-mainnet-endpoint'
export RWAIX_ADMIN='0xYourHardwareWalletAddress'
export RWAIX_MAINNET_OPT_IN=1
```

`RWAIX_ADMIN` is the address, not a key.

4. Estimate, without broadcasting:

```bash
contracts/script/deploy-issuance.sh --ledger --estimate-only
```

Read the gas and wei lines. Stop if the cost is not acceptable.

5. Broadcast only after you type the two words on the terminal. Confirm both transactions on the device. The script passes `--ledger` or `--trezor` to `forge script`. It does not add `--private-key` or `--interactive`.

```bash
contracts/script/deploy-issuance.sh --ledger
```

6. Copy the two addresses from the Forge broadcast log. Check them before any indexer points at them:

```bash
cast call "$RWAIX_TOKEN_ADDRESS" "totalSupply()(uint256)" --rpc-url "$RWAIX_RPC_URL"
cast call "$RWAIX_TOKEN_ADDRESS" "issuanceEnabled()(bool)" --rpc-url "$RWAIX_RPC_URL"
cast call "$RWAIX_DCNFT_ADDRESS" "issuanceEnabled()(bool)" --rpc-url "$RWAIX_RPC_URL"
```

Expect supply `0` and both issuance flags `false`.

7. Restart the API so the indexer and the deployment verifier follow that RPC. Finality depth defaults to 64 blocks on mainnet. The process refuses to start unless the typed confirmation is present as well as the opt-in flag:

```bash
export RWAIX_TOKEN_ADDRESS='0xDeployedRwaix'
export RWAIX_DCNFT_ADDRESS='0xDeployedDcnft'
export RWAIX_MAINNET_CONFIRMATION=MAINNET
export RWAIX_FINALITY_DEPTH=64
pnpm start
```

`GET /api/network` reports `mainnet: true` and does not return the RPC path or API key. The UI shows a `MAINNET` banner. `GET /api/network/verify` reads `eth_chainId`, code, `issuanceEnabled`, and `totalSupply`. The indexer stores block hashes only when the RPC chain id is 1.

### Browser path on mainnet

Start the API with `RWAIX_MAINNET_OPT_IN=1` and `RWAIX_NETWORK=mainnet` only if the indexer should follow mainnet. You can also leave `RWAIX_NETWORK=local` while the opt-in flag is set, open `/deploy.html`, press `mainnet`, type `MAINNET`, connect the injected wallet, estimate gas, tick the acknowledgement, and press the sign button. The wallet switches to chain id `1` and shows two creation transactions. Reject them in the wallet if the gas or the bytecode is not what you expect. The page has no private-key field.

## Sepolia

Sepolia does not use the word `MAINNET`. It still requires the explicit network name. There is no funded test key in this repository, so a live Sepolia broadcast is not run here. The same script is the procedure when your own wallet holds Sepolia ETH:

```bash
export RWAIX_NETWORK=sepolia
export RWAIX_CHAIN_ID=11155111
export RWAIX_RPC_URL='https://your-sepolia-endpoint'
export RWAIX_ADMIN='0xYourAddress'
contracts/script/deploy-issuance.sh --ledger --estimate-only
contracts/script/deploy-issuance.sh --ledger
```

Type `DEPLOY` when the gas cost is acceptable. Then set `RWAIX_TOKEN_ADDRESS`, `RWAIX_DCNFT_ADDRESS`, and `pnpm start`. Finality depth defaults to 12. Check issuance the same way as mainnet.

The browser page's `sepolia` button asks the wallet to switch to chain id `11155111`. Add Sepolia in the wallet yourself. The page does not inject an RPC.

## Fork dry run

A mainnet fork stays on `127.0.0.1`. It is not a broadcast. Set `RWAIX_FORK_RPC_URL` to a mainnet HTTP endpoint and run:

```bash
contracts/script/fork-dry-run.sh
```

Anvil impersonates its well-known local account on that loopback port. The script checks supply `0` and `issuanceEnabled=false`, then stops Anvil. Do not point this script at a public mempool RPC with `--broadcast` yourself. `deploy-issuance.sh` refuses `--unlocked`.

## After deployment

Do not call `enableIssuance`. Do not grant `MINTER` or `REGISTRAR`. Those calls exist on the contracts so a later, separate compliance process can be explicit. They are not part of this install. Pause with the pauser role if you need to halt transfers for at most 7 days. `emergencyPause` uses that same maximum.
