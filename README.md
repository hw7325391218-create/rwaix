# RWAIX reference implementation

[![acceptance](https://github.com/hw7325391218-create/rwaix/actions/workflows/acceptance.yml/badge.svg)](https://github.com/hw7325391218-create/rwaix/actions/workflows/acceptance.yml)

Paper/test system for the RWAIX trust and transaction proposal (whitepaper dated 2026-10-12, superseding v6.4). Protocol version `rwaix-0.1.0`, schema release `1.1.0`, implementation `0.5.1`.

The normative text is `docs/spec/whitepaper-2026-10-12-zh.txt`. It supersedes `docs/spec/whitepaper-v6.4-zh.txt`. The v6.4 English file remains the previous translation and is not a translation of the 2026-10-12 revision. The change map is `docs/spec/CHANGELOG-v6.4-to-2026-10-12.md`. Schema bytes are unchanged from release `1.1.0`.

This repository is a reference implementation. It is not a standards-body specification, not a certification, and not a production system. `RWAIX_TEST` and `DCNFT-TEST` are local placeholders. They are not issued securities and they are not a live network token. The local deploy script still refuses chain id `1`. A separate issuance deploy can place empty `$RWAIX` and `DCNFT` shells on Sepolia or mainnet only after an explicit network switch. Mainnet also needs `RWAIX_MAINNET_OPT_IN=1` and the typed word `MAINNET`. That deploy does not mint. Issuance stays disabled until legal and compliance sign-off. The steps George runs himself are in `INSTALL.md`.

Chinese: [README.zh-CN.md](README.zh-CN.md).

## Layout

| Path | Role |
| --- | --- |
| `packages/schemas/v1` | Frozen JSON Schemas (`additionalProperties: false`) and `freeze.json` digests |
| `packages/protocol` | Canonical JSON, JWS (ES256), EIP-712, schema validation, error codes |
| `packages/policy-engine` | Closed predicate engine. No arbitrary code |
| `packages/verifier` | TrustReceipt issue and replay check. Receipt pins `policyDigest` |
| `packages/economics` | Rights ledger and network ledger (fees, bonds, rewards, supply), snapshotted with the service |
| `packages/sdk` | `ReferenceService`: the nine interfaces, plus `trade` and `setStatus` |
| `packages/adapter-sdk` | Industry adapter interface |
| `packages/adapter-compute` | Compute (`算力`) adapter, profile `compute.delivery` 1.0.0. Whitepaper v6.4 section 18.6 later extension |
| `packages/adapter-profiles` | NFT trade profile `nft.trade` 1.0.0, plus the other section 18 profiles |
| `packages/persistence` | Postgres or embedded PGlite journal |
| `packages/indexer` | Block-hash snapshots, finality, reorg |
| `packages/status-list` | W3C Bitstring Status List |
| `packages/disclosure` | SD-JWT selective disclosure over JWS ES256 |
| `packages/zk` | Groth16 range proof (public test ceremony) |
| `packages/identity` | `did:key` / `did:web`, VC, account recovery |
| `packages/agent` | Constrained agent budgets |
| `packages/scenarios` | Eight demos. NFT trade is first. Section 19 chain stays a later extension |
| `packages/server` | Paper UI and HTTP API |
| `packages/conformance` | Vector runner. Writes `ConformanceManifest` |
| `verifiers/python` | Second kernel verifier for the shared vectors |
| `contracts` | Foundry contracts, local test bridge, local 4337 account |
| `scripts/demo-flow.ts` | Section 26 NFT walkthrough |
| `docs/spec` | Whitepaper 2026-10-12 Chinese text, the v6.4 texts it supersedes, and the changelogs |
| `deploy/docker-compose.yml` | Postgres, two Anvil chains, deploy, API, UI |
| `docs/operations.md` | Install, health, backup, indexer, bridge limits |
| `docs/signing-domain.md` | Signing, canonicalization, nonce, time |
| `docs/recovery-runbook.md` | Pause, reorg, unknown payment, key compromise |

Three ledgers stay separate and are linked only by business ids (`tradeId`, `obligationId`, `seriesId`, `objectId`):

1. Object and evidence (`ReferenceService`).
2. Rights bindings (test-only; `securitiesIssuance` is false).
3. Network economics (quotes, fees, bonds, rewards, supply).

## Module status

| Module | Status |
| --- | --- |
| Schema pack, signing domain, policy engine, verifier, nine interfaces | Implemented and covered by tests |
| Seven later profiles and the section 19 chain | Implemented in process. Compute is an extension, not the first application |
| NFT trade profile (`nft.trade`) | Synthetic order, licence terms, full-portion acceptance, separate payment, and an open dispute. Not a company-platform integration and not a description of every company NFT product |
| Postgres / PGlite journal and chain indexer | Implemented. Not a production HA database |
| W3C Bitstring Status List | Implemented for the 16KB list, bit order, and irreversible revocation |
| SD-JWT selective disclosure | Implemented over the existing JWS. BBS+ is not implemented |
| Groth16 range proof wired into evidence and receipt checks | Implemented. Soundness of the ceremony is 未评测 |
| DID (`did:key`, `did:web`) and JWS verifiable credentials | Implemented. Not the full JSON-LD VC data model |
| Account recovery (threshold, delay, freeze) | Implemented. Recovery does not move assets or restore credentials |
| Constrained agent budgets | Implemented. Child grants only narrow |
| Local ERC-4337-shaped account | Forge test on a local entrypoint. Not the canonical bundler, and not called by the HTTP executor |
| Local two-chain lock/mint | Forge test plus compose deploy. Not a production bridge and not a light client |
| Python kernel verifier | Passes the shared canonical, policy, SD-JWT, and status vectors. It does not run Groth16 |
| Custody, real payment rails, ERC-5484 certification | 未评测 |
| Mainnet deployment and standards certification | 未评测, and refused where the code can refuse it |

`pnpm conformance` prints a `ConformanceManifest`. A passing claim covers only the MUST vectors this process ran. Modules marked `未评测` are outside that claim. MUST failures cannot be waived into a pass.

## Interfaces

`ReferenceService` exposes:

`registerObject`, `publishVersion`, `resolveBinding`, `submitEvidence`, `evaluatePolicy`, `verifyReceipt`, `checkStatus`, `prepareIntent`, `executeIntent`.

`trade` and `setStatus` are reference helpers. They are signed actions, not extra unsigned side doors. Requests use schema id `rwaix.signed.v1`. The same idempotency key with a different payload digest returns `IDEMPOTENCY_CONFLICT`. A retry of the same signed body returns the stored result. Nonces are consumed only after the idempotency check.

Policy decisions are `ALLOW`, `DENY`, or `INDETERMINATE`. Missing evidence is `INDETERMINATE`, not `ALLOW`. A cycle is `DENY`. Depth, node, edge, and timeout budgets fail closed and do not issue an ALLOW receipt. Unknown required fields are rejected. Optional registered extensions are kept.

## Run the tests

Requirements: Node.js 22, pnpm 10.33.3 (`packageManager` in the root `package.json`). Foundry is required only for the contract job.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm conformance
pnpm acceptance
pnpm demo
```

## Acceptance suite

`pnpm acceptance` runs the 50 items in [`docs/acceptance/ACCEPTANCE-50.md`](docs/acceptance/ACCEPTANCE-50.md). It writes `packages/acceptance/out/acceptance-report.json` and `packages/acceptance/out/acceptance-report.md`. The headline is the count from that process, for example `48/50 passed (0 failed, 2 not evaluated)` in GitHub Actions, where Chrome is installed. On a machine without Chrome the browser layout item is also `NOT_EVALUATED`, so the same run reports `47/50 passed (0 failed, 3 not evaluated)`. `NOT_EVALUATED` means the criterion was not met in that environment. The command does not reuse or claim the archived 2026-10-12 50/50 record.

Foundry is required for the chain-id and issuance items. Install `forge-std` first, as in the contract commands below. The browser layout item needs Chrome. `puppeteer-core` is installed with the workspace. Without Chrome that item is `NOT_EVALUATED`. The GitHub Actions acceptance job installs Chrome, so that item runs there. The two-team exchange (A21) and the section 22 performance and adoption study (A50) stay `NOT_EVALUATED`.

## W3C VC interop and test-key notice

`pnpm vc-interop` runs the pinned W3C VC test suites against the local VC-API: 118/87/102 passing, 0 failing. See [`docs/interop/README.md`](docs/interop/README.md).

> **Warning:** the VC-API issuer keys, including the public endpoint at `https://www.rwaix.io/vc-api/`, are public test keys derived from fixed seeds in the source. Signatures from them carry no identity trust. Set `RWAIX_VC_EDDSA_SEED_HEX` and `RWAIX_VC_ECDSA_KEY_HEX` to use your own keys.

GitHub Actions runs `pnpm acceptance` on push and on pull request and uploads the JSON and Markdown report as the `acceptance-report` artifact. The badge above links to that workflow.

Contracts (Foundry 1.x, Solidity 0.8.26). `contracts/lib` is gitignored:

```bash
forge install foundry-rs/forge-std@v1.17.0
forge test --root contracts
```

`forge install` needs a git repository. Do not pass `--no-commit`; current Foundry images removed that flag. This checkout already is a git repository. A copied `contracts/` directory needs `git init` first. Install does not create a commit unless you pass `--commit`.

`pnpm conformance` runs `forge test` when `forge` is on `PATH` and records `solidity-dual-token` as pass or fail. If `forge` is absent, that module is `未评测` and the off-chain MUST vectors can still pass. The contract job is the place that must go green.

Schema bytes are frozen in `packages/schemas/v1/freeze.json`. After an intentional schema edit, run `pnpm freeze` and commit the new digest. A semantic change needs a new schema id.

## Demo flow

`pnpm demo` walks a synthetic NFT trade, the first planned application in the 2026-10-12 whitepaper section 17. No chain is contacted, no real NFT is minted, and no real funds move. The indivisible object and the zero network fee are demo parameters. Compute delivery remains available as a scenario, not as this default path. Acceptance then payment is the selected demo order.

1. Bind. Register one ordinary artwork object (`ASSET`, `TRANSFERABLE`) and publish version 1. The caller may hold neither DCNFT nor `RWAIX_TEST`.
2. Commit. Buyer and seller sign the same `termsDigest`. Consideration is `12000` `USD_TEST` (decimals 2). The network fee is `0` `RWAIX_TEST`. Licence fields stay in the trade terms. The facility rights ledger stays empty.
3. Deliver. The seller records quantity 1 of one indivisible NFT. A TrustReceipt does not replace acceptance.
4. Verify. In-scope evidence can be `ALLOW` with a pinned `policyDigest`. Evidence that sets `copyrightTransfer` to `true` is `DENY` (`DOMAIN_POLICY_SCOPE_MISMATCH`).
5. Accept. One portion. A second acceptance of that portion returns `PORTION_DUPLICATE` and does not increase quantity.
6. Authorize. A treasury role authorizes the payable. The receipt is not that authorization.
7. Submit. `INCLUDED` returns `FINALITY_NOT_REACHED`. `FINAL` executes `12000`.
8. Reconcile. Funds attribution is separate from execution.
9. Apply. Discharge settles the consideration and keeps the execution record. The zero network-fee obligation stays open.
10. Dispute. The delivery dispute stays `OPEN`. Silence does not refund, remint, or reverse the discharged record.

## Paper UI and local chains

`pnpm start` serves the browser demo on `http://127.0.0.1:8787`. The page opens on the NFT trade and can run all eight scenarios. Each one shows commitment, evidence verification, independent acceptance, and the price versus network-fee split, plus a disclosure of scope, this run's recorded steps, and unfinished production conditions. No real funds move and no real NFT is minted. The default store is embedded PGlite. Seller control, recipient, and chain fields in the NFT scenario are synthetic declarations. They are not chain confirmation, copyright review, or platform authority. Section 21's later engineering stage is not claimed.

```bash
pnpm start
docker compose -f deploy/docker-compose.yml up -d --build
deploy/install-ubuntu.sh
deploy/install-ubuntu.sh --https-port 8443
```

Compose publishes Postgres, Anvil `31337`, Anvil `31338`, and the API on `127.0.0.1` only. `Deploy.s.sol` accepts those two chain ids and reverts otherwise. The issuance shells use `contracts/script/deploy-issuance.sh` and never a raw private key. Tests do not need Docker; Foundry uses its own EVM. Details, backups, health checks, and the mainnet steps are in `docs/operations.md` and `INSTALL.md`.

## License

Apache-2.0. See [LICENSE](LICENSE). Shipping this reference does not grant rights in the whitepaper or in any token, and it is not a certification. Report security issues as described in [SECURITY.md](SECURITY.md). Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).
