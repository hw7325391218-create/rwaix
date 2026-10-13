import assert from "node:assert/strict";
import { test } from "node:test";
import { hexToBytes } from "@noble/hashes/utils";
import {
  canonicalStringify,
  digestPrefixed,
  keyFromSeed,
  schemaDigest,
  signJws,
  signRequest,
  signTypedData,
  validateBySchemaId,
  verifyJws,
  ProtocolError,
} from "@rwaix/protocol";

test("canonical JSON sorts keys and rejects unsafe numbers", () => {
  assert.equal(canonicalStringify({ b: 1, a: "x" }), '{"a":"x","b":1}');
  assert.equal(digestPrefixed({ b: 1, a: "x" }), digestPrefixed({ a: "x", b: 1 }));
  assert.throws(() => canonicalStringify({ n: 1.5 }), (error: unknown) => error instanceof ProtocolError && error.code === "SCHEMA_INVALID");
  assert.throws(() => canonicalStringify({ n: -0 }), (error: unknown) => error instanceof ProtocolError);
});

test("EIP-712 matches the EIP-712 Mail signature vector", () => {
  const signature = signTypedData(
    hexToBytes("c85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4"),
    {
      name: "Ether Mail",
      version: "1",
      chainId: 1,
      verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
    },
    "Mail",
    {
      Person: [
        { name: "name", type: "string" },
        { name: "wallet", type: "address" },
      ],
      Mail: [
        { name: "from", type: "Person" },
        { name: "to", type: "Person" },
        { name: "contents", type: "string" },
      ],
    },
    {
      from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
      to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
      contents: "Hello, Bob!",
    },
  );
  assert.equal(
    signature,
    "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c",
  );
});

test("JWS round-trip and schema unknown fields", () => {
  const key = keyFromSeed("signer");
  const payload = { schemaId: "rwaix.signing.v1", n: "1" };
  const jws = signJws(key, payload);
  assert.equal(verifyJws(jws, payload), key.publicRef);
  assert.throws(() => verifyJws(jws, { schemaId: "rwaix.signing.v1", n: "2" }), (error: unknown) => error instanceof ProtocolError && error.code === "SIGNATURE_INVALID");
  assert.throws(
    () =>
      validateBySchemaId("rwaix.request.registerObject.v1", {
        schemaId: "rwaix.request.registerObject.v1",
        protocolVersion: "rwaix-0.1.0",
        idempotencyKey: "idem-1",
        objectId: "obj-1",
        objectType: "SUBJECT",
        controller: key.publicRef,
        lifecyclePolicy: "NON_TRANSFERABLE",
        metadataDigest: digestPrefixed({}),
        unexpected: true,
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === "UNKNOWN_FIELD",
  );
  assert.match(schemaDigest("rwaix.trade.envelope.v1"), /^sha256:[a-f0-9]{64}$/);
  const signed = signRequest(key, "resolveBinding", {
    schemaId: "rwaix.request.resolveBinding.v1",
    protocolVersion: "rwaix-0.1.0",
    idempotencyKey: "idem-r1",
    objectId: "obj-1",
  }, { nonce: "nonce-0001", deadline: "2026-10-12T00:00:00Z" });
  validateBySchemaId("rwaix.signed.v1", signed);
});
