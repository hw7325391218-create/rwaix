# Operations runbook

This runbook is for the paper/test stack and for the opt-in chain follower. It is not a production operations certification and not a custody procedure. `RWAIX_TEST` and `DCNFT-TEST` stay local placeholders. The `$RWAIX` and `DCNFT` shells are a separate deploy. They do not mint. Issuance requires legal and compliance sign-off. The Slither notes in `docs/security-review.md` are not a professional audit.

## What one command starts

From the repository root:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

That starts:

| Service | Role | Host bind |
| --- | --- | --- |
| `postgres` | Durable documents, journal, chain index | `127.0.0.1:5432` |
| `anvil-a` | Local chain id `31337` (lock side, registry, local 4337 account). Inside the container Anvil listens on `0.0.0.0` | `127.0.0.1:8545` |
| `anvil-b` | Local chain id `31338` (remote mint side). Same in-container bind | `127.0.0.1:8546` |
| `deploy` | `Deploy.s.sol` broadcast to both chains, then exits | none |
| `api` | HTTP API, paper UI, indexer poll of chain A | `127.0.0.1:8787` |

Inside the API container the process listens on `0.0.0.0` so Docker can publish it. The publish address on the host is `127.0.0.1`. A process started with `pnpm start` binds `127.0.0.1` directly and uses embedded PGlite under `data/pglite` unless `DATABASE_URL` is set.

Ubuntu install, still paper/test only:

```bash
deploy/install-ubuntu.sh
deploy/install-ubuntu.sh --https-port 8443
```

`--https-port` starts Caddy with an internal certificate on `127.0.0.1` and reverse-proxies the paper UI. It does not request a public certificate and does not bind `0.0.0.0`.

`postgres`, `anvil-a`, `anvil-b`, and `api` use `restart: unless-stopped`. The `deploy` service stays `restart: "no"` because it is a one-shot broadcast. Anvil has no volume, so a restarted Anvil container is an empty chain and compose does not run `Deploy.s.sol` again.

A boot example is `deploy/rwaix.service`. Edit `WorkingDirectory`, `POSTGRES_PASSWORD`, and `DID_AUTHORITY`, then:

```bash
sudo cp deploy/rwaix.service /etc/systemd/system/rwaix.service
sudo systemctl daemon-reload
sudo systemctl enable --now rwaix.service
```

The unit is `Type=oneshot` with `RemainAfterExit=yes`. It runs `docker compose up -d --build` at boot and `docker compose down` on stop.

## Database password and public DID

Compose reads these from the shell or from a `.env` file in the working directory. Unset values keep the local defaults.

| Variable | Default | Effect |
| --- | --- | --- |
| `POSTGRES_USER` | `rwaix` | Postgres role and the user in `DATABASE_URL` |
| `POSTGRES_PASSWORD` | `rwaix` | Postgres password and the password in `DATABASE_URL` |
| `POSTGRES_DB` | `rwaix` | Database name |
| `DID_AUTHORITY` | `127.0.0.1:8787` | Host, `host:port`, or `host:path` passed to `did:web` |

The password is placed into `DATABASE_URL` as-is. Use a URL-safe password, with no `@`, `:`, `/`, or spaces, or percent-encode that same value in `POSTGRES_PASSWORD` and in any backup URL.

```bash
export POSTGRES_PASSWORD='choose-a-url-safe-password'
export DID_AUTHORITY='example.com:app'
docker compose -f deploy/docker-compose.yml up -d --build
```

`DID_AUTHORITY=127.0.0.1:8787` publishes `did:web:127.0.0.1%3A8787`. A numeric second segment is a port, so its colon is percent-encoded. A non-numeric segment is a path: `example.com:app` publishes `did:web:example.com:app`, which resolvers fetch as `https://example.com/app/did.json`. `example.com:3000:app` publishes `did:web:example.com%3A3000:app`. `GET /health` includes `issuerDid`. The document is `GET /did.json`, `GET /.well-known/did.json`, and `GET /identity/did.json`.

Changing `POSTGRES_PASSWORD` after the `pgdata` volume already exists does not rotate the role password inside that volume. Set the password before the first start, or change it with `ALTER ROLE` and then the compose variable together.

## Existing nginx under `/app/`

