# W3C VC interop

`pnpm vc-interop` (workflow `.github/workflows/vc-interop.yml`) starts the local VC-API and runs three W3C test suites, pinned to fixed commits in `packages/vc-api/src/run-suites.ts`. The report is uploaded as the `vc-interop-report` artifact (`reports/vc-interop/summary.json`).

| Suite | Pinned commit | Passing | Failing |
| --- | --- | --- | --- |
| [w3c/vc-data-model-2.0-test-suite](https://github.com/w3c/vc-data-model-2.0-test-suite) | `62836458636bd1b8309214626ec8fc85de43f8bd` | 118 | 0 |
| [w3c/vc-di-eddsa-test-suite](https://github.com/w3c/vc-di-eddsa-test-suite) | `1e86cc4ca16d77eb76cd15e3905a624bc16c0879` | 87 | 0 |
| [w3c/vc-di-ecdsa-test-suite](https://github.com/w3c/vc-di-ecdsa-test-suite) | `94dca21d8c1c7ad3dc31f21144d4d957567726b5` | 102 | 0 |

Source: vc-interop run on `main` at 2026-10-13 (commit `d28df10`). These are self-run results against the pinned suites, not a W3C listing. The implementation manifest [`rwaix.json`](rwaix.json) is proposed upstream in [w3c/vc-test-suite-implementations#128](https://github.com/w3c/vc-test-suite-implementations/pull/128), which is still open.

## Test keys: no identity trust

The issuer DIDs in `rwaix.json` (`did:key:z6MkiBxm…` for `eddsa-rdfc-2022`, `did:key:zDnaedXh…` for `ecdsa-rdfc-2019`) come from fixed seeds in `packages/vc-api/src/keys.ts`. **They are public test keys.** Anyone can derive the private keys and sign as these DIDs. A valid signature from them, including from the public endpoint at `https://www.rwaix.io/vc-api/`, only shows that the cryptosuite works. It says nothing about who issued a credential.

To use your own keys, set these environment variables before starting the server:

- `RWAIX_VC_EDDSA_SEED_HEX`: 32-byte Ed25519 seed, 64 hex characters
- `RWAIX_VC_ECDSA_KEY_HEX`: 32-byte P-256 private key, 64 hex characters

Injected keys change the issuer DIDs, so update `rwaix.json` to match. Keep the values in a secret store, not in the repository.
