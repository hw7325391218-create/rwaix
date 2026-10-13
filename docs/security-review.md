# Security review (not an audit)

This note records a Slither 0.11.6 pass and the Forge tests added with implementation 0.5.0. It is not a professional audit, not a formal verification, and not a statement that the contracts are safe to issue a token. Issuance stays disabled. Legal and compliance sign-off is required before anyone calls `enableIssuance` or grants `MINTER` or `REGISTRAR`.

Command:

```bash
slither . --config-file contracts/slither.config.json --exclude-dependencies
```

`contracts/lib` is filtered out. Foundry tests: `forge test --root contracts` (22 tests), including access control, a bounded pause, emergency pause, and a reentrancy attempt against `Lockbox`.

## Fixes made in this pass

- `$RWAIX` and `DCNFT` shells do not mint in the constructor. `MINTER` and `REGISTRAR` are not granted. `issuanceEnabled` defaults to false. Transfers of the new DCNFT stay off.
- `emergencyPause` halts for at most 7 days. `pause` still rejects 0 and any duration above 7 days. Approve stays available during a pause so an allowance can be revoked. Transfers, mint, and registrar changes revert while paused.
- `nonReentrant` is the first modifier on the issuance token, the issuance DCNFT, and the local lock/mint bridge.
- `Lockbox` writes the lock id before `transferFrom`, and `require` checks the boolean return. A false return reverts.
- `revokeRole` cannot remove the caller's own admin role. Role grant and revoke emit events. Grants to `address(0)` revert.
- `SimpleAccount` rejects a zero owner and a zero entry point. A zero session key cannot authorize a user operation. `execute` rejects a zero target. `ecrecover` rejects `v` outside 27/28 and a high `s`.
- `SupplyLedger.cap` and the account's constructor-set addresses are `immutable`.

## Slither results that remain

Slither 0.11.6 still prints some of the items above. The source no longer matches those descriptions:

| Detector | Impact | What the code does |
| --- | --- | --- |
| `unchecked-transfer` on `Lockbox.lock` | High | False positive. The call is `require(token.transferFrom(...), "transfer failed")`. |
| `missing-zero-check` on `SimpleAccount` owner, entry point, and `execute` target | Low | False positive. Those addresses are checked. `sessionKey` may be zero and then cannot authorize. |
| `immutable-states` | Optimization | False positive. The listed variables are already `immutable`. |
| `timestamp` on pause, fee-quote expiry, and session expiry | Low | Intentional. Pause is bounded. Quotes expire. Session keys expire. A miner can move the timestamp only inside the protocol's usual tolerance. |
| `assembly` and `ecrecover` in the local account | Informational | The local 4337-shaped account recovers a signature. High `s` is rejected. This account is not the canonical EntryPoint. |
| `low-level-calls` in the local entry point and account | Informational | The calls check the boolean success flag and revert on failure. |
| `missing-inheritance` from `ITransferFrom` | Informational | False positive. That interface is the local lockbox's ERC-20 shape. `DCNFT.transferFrom` does not return a boolean and is not that token. |

No other High or Medium finding referred to a path that is still unchecked in the source.

## Not reviewed

There was no economic-audit of a live issuance, no fuzz campaign beyond these tests, no formal proof, and no review of a third-party RPC or wallet. `mainnet-deployment` stays `未评测` because this process does not broadcast to chain id 1.