The compose ports stay on `127.0.0.1`. An existing nginx on the host can publish the paper UI under `/app/` without this repository binding `0.0.0.0`. The HTML and scripts request absolute paths, so these four locations are required:

| Browser path | Upstream |
| --- | --- |
| `/app/` | `http://127.0.0.1:8787/` |
| `/api/` | `http://127.0.0.1:8787/api/` |
| `/app.js` | `http://127.0.0.1:8787/app.js` |
| `/app.css` | `http://127.0.0.1:8787/app.css` |

```nginx
location /app/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
}
location /api/ {
    proxy_pass http://127.0.0.1:8787/api/;
    proxy_set_header Host $host;
}
location = /app.js {
    proxy_pass http://127.0.0.1:8787/app.js;
    proxy_set_header Host $host;
}
location = /app.css {
    proxy_pass http://127.0.0.1:8787/app.css;
    proxy_set_header Host $host;
}
```

`/app/` with a trailing slash on `proxy_pass` strips the prefix, so `https://example.com/app/` is the UI and `https://example.com/app/did.json` is the DID document. For that layout set `DID_AUTHORITY=example.com:app`. The home page still requests absolute `/app.css`, `/app.js`, and `/api/`. The link to the deploy page is relative (`deploy.html`), and `deploy.js` is relative to that page, so `https://example.com/app/deploy.html` and `https://example.com/app/deploy.js` are covered by `location /app/`. A host-level DID (`DID_AUTHORITY=example.com`, id `did:web:example.com`) needs `location /.well-known/did.json` proxied to `http://127.0.0.1:8787/.well-known/did.json`. The installer Caddy path is separate and still listens only on `127.0.0.1`.

## Health and metrics

```bash
deploy/healthcheck.sh http://127.0.0.1:8787
```

`GET /health` returns `paperTestOnly: true`, `issuerDid`, the storage backend, the journal count, and the last indexed chain head when `CHAIN_A_RPC` is set. `GET /metrics` is a text scrape (`rwaix_up`, `rwaix_journal_entries`, `rwaix_paper_test_only`). The UI is `GET /`. The default scenario is the synthetic NFT trade. Scenario runs are `POST /api/scenarios/{id}/run` for `nft`, `identity`, `content`, `data`, `supply`, `agent`, `compute`, `device`, and `cross`. `GET /api/conformance` builds the manifest for this process with Forge left `未评测`, because the API container does not run `forge test`. The NFT scenario does not connect to a company platform and does not mint a token.

## Indexer

`ChainIndexer` stores every seen block hash. An operation moves `COMMITTED` → `INCLUDED` → `FINAL` after `finalityDepth` confirmations counted from the inclusion block, or to `REORGED` when that hash leaves the canonical chain. The old hash row stays, with `canonical = false`. The API polls chain A when `CHAIN_A_RPC` is set. Unit tests use an in-process fake chain, not Anvil.

## Backups

```bash
DATABASE_URL="postgres://${POSTGRES_USER:-rwaix}:${POSTGRES_PASSWORD:-rwaix}@127.0.0.1:5432/${POSTGRES_DB:-rwaix}" deploy/backup.sh
```

Without `DATABASE_URL`, the script archives the PGlite directory. Restore a Postgres dump with `psql`. Restore PGlite by unpacking the tar over `data/pglite` while the API is stopped. A restore brings back the journal. It does not move tokens and it does not clear a revoked credential.

## Account recovery

The recovery flow is in `@rwaix/identity`. A proposal needs the guardian threshold. Execution waits out the delay. The controller or a guardian can freeze a proposal. Removing a guardian drops that guardian's approval. Execution rotates the controller version. `assetsMoved` and `credentialsRestored` stay false. Revoked credential ids stay revoked.

## Bridge and 4337

`forge test --root contracts` is the checked path for the lock/mint pair and the local entrypoint. Replay of a message id reverts. The minted total is compared with the locked total in that test. `Deploy.s.sol` can place the same contracts on the two compose chains. There is no long-running relayer, no light client, and no claim that this is a production bridge. The token admin remains a minter on the placeholder token. The local entrypoint is not the canonical ERC-4337 bundler. Session keys cannot widen scope or expiry. Child agent grants cannot widen tools, payees, assets, or amount.

## What to do when something is wrong

See `docs/recovery-runbook.md` for pause, reorg, unknown payment, and key compromise. Those behaviors are enforced in the reference service and the contracts. This stack does not page an on-call rotation.

