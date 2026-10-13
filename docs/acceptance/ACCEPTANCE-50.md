# Acceptance suite: 50 items

This suite is derived from the 2026-10-12 whitepaper, `docs/spec/whitepaper-2026-10-12-zh.txt`. The primary source is section 22. Items also come from the normative requirements in sections 4 and 5, and from sections 7, 8, 10, 17, 19, 21, and 26 where section 22 points at them.

`pnpm acceptance` executes each item and writes `packages/acceptance/out/acceptance-report.json` and `packages/acceptance/out/acceptance-report.md`. The headline is the count from that process. A `NOT_EVALUATED` item was not met in that environment. A `FAIL` item ran and did not meet its pass criterion.

This suite does not reuse, replay, or claim the archived local Node/WebCrypto record of 50/50 described in section 26.3. That record is a historical collation. A new run prints its own count.

## A01 — Deterministic policy replay

- Clause: section 22, minimum security threshold, deterministic output on the published test set.
- Preconditions: the policy engine is loaded in this process. No network is required.
- Inputs: one `EvaluationInput` with an active subject, an acyclic graph, and `statusNotIn` plus `graphAcyclic`. The same object is evaluated twice.
- Pass: both evaluations return `ALLOW` and the same `decisionId`.

## A02 — Invalid signature produces no authorization

- Clause: section 22, invalid signature must not produce an executable authorization.
- Preconditions: a fresh `ReferenceService`. Clock `2026-10-11T00:00:00Z`.
- Inputs: a signed `registerObject` whose JWS proof is altered after signing.
- Pass: the result is `SIGNATURE_INVALID` and the object store stays empty.

## A03 — Expired deadline produces no authorization

- Clause: section 22, expiry must not produce an executable authorization.
- Preconditions: service clock `2026-10-11T00:00:00Z`.
- Inputs: `registerObject` with deadline `2020-01-01T00:00:00Z`.
- Pass: the result is `EXPIRED` and the object store stays empty.

## A04 — Revocation blocks execution

- Clause: section 22 revocation case, and section 4 N02 (authority is bound to revocation status).
- Preconditions: an object at binding version 1, an active subject, an authorized service obligation, and an `ALLOW` receipt.
- Inputs: `setStatus` to `REVOKED`, then `prepareIntent` for that receipt.
- Pass: `prepareIntent` returns `REVOKED` and obligation coverage stays 0.

## A05 — Wrong audience produces no authorization

- Clause: section 22, wrong audience.
- Preconditions: service audience is the reference default.
- Inputs: `registerObject` signed for audience `not-this-service`.
- Pass: the result is `AUDIENCE_MISMATCH` and the object store stays empty.

## A06 — Nonce replay produces no second authorization

- Clause: section 22, replay.
- Preconditions: a fresh service.
- Inputs: two different `registerObject` bodies signed with the same nonce.
- Pass: the first call succeeds, the second returns `NONCE_REUSED`, and exactly one object is stored.

## A07 — Unauthorized role produces no authorization

- Clause: section 22, unauthorized action.
- Preconditions: the stranger holds no role.
- Inputs: the stranger registers an object whose controller is someone else, and the stranger calls `setStatus`.
- Pass: both calls return `UNAUTHORIZED` and no object is stored.

## A08 — DENY does not become an executable authorization

- Clause: section 22, failure does not silently become accept.
- Preconditions: the compute profile is set up far enough to issue a receipt.
- Inputs: evidence whose `challengeId` does not match the signed terms, then `prepareIntent` on that receipt.
- Pass: the decision is `DENY` with `DOMAIN_POLICY_SCOPE_MISMATCH`, `prepareIntent` returns `STATE_CONFLICT`, and coverage stays 0.

## A09 — Changing the payment asset does not create a second payment right

- Clause: section 4 N01. The same debt on another asset must not create an extra payment right.
- Preconditions: one service obligation bound to `USD_TEST`.
- Inputs: a reserve of `RWAIX_TEST` on that obligation, and a second `openObligation` with the same id.
- Pass: the reserve is `ASSET_MISMATCH`, the second open is `STATE_CONFLICT`, one obligation remains, and coverage is 0.

