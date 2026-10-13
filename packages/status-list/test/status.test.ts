import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolError, keyFromSeed } from "@rwaix/protocol";
import { decodeBitstring, emptyBitstring, encodeBitstring, getBit, issueStatusList, setBit, verifyStatusList, writeStatus } from "../src/index.js";

const SPEC_EXAMPLE = "uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA";

test("spec example is a 16KB zero bitstring and index 0 is the left-most bit", () => {
  const bytes = decodeBitstring(SPEC_EXAMPLE);
  assert.equal(bytes.length, 16384);
  assert.equal(getBit(bytes, 0), 0);
  assert.equal(getBit(bytes, 94567), 0);
  const local = emptyBitstring();
  setBit(local, 0, true);
  assert.equal(local[0], 0b10000000);
  setBit(local, 9, true);
  assert.equal(getBit(local, 9), 1);
});

test("revocation is irreversible and suspension can clear", () => {
  const key = keyFromSeed("status-issuer");
  let encoded = encodeBitstring(emptyBitstring());
  encoded = writeStatus(encoded, 7, "revocation", true);
  assert.throws(() => writeStatus(encoded, 7, "revocation", false), (error: unknown) => error instanceof ProtocolError && error.code === "LIFECYCLE_TERMINAL");
  let suspended = encodeBitstring(emptyBitstring());
  suspended = writeStatus(suspended, 7, "suspension", true);
  suspended = writeStatus(suspended, 7, "suspension", false);
  const issued = issueStatusList(key, {
    id: "https://rwaix.example/status/1",
    statusPurpose: "revocation",
    encodedList: encoded,
    validFrom: "2026-10-01T00:00:00Z",
    validUntil: "2026-12-01T00:00:00Z",
  });
  const checked = verifyStatusList({
    credential: issued.credential,
    proof: issued.proof,
    index: 7,
    purpose: "revocation",
    atTime: "2026-10-11T00:00:00Z",
    trustedIssuers: [key.publicRef],
  });
  assert.equal(checked.status, "REVOKED");
  assert.throws(() => verifyStatusList({ ...{
    credential: issued.credential, proof: issued.proof, index: 7, purpose: "suspension", atTime: "2026-10-11T00:00:00Z", trustedIssuers: [key.publicRef],
  } }), (error: unknown) => error instanceof ProtocolError);
});