## Chain follower

`RWAIX_NETWORK` is `local` (default, chain id `31337`), `sepolia` (`11155111`), or `mainnet` (`1`). `RWAIX_RPC_URL` (or `CHAIN_A_RPC`) is the endpoint. `RWAIX_TOKEN_ADDRESS` and `RWAIX_DCNFT_ADDRESS` are optional until you have deployed. The indexer polls only after `eth_chainId` matches the selected network. A mismatch is stored as `chain-id-mismatch` and is not indexed. Mainnet finality depth defaults to 64. Sepolia defaults to 12. Local stays 2. Override with `RWAIX_FINALITY_DEPTH`.

Mainnet refuses to start unless both of these are set:

```bash
export RWAIX_MAINNET_OPT_IN=1
export RWAIX_MAINNET_CONFIRMATION=MAINNET
```

`GET /api/network` returns the network name, chain id, redacted RPC host, and `signsOnBehalf: false`. It does not return a URL path or API key. `GET /api/network/verify` calls `issuanceEnabled` and `totalSupply` on the configured addresses. The UI shows a `MAINNET` banner when the server network is mainnet. The deploy page has its own local / sepolia / mainnet switch and starts on local.

## Mainnet deployment steps

The operator signs. This process does not. Do not set `PRIVATE_KEY`, `FOUNDRY_PRIVATE_KEY`, or `MNEMONIC`. The script rejects those variables and Foundry's `--interactive` private-key prompt.

```bash
export RWAIX_NETWORK=mainnet
export RWAIX_CHAIN_ID=1
export RWAIX_RPC_URL='https://your-mainnet-endpoint'
export RWAIX_ADMIN='0xYourHardwareWalletAddress'
export RWAIX_MAINNET_OPT_IN=1
contracts/script/deploy-issuance.sh --ledger --estimate-only
contracts/script/deploy-issuance.sh --ledger
```

`--trezor` replaces `--ledger`. `--browser` prints the UI path and does not broadcast. On the terminal, type `MAINNET` and then `DEPLOY`. Any other word exits before `forge script --broadcast`. Confirm both transactions on the device.

Then check the empty shells and start the follower:

```bash
cast call "$RWAIX_TOKEN_ADDRESS" "totalSupply()(uint256)" --rpc-url "$RWAIX_RPC_URL"
cast call "$RWAIX_TOKEN_ADDRESS" "issuanceEnabled()(bool)" --rpc-url "$RWAIX_RPC_URL"
cast call "$RWAIX_DCNFT_ADDRESS" "issuanceEnabled()(bool)" --rpc-url "$RWAIX_RPC_URL"
export RWAIX_TOKEN_ADDRESS='0xDeployedRwaix'
export RWAIX_DCNFT_ADDRESS='0xDeployedDcnft'
export RWAIX_MAINNET_CONFIRMATION=MAINNET
pnpm start
```

Expect supply `0` and issuance `false`. Do not call `enableIssuance` and do not grant `MINTER` or `REGISTRAR` without legal and compliance sign-off.

Sepolia uses the same script with `RWAIX_NETWORK=sepolia`, chain id `11155111`, and the word `DEPLOY` only. No funded Sepolia key is stored here, so a live Sepolia deployment is not executed by this repository. A local mainnet fork is `RWAIX_FORK_RPC_URL=... contracts/script/fork-dry-run.sh`. That fork binds `127.0.0.1` and is not a mainnet broadcast.

The browser page is `http://127.0.0.1:8787/deploy.html`. Select the network, connect an injected wallet, estimate gas, tick the no-mint acknowledgement, and let the wallet sign. Mainnet also requires the server opt-in flag and the typed word `MAINNET`. The page never asks for a private key.

## What this stack refuses

- `Deploy.s.sol` on any chain other than `31337` and `31338`, and minting `RWAIX_TEST` or `DCNFT-TEST` on chain id `1`.
- A raw private key, mnemonic, or Foundry `--interactive` key prompt in the issuance script.
- Broadcasting the issuance shells without a printed gas estimate and a typed confirmation.
- Binding the paper UI to a public interface in the installer.
- Treating a green conformance claim as certification. `mainnet-deployment` stays `未评测` because this process does not broadcast to Ethereum mainnet. Modules that this process did not evaluate stay `未评测`.