## A10 — Missing authority is not ALLOW, and holding no token still registers

- Clause: section 4 N02 and section 5. Missing authority is deny or indeterminate. Token holdings are not the access gate.
- Preconditions: a policy whose only rule is `issuerAllowlist`, and a graph with no credential. A separate service has no recorded balances.
- Inputs: that policy evaluation, plus `accessPath` and `registerObject` for a signer with neither token.
- Pass: the decision is `INDETERMINATE` with `MISSING_AUTHORITY`. Registration succeeds with `tokenBalanceChecked` false and both holdings false.

## A11 — A new version keeps the previous version

- Clause: section 4 N03.
- Preconditions: a registered object.
- Inputs: publish binding versions 1 and 2 with different content digests, then resolve version 1.
- Pass: version 1 still returns its original `contentDigest`.

## A12 — Payment confirmation does not close acceptance or a dispute

- Clause: section 4 N04. Chain or payment success does not infer acceptance or the end of a dispute.
- Preconditions: an open trade and a delivery event. No acceptance has been signed.
- Inputs: a `PAYMENT_SUBMITTED` event, then a dispute.
- Pass: fulfillment is not `FULFILLED`, the accepted quantity is absent, and the dispute is `OPEN`.

## A13 — A duplicate portion does not double quantity

- Clause: section 4 N05.
- Preconditions: a delivered quantity of 1.
- Inputs: two acceptances of `portion-1` with different acceptance ids.
- Pass: the second call is `PORTION_DUPLICATE` and the accepted quantity stays 1.

## A14 — OUTCOME_UNKNOWN keeps coverage and blocks a new asset

- Clause: section 4 N06.
- Preconditions: a reserved attempt of 40 on an approved amount of 100.
- Inputs: `markUnknown`, then a reserve of a different asset.
- Pass: the second reserve is `OUTCOME_UNKNOWN`, coverage stays 40, and the attempt count stays 1.

## A15 — Coverage cannot exceed the approved amount

- Clause: section 4 N06 and section 7.2.
- Preconditions: approved amount 100.
- Inputs: a live reserve of 60, then a live reserve of 50.
- Pass: the second reserve is `OVERSPEND` and coverage stays 60.

## A16 — Silence does not resolve a dispute

- Clause: section 4 N07.
- Preconditions: an open dispute whose evidence deadline is in the past relative to the clock.
- Inputs: advance the clock past the deadline and call `SWEEP`.
- Pass: `disputesResolvedBySilence` is 0 and the dispute stays `OPEN`.

## A17 — Missing evidence is INDETERMINATE

- Clause: section 4 N08 and section 21. Missing evidence is not a valid proof.
- Preconditions: `evidenceFresh` is the only rule.
- Inputs: a graph with no nodes.
- Pass: the decision is `INDETERMINATE` and is not `ALLOW`.

## A18 — An unknown required field is rejected

- Clause: section 5 N09. An unsupported required field is rejected and is not silently dropped.
- Preconditions: `unknownField` is `REJECT` and `secret` is not an allowed field.
- Inputs: an observation payload that contains `secret`.
- Pass: the decision is `DENY` with `UNKNOWN_FIELD`, and the payload still contains `secret`.

## A19 — The manifest lists unevaluated modules and cannot waive a MUST

- Clause: section 5 N10.
- Preconditions: `buildManifest({ includeForge: false })` in this process.
- Inputs: the manifest modules, the claim statement, and `refuseMustWaiver()`.
- Pass: `mainnet-deployment`, `standards-certification`, and `zk-soundness` are `未评测`. `refuseMustWaiver()` throws. The claim statement mentions `未评测`.

## A20 — Python kernel verifier agrees on the shared vectors

- Clause: section 21, two verifier implementations on one snapshot. This item covers the shared kernel vectors only.
- Preconditions: `python3` and `verifiers/python` dependencies.
- Inputs: `python3 verifiers/python/test_verifier.py`.
- Pass: the process exits 0. The recorded detail states that this is a second kernel implementation, not a second team and not an exchange of NFT, licence, or qualification packs.

