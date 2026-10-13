import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock, ProtocolError, keyFromSeed } from "@rwaix/protocol";
import { AccountRecovery, didDocument, didKeyFromSigner, didWeb, issueCredential, localResolver, publicKeyFromDidKey, verifyCredential } from "../src/index.js";

test("did:key round-trips and did:web document publishes the same key", () => {
  const key = keyFromSeed("did-subject");
  const did = didKeyFromSigner(key);
  assert.deepEqual(publicKeyFromDidKey(did), key.publicKey);
  const web = didWeb("127.0.0.1:8787");
  assert.equal(web, "did:web:127.0.0.1%3A8787");
  assert.equal(didWeb("example.com"), "did:web:example.com");
  assert.equal(didWeb("example.com:app"), "did:web:example.com:app");
  assert.equal(didWeb("example.com:3000:app"), "did:web:example.com%3A3000:app");
  const document = didDocument(web, key.publicKey);
  assert.equal(document.assertionMethod[0], `${web}#key-1`);
});

test("VC verification binds the issuer DID to the JWS key", () => {
  const key = keyFromSeed("vc-issuer");
  const did = didKeyFromSigner(key);
  const jws = issueCredential(key, did, {
    schemaId: "rwaix.vc.v1",
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "QualificationCredential"],
    issuer: did,
    validFrom: "2026-10-01T00:00:00Z",
    validUntil: "2026-12-01T00:00:00Z",
    credentialSubject: { id: "did:key:zsubject", claims: { qualificationId: "qual-architect" } },
    credentialStatus: { type: "BitstringStatusListEntry", statusPurpose: "revocation", statusListIndex: "7", statusListCredential: "https://rwaix.example/status/1" },
  });
  const verified = verifyCredential(jws, localResolver());
  assert.equal(verified.signer, key.publicRef);
  assert.equal(verified.credential.credentialSubject.claims.qualificationId, "qual-architect");
});

test("recovery rotates the controller after delay and does not restore credentials or move assets", () => {
  const clock = new ManualClock("2026-10-11T00:00:00Z");
  const recovery = new AccountRecovery(clock);
  recovery.register({ accountId: "acct-1", controller: "controller-old", guardians: ["g1", "g2", "g3"], threshold: 2, delaySeconds: 86400 });
  recovery.revokeCredential("cred-1");
  const balances = { dcnft: 1n, rwaix: 5n };
  const request = recovery.propose("rec-1", "acct-1", "controller-new", "g1");
  assert.equal(request.notices.length, 1);
  assert.throws(() => recovery.execute("rec-1"), (error: unknown) => error instanceof ProtocolError);
  recovery.approve("rec-1", "g2");
  assert.throws(() => recovery.execute("rec-1"), (error: unknown) => error instanceof ProtocolError && error.code === "STATE_CONFLICT");
  clock.set("2026-10-12T00:00:00Z");
  const executed = recovery.execute("rec-1");
  assert.equal(executed.controller, "controller-new");
  assert.equal(executed.previousController, "controller-old");
  assert.equal(executed.controllerVersion, 2);
  assert.equal(executed.assetsMoved, false);
  assert.equal(executed.credentialsRestored, false);
  assert.equal(recovery.isRevoked("cred-1"), true);
  assert.equal(balances.dcnft, 1n);
  const frozen = new AccountRecovery(new ManualClock("2026-10-11T00:00:00Z"));
  frozen.register({ accountId: "acct-2", controller: "controller", guardians: ["g1", "g2"], threshold: 1, delaySeconds: 0 });
  frozen.propose("rec-2", "acct-2", "attacker", "g1");
  frozen.freeze("rec-2", "controller");
  assert.throws(() => frozen.execute("rec-2"), (error: unknown) => error instanceof ProtocolError && error.message.includes("frozen"));
  frozen.removeGuardian("acct-2", "g1", "controller");
  assert.equal(frozen.view("acct-2").guardians.includes("g1"), false);
});
