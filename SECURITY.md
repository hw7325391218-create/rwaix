# Security

This repository is a paper and test reference. It is not a production system, not a certification, and not a professional audit. `RWAIX_TEST` and `DCNFT-TEST` are local placeholders. Issuance on the empty mainnet shells stays disabled until legal and compliance sign-off.

## Reporting

Report a vulnerability through a private GitHub security advisory on this repository, or contact the maintainers privately. Do not open a public issue that includes exploit details, credentials, RPC URLs, or private keys.

Please include the commit SHA, the component, and a description that lets a maintainer reproduce the issue on a local chain. Do not include a live private key or a hosted database password.

## What not to send

Do not send production credentials, basic-auth passwords, server addresses, or RPC URLs that contain API keys. The public Anvil development key checked into the local compose file is Foundry's well-known account 0. It is for the local chain only. Do not use it on Ethereum mainnet or any public network.

The compose default Postgres password `rwaix` is a local development default. Set `POSTGRES_PASSWORD` before any shared deployment.

## Scope

A report about a bug in signing, revocation, replay, supply accounting, or the mainnet opt-in gate is in scope for this reference. A request to enable minting, store a raw private key, or mark an unevaluated module as passed is not a security fix.