## A21 — Two independent teams exchange NFT, licence, and qualification packs

- Clause: section 5.3 and section 22. At least two independent implementation teams exchange the same trades.
- Preconditions: a second implementation team and an exchange of the three packs.
- Inputs: none exist in this repository. The W3C VC-API in `@rwaix/vc-api` is one implementation talking to itself.
- Pass: not applicable. The item stays `NOT_EVALUATED`. One process calling itself is not that exchange, and a passing W3C suite run is not two teams exchanging NFT, licence, and qualification packs.

Path toward the exchange, in order:

1. This repository's issuer and verifier pass the W3C VC Data Model 2.0 suite and the Data Integrity `eddsa-rdfc-2022` and `ecdsa-rdfc-2019` suites in CI. That shows one implementation can issue and verify VC Data Model 2.0 credentials with `did:key`. It is not an exchange with another team.
2. `docs/interop/rwaix.json` is an implementation manifest in the `w3c/vc-test-suite-implementations` shape, with placeholder endpoints. It is kept in this repository and is not submitted to W3C or sent to other implementers.
3. The remaining step is a second independent team exchanging the NFT, licence, and qualification packs with this implementation. Until that exchange happens, A21 stays `NOT_EVALUATED`.

## A22 — Fee and rights mismatch is rejected

- Clause: section 22 dual-token acceptance and section 7.
- Preconditions: a `RIGHTS_DISTRIBUTION` obligation.
- Inputs: a fee-path `reserve` against that obligation.
- Pass: `FEE_RIGHT_MISMATCH` and coverage 0.

## A23 — Wrong contract or decimals is rejected

- Clause: section 22 and section 7.2.
- Preconditions: `USD_TEST` registered at a fixed contract and 2 decimals.
- Inputs: one quote with a different contract, and one quote with 6 decimals.
- Pass: `ASSET_MISMATCH`, then `DECIMALS_MISMATCH`, and no quote is stored.

## A24 — An expired quote is rejected

- Clause: section 22 and section 7.2.
- Preconditions: the acceptance clock is `2026-10-11T00:00:00Z`.
- Inputs: a quote whose expiry is `2026-10-01T00:00:00Z`.
- Pass: `QUOTE_EXPIRED` and no quote is stored.

## A25 — A price jump does not rewrite consumed amount

- Clause: section 22 and section 7.2.
- Preconditions: an accepted quote that has already been reserved.
- Inputs: `rewriteConsumed()`.
- Pass: `PRICE_DEVIATION` and the stored consumed amount is unchanged.

## A26 — Concurrent live attempts cannot overspend

- Clause: section 22 and section 7.2.
- Preconditions: approved amount 100.
- Inputs: live reserves of 70 and 30, then a third reserve of 1.
- Pass: the third reserve is `OVERSPEND` and coverage stays 100.

## A27 — An unknown payment is not a confirmed failure

- Clause: section 22 and section 7.2.
- Preconditions: a reserved attempt of 25 marked `OUTCOME_UNKNOWN`.
- Inputs: `confirmFailed` on that attempt.
- Pass: `OUTCOME_UNKNOWN` and coverage stays 25.

## A28 — A duplicate reward is rejected

- Clause: section 22 and section 7.3.
- Preconditions: a budget of 100 and one approved claim for a service, provider, and period.
- Inputs: a second claim id for the same service, provider, and period.
- Pass: `DUPLICATE_REWARD` and allocated amount stays at the first claim.

## A29 — Slash without the slasher role is rejected

- Clause: section 22 and section 7.3.
- Preconditions: a locked bond.
- Inputs: `slashBond` as `TREASURY`, then `slashBond` as `SLASHER`.
- Pass: the treasury call is `UNAUTHORIZED_SLASH` while the bond stays `LOCKED`. The slasher call moves it to `SLASHED`.

## A30 — A bridge message cannot double supply

- Clause: section 22 and section 7.4.
- Preconditions: cap 100, native mint 40, one source lock of 10, and one destination mint of that lock.
- Inputs: the same bridge message id submitted again.
- Pass: `BRIDGE_DOUBLE_SUPPLY` and economic outstanding stays 40.

