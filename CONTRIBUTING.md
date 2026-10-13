# Contributing

This repository is the paper/test reference for the 2026-10-12 RWAIX whitepaper. It is not a standards-body specification and not a certification.

## Setup

Requirements: Node.js 22 and pnpm 10.33.3. Foundry 1.8.5 is required for the contract tests and for acceptance items A42–A44.

```bash
pnpm install --frozen-lockfile
forge install foundry-rs/forge-std@v1.17.0
pnpm typecheck
pnpm test
pnpm conformance
pnpm acceptance
```

Run `forge install` from `contracts/`. This checkout is already a git repository. Do not pass `--no-commit`.

## Acceptance results

`pnpm acceptance` runs the 50 items in `docs/acceptance/ACCEPTANCE-50.md` and writes a JSON and Markdown report. The headline must be the count from that run. Do not hardcode a pass, skip a check, or copy the archived 2026-10-12 50/50 record into the report. If an item cannot be executed here, leave it `FAIL` or `NOT_EVALUATED` with the reason.

Modules that the conformance manifest marks `未评测` stay `未评测` until that process actually evaluates them. A MUST failure cannot be waived into a pass.

## Changes

Keep schema bytes frozen unless the change is an intentional schema edit. After a schema edit, run `pnpm freeze` and commit the new digest. A semantic change needs a new schema id.

Do not add a path that asks for or stores a raw private key. The local Anvil key is the public Foundry development key and is not a mainnet signer. Do not enable token issuance. Issuance stays disabled until legal and compliance sign-off.

## License

Contributions are licensed under Apache-2.0, the same license as this repository. See `LICENSE`.
