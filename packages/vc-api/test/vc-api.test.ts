import assert from "node:assert/strict";
import { test } from "node:test";
import { issueWithSuite, startVcApi, verifyCredentialDocument } from "../src/index.js";

const unsigned = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  type: ["VerifiableCredential"],
  credentialSubject: { id: "did:example:subject" },
};

test("eddsa and ecdsa did:key issuers round-trip a VC DM 2 credential", async () => {
  const eddsa = await issueWithSuite("eddsa-rdfc-2022", unsigned);
  const proof = eddsa.proof as { type: string; cryptosuite: string; proofValue: string; verificationMethod: string };
  assert.equal(proof.type, "DataIntegrityProof");
  assert.equal(proof.cryptosuite, "eddsa-rdfc-2022");
  assert.equal(proof.proofValue.startsWith("z"), true);
  assert.match(proof.verificationMethod, /^did:key:z6Mk.+#z6Mk/);
  await verifyCredentialDocument(eddsa);

  const ecdsa = await issueWithSuite("ecdsa-rdfc-2019", structuredClone(unsigned));
  const ecdsaProof = ecdsa.proof as { cryptosuite: string; verificationMethod: string; proofValue: string };
  assert.equal(ecdsaProof.cryptosuite, "ecdsa-rdfc-2019");
  assert.equal(ecdsaProof.proofValue.startsWith("z"), true);
  assert.match(ecdsaProof.verificationMethod, /^did:key:zDna.+#zDna/);
  await verifyCredentialDocument(ecdsa);
});

test("the issuer rejects an empty credential subject", async () => {
  await assert.rejects(() => issueWithSuite("eddsa-rdfc-2022", {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential"],
    credentialSubject: {},
  }));
});

test("POST /vc-api/credentials/issue and /credentials/verify", async () => {
  const started = await startVcApi({ host: "127.0.0.1", port: 0 });
  const base = `http://${started.host}:${started.port}`;
  try {
    const issued = await fetch(`${base}/vc-api/credentials/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: unsigned }),
    });
    assert.equal(issued.status, 200);
    const body = await issued.json() as { verifiableCredential: unknown };
    const verified = await fetch(`${base}/credentials/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifiableCredential: body.verifiableCredential, options: { checks: ["proof"] } }),
    });
    assert.equal(verified.status, 200);
    const tampered = structuredClone(body.verifiableCredential) as { credentialSubject: { id: string } };
    tampered.credentialSubject.id = "did:example:other";
    const rejected = await fetch(`${base}/vc-api/credentials/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifiableCredential: tampered }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    started.server.close();
  }
});