## A31 — Supply stays inside the cap

- Clause: section 22 supply conservation and section 7.4.
- Preconditions: cap 50, already fully minted.
- Inputs: `mintNative(1)`.
- Pass: `BRIDGE_DOUBLE_SUPPLY`. Circulating and outstanding stay 50.

## A32 — A rights roster binding does not move cash

- Clause: section 22 roster consistency and section 7.1.
- Preconditions: network circulating is 4. The rights ledger is empty.
- Inputs: one test-only series binding with `securitiesIssuance` false.
- Pass: the rights export has one row, circulating stays 4, and payment attempts stay 0.

## A33 — Reward allocation stays within the budget cap

- Clause: section 22 budget use and section 7.3.
- Preconditions: budget cap 100 and an existing allocation of 60.
- Inputs: another service claim of 50 in the same period.
- Pass: `OVERSPEND` and allocated stays 60.

## A34 — Slash and release are different roles

- Clause: section 22, slash appeal, as a technical permission split. This item does not claim a legal appeal hearing.
- Preconditions: a locked bond.
- Inputs: `releaseBond` as `SLASHER`, and `slashBond` as `BOND_RELEASE`.
- Pass: `UNAUTHORIZED` and `UNAUTHORIZED_SLASH`. The bond stays `LOCKED`.

## A35 — A service obligation does not draw the reward budget

- Clause: section 22, cost without reward subsidy. This is a ledger separation check, not a published cost study.
- Preconditions: the reward budget is fully allocated at 10. A service obligation is approved for 100.
- Inputs: a service reserve of 40, then another reward of 1.
- Pass: service coverage is 40, the reward allocation stays 10, and the extra reward is `OVERSPEND`.

## A36 — A holder of neither token can register

- Clause: section 22 open participation and section 5.
- Preconditions: no `DCNFT` and no `RWAIX_TEST` balance is recorded for the signer.
- Inputs: `accessPath` and `registerObject`.
- Pass: `allowed` is true, both holdings are false, and `tokenBalanceChecked` is false.

## A37 — A circular endorsement is DENY

- Clause: section 8, evidence-graph cycles.
- Preconditions: `graphAcyclic` is enabled.
- Inputs: two nodes and two `BASED_ON` edges that point at each other.
- Pass: `DENY` with `GRAPH_CYCLE`.

## A38 — An over-depth graph is an error, not ALLOW

- Clause: section 21 resource budget, and the evidence-graph depth limit.
- Preconditions: `maxDepth` is 2.
- Inputs: a `BASED_ON` chain of three nodes.
- Pass: the evaluation is not ok, the error is `DEPTH_EXCEEDED`, and no `ALLOW` decision is returned.

## A39 — ALLOW, DENY, and INDETERMINATE stay distinct

- Clause: section 10, TrustReceipt decisions. Revoked and expired status are not allow.
- Preconditions: `statusNotIn` forbids `REVOKED`, `SUSPENDED`, and `EXPIRED`.
- Inputs: an active subject, a revoked subject, an expired subject, and a snapshot with no entry.
- Pass: the four results are `ALLOW`, `DENY`/`STATUS_REVOKED`, `DENY`/`STATUS_EXPIRED`, and `INDETERMINATE`.

## A40 — A child agent grant cannot widen tools

- Clause: section 17, agent grants only narrow.
- Preconditions: a parent grant for tool `render`, cap 100, redelegation allowed.
- Inputs: a child that adds tool `admin`, then a child whose cap is 101.
- Pass: the extra tool is `UNAUTHORIZED`, the larger cap is `OVERSPEND`, and the parent `delegated` amount stays 0.

## A41 — An unknown agent reservation stays in the budget

- Clause: section 17, `OUTCOME_UNKNOWN` keeps the reservation.
- Preconditions: cap 100 and a reservation of 40, including an untrusted note.
- Inputs: `markUnknown`, `release`, then a new reservation of 70.
- Pass: release is `OUTCOME_UNKNOWN` and the new reservation is `OVERSPEND`.

## A42 — Chain id 1 refuses RWAIX_TEST and DCNFT-TEST

