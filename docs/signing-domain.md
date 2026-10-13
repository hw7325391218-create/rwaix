# Signing domain

Domain id: `rwaix.signing.v1`. Protocol version: `rwaix-0.1.0`. Default audience for the reference service: `rwaix:reference`. Default chain id: `31337`.

The service signs requests with JWS. EIP-712 is a second encoding of the same Action fields so a contract can recompute the digest. EIP-712 does not by itself stop replay. Nonce, deadline, and the idempotency key do.

## Canonical JSON

`canonicalStringify` is an RFC 8785 subset:

- Object keys are sorted by UTF-16 code unit.
- No insignificant whitespace.
- Numbers must be finite safe integers. Amounts are decimal strings.
- `undefined` is rejected. `null`, booleans, strings, arrays, and objects are encoded.

Digests are `sha256:` plus lowercase hex of SHA-256 over the canonical string (`digestPrefixed`).

## JWS requests

`signRequest` builds a `rwaix.signing.v1` envelope and signs it as a compact JWS:

- `alg` is `ES256` (P-256). `typ` is `JWS`.
- `kid` is `p256:` plus the compressed public key in lowercase hex.
- Header and payload are canonical JSON, then base64url.
- The signature is the raw P-256 compact signature (r || s), not a DER encoding.

Envelope fields: `schemaId`, `protocolVersion`, `domain`, `chainId`, `action`, `audience`, `nonce`, `deadline`, `payloadDigest`. `payloadDigest` is the digest of the request body.

Verification rejects a header that is not this domain (`SIGNING_DOMAIN_MISMATCH`) and a payload that does not match the envelope (`SIGNATURE_INVALID`).

Idempotency slot is signer, action, and idempotency key, bound to the canonical request digest. The same key with a different digest is `IDEMPOTENCY_CONFLICT`. The check happens before nonce and deadline, so a retry returns the stored success. A failed call does not store an idempotency record; the nonce is still consumed.

## EIP-712 Action

```
EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)
Action(string protocolVersion, string action, uint256 chainId, string audience, string nonce, uint256 deadline, bytes32 payloadDigest)
```

Domain name `RWAIX`, version `1`.

Pinned vector, matched by `packages/protocol` and `contracts/src/Eip712Action.sol`:

| Field | Value |
| --- | --- |
| chainId | 31337 |
| verifyingContract | `0x0000000000000000000000000000000000000001` |
| protocolVersion | `rwaix-0.1.0` |
| action | `executeIntent` |
| audience | `rwaix:reference` |
| nonce | `nonce-0001` |
| deadline | `1791763200` (2026-10-12T00:00:00Z) |
| payloadDigest | `0xabab…ab` (32 bytes) |
| digest | `0x4051484867bb06e748faac44ed73229ff2f6b1c6b736c21d619e0621ca2f8fe0` |

The EIP-712 Mail vector in `packages/protocol/test/protocol.test.ts` checks the generic encoder against the public Mail signature. It is not an RWAIX action.

## Time

Timestamps are UTC `YYYY-MM-DDTHH:mm:ssZ`.

- `effectiveAt` is declared by the event.
- `recordedAt` is the service clock. The reference clock is injectable (`ManualClock`). Tests do not call `Date.now()`.
- Policy evaluation takes `evaluationTime`, `startedAtMs`, and `nowMs` from the caller.
- A trade event digest includes `recordedAt`, so `prevEventDigest` must use the digest the service stored.

An event whose sequence is ahead of the stream head is `HELD_FOR_RECONCILE`. An event at the head with the wrong `prevEventDigest` is `STATE_CONFLICT` and is not applied.

## 签名域（摘要）

服务请求使用 JWS ES256，签的是规范化后的 `rwaix.signing.v1` 信封。EIP-712 的 Action 摘要与合约一致，用于链上复核；它本身不能防重放。防重放靠 nonce、deadline 和幂等键。`effectiveAt` 由事件声明，`recordedAt` 由服务时钟写入，二者不能合并。
