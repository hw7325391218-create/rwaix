# Recovery runbook

This note describes what the reference implementation actually does when something goes wrong. It is not an operations certification, and it does not describe a production custody or incident process. The kernel evaluates in process. Postgres, or embedded PGlite when `DATABASE_URL` is unset, stores a snapshot and a journal before the HTTP handler reports success. Restarting the API reloads that snapshot. It does not restore a revoked credential and it does not move assets. See `docs/operations.md` for the compose stack, health checks, and backups.

## Pause

`PAUSER` may pause a contract for at most 7 days (`Roles.MAX_PAUSE`). A zero duration or a longer duration reverts with `PauseDuration`. `unpause` clears the deadline. Pause does not migrate state and does not extend itself. The admin role is not the slasher and is not the bond releaser; those actions need their own roles.

## Reorg and finality

`FinalityGate.consume` succeeds only for `Final`.

- `Included` reverts `FinalityNotReached`. The off-chain executor returns `FINALITY_NOT_REACHED` and does not mark the intent executed.
- `Reorged` reverts `Reorged`. The service returns `CHAIN_EVENT_REORGED` and keeps the fee reservation.
- Only `Final` confirms execution.

Re-checking means setting inclusion again after the local chain reports a new status. This reference does not subscribe to a live chain.

## Unknown payment

`OUTCOME_UNKNOWN` stays inside coverage. `confirmFailed` on that attempt is rejected. A later reserve on the same obligation is rejected with `OUTCOME_UNKNOWN` before any asset mismatch is reported, so a second asset cannot slip past an unresolved attempt. Historical quote consumption is not rewritten when a price moves (`PRICE_DEVIATION`).

An operator of this reference resolves that by recording a later attributed or failed outcome through the ledger API that the attempt's state allows. There is no background sweeper that guesses.

## Key compromise

The verifier key signs receipts. The executor, treasury, slasher, bond releaser, reward approver, and status admin are separate grants. A compromised key should be removed from the in-memory grant set and the process restarted with a new key. Already issued receipts remain verifiable until `validUntil` or until subject status is revoked. Revocation is terminal for that subject: a later `ALLOW` does not execute against a revoked subject (`REVOKED` on prepare). This build has no key-rotation log. Issuance deployment can use a hardware wallet or a browser wallet; the reference process does not hold that key.

## Missing evidence and disputes

A policy evaluation with an empty graph is `INDETERMINATE`, not `ALLOW`. No receipt from that decision authorizes payment. `SWEEP` counts open disputes and resolves none of them. Silence is not an admission (`disputesResolvedBySilence` stays 0). An NFT delivery dispute in the section 17 scenario stays `OPEN` after the consideration is discharged. It does not refund, remint, reverse the transfer, or write a facility DCNFT rights binding. A partial acceptance of profile `nft.trade` is `STATE_CONFLICT`: one full portion is the transfer, and a smaller quantity does not invent a partial transfer. Confirmed execution keeps the payment inside coverage until attribution. It does not release that amount early.

## What not to do

- Do not deploy `Deploy.s.sol` anywhere except chain ids 31337 and 31338.
- Do not treat `RWAIX_TEST` balances or DCNFT-TEST tokens as assets outside this repository.
- Do not put a raw private key in a file or in the environment. Issuance deployment is `contracts/script/deploy-issuance.sh` or the browser page, and it does not mint.
- Do not mark a `未评测` module as passed to make the conformance claim green. `refuseMustWaiver` exists so that path stays closed.

## 恢复（摘要）

本文件只说明参考实现的实际行为，不是运维认证。状态在内存中，进程退出即丢失。暂停最长 7 天。只有 `Final` 可以确认执行；`Included` 与 `Reorged` 都不能把意图标成已执行，重组保留费用预留。`OUTCOME_UNKNOWN` 继续占用覆盖额度，不能用失败确认把它释放。密钥失陷后应撤销授权并重启；已签发回执在 `validUntil` 或主体被撤销之前仍可核验。证据缺失得到 `INDETERMINATE`。静默不构成对争议的承认。