- Clause: section 26.1 synthetic units are not a live token. The reference contracts revert `MainnetForbidden` on chain id 1.
- Preconditions: Foundry and `contracts/lib` are available. If `forge` is absent, the item is `NOT_EVALUATED`.
- Inputs: `forge test --match-test test_mainnetMintIsRefused`.
- Pass: that test passes. A missing compiler is not recorded as a pass.

## A43 — Issuance shells mint nothing

- Clause: section 7.4 and section 22. Deployment does not start sale, vesting, or release.
- Preconditions: Foundry is available. If `forge` is absent, the item is `NOT_EVALUATED`.
- Inputs: `forge test --match-test test_deployOnMainnetMintsNothing`.
- Pass: the test passes, which asserts supply 0, `issuanceEnabled` false, and the minter and registrar roles not granted.

## A44 — Deploy.s.sol refuses a chain other than 31337 and 31338

- Clause: section 26 local prototype. The reference deploy script refuses chain id 1 before broadcast.
- Preconditions: `forge` and `anvil`. If either is absent, the item is `NOT_EVALUATED`.
- Inputs: Anvil on `127.0.0.1` with chain id 1, then `forge script script/Deploy.s.sol:Deploy --broadcast` using the public Anvil development key against that local process only.
- Pass: the script exits non-zero and the output contains `refusing non-local chain`.

## A45 — Eight scenarios allow in-scope evidence and deny out-of-scope evidence

- Clause: section 26.1. Each scenario compares signed terms with evidence.
- Preconditions: the eight profile ids in this process.
- Inputs: `runProfile` for nft, identity, content, data, supply, agent, compute, and device.
- Pass: every scenario decision is `ALLOW`, every out-of-scope decision is `DENY` with `DOMAIN_POLICY_SCOPE_MISMATCH`, every fee split names `USD_TEST` and `RWAIX_TEST`, and every recorded step is ok.

## A46 — NFT demo keeps 12000, zero network fee, copyright deny, and an open dispute

- Clause: section 26.1 NFT demonstration.
- Preconditions: the nft profile.
- Inputs: `runProfile("nft")`.
- Pass: service amount `12000` `USD_TEST`, network fee `0` `RWAIX_TEST`, copyright decision `DENY`, dispute `OPEN`, rights ledger empty, and disputes resolved by silence equal 0.

## A47 — Identity price and network fee are both zero

- Clause: section 26.1. The identity scenario ends after acceptance and does not require a token payment.
- Preconditions: the identity profile.
- Inputs: `runProfile("identity")`.
- Pass: both fee-split amounts are `0` and the decision is `ALLOW`.

## A48 — The cross scenario keeps three trades, a parent cap, and an open dispute

- Clause: section 19 and section 26. Separate trades, a parent budget, and silence that does not close a dispute.
- Preconditions: `runCrossScenario` in this process.
- Inputs: the cross-scenario result.
- Pass: three trades, parent cap `100`, children include `40` and `50`, rejected with `OVERSPEND`, dispute `OPEN`, and disputes resolved by silence equal 0.

## A49 — Current UI has no horizontal overflow at 320 and 736

- Clause: section 26.2 and 26.3, as a layout check of this build. This is not the archived browser record.
- Preconditions: Google Chrome or Chromium, and `puppeteer-core` from this workspace. The paper UI is started on a local port. The GitHub Actions job installs Chrome before the suite. If the browser tooling is absent, the item is `NOT_EVALUATED`.
- Inputs: the NFT scenario page in Chinese and English at viewport widths 320 and 736.
- Pass: `documentElement.scrollWidth - clientWidth` is 0 at each of those four measurements, and the disclosure heading is present.

## A50 — Comparative baselines, latency percentiles, and market adoption

- Clause: section 22. Baseline systems, pre-registered p50/p95/p99 results, and market-structure metrics.
- Preconditions: baseline implementations, a pre-registered performance study, and adoption measurements. None of those are in this environment.
- Inputs: none.
- Pass: not applicable. The item is `NOT_EVALUATED`. No latency percentile or adoption number is invented, and the item is not marked passed.
