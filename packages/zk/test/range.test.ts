import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputeAdapter } from "@rwaix/adapter-compute";
import { ProtocolError, digestPrefixed, keyFromSeed, signRequest } from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";
import { proveRange, shutdownProver, submitEvidenceWithProof, verifyRange, verifyReceiptWithProof } from "../src/index.js";

test("range proof verifies and is required again at verifyReceipt", async () => {
  const proof = await proveRange(21n, 18n, 65n);
  assert.equal(await verifyRange(proof), true);
  const moved = { ...proof, min: "1" };
  assert.equal(await verifyRange(moved), false);
  await assert.rejects(() => proveRange(10n, 18n, 65n), (error: unknown) => error instanceof ProtocolError);
  const verifier = keyFromSeed("zk-verifier");
  const owner = keyFromSeed("zk-owner");
  const service = new ReferenceService({ verifier, clock: { now: () => "2026-10-11T00:00:00Z" } });
  const graph = {
    schemaId: "rwaix.evidence.graph.v1",
    graphId: "zk-graph",
    nodes: [{ nodeId: "cred", nodeType: "CREDENTIAL", sourceId: "issuer", controllerId: owner.publicRef, contentDigest: digestPrefixed({ zk: true }), issuer: owner.publicRef }],
    edges: [],
  };
  const request = {
    schemaId: "rwaix.request.submitEvidence.v1",
    protocolVersion: "rwaix-0.1.0",
    idempotencyKey: "zk-evidence",
    evidenceId: "zk-1",
    graph,
    zkProof: proof,
  };
  const signed = signRequest(owner, "submitEvidence", request, { nonce: "zk-nonce-0001", deadline: "2027-01-01T00:00:00Z" });
  const rejected = service.submitEvidence(signed);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, "SIGNATURE_INVALID");
  const resigned = signRequest(owner, "submitEvidence", request, { nonce: "zk-nonce-0002", deadline: "2027-01-01T00:00:00Z" });
  const accepted = await submitEvidenceWithProof(service, resigned, proof);
  assert.equal(accepted.ok, true, accepted.ok ? "" : `${accepted.error} ${accepted.message}`);

  const adapter = new ComputeAdapter(owner.publicRef);
  const meta = digestPrefixed({ zk: "object" });
  const registered = service.registerObject(signRequest(owner, "registerObject", {
    schemaId: "rwaix.request.registerObject.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "zk-reg",
    objectId: "zk-obj", objectType: "SERVICE_COMMITMENT", controller: owner.publicRef, lifecyclePolicy: "NON_TRANSFERABLE", metadataDigest: meta,
  }, { nonce: "zk-nonce-0003", deadline: "2027-01-01T00:00:00Z" }));
  assert.equal(registered.ok, true, registered.ok ? "" : registered.error);
  const published = service.publishVersion(signRequest(owner, "publishVersion", {
    schemaId: "rwaix.request.publishVersion.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "zk-ver",
    objectId: "zk-obj", bindingVersion: "1", contentDigest: meta, metadataDigest: meta,
  }, { nonce: "zk-nonce-0004", deadline: "2027-01-01T00:00:00Z" }));
  assert.equal(published.ok, true, published.ok ? "" : published.error);
  const terms = { challengeId: "chal-zk", outputFormat: "sha256" };
  const evidence = {
    schemaId: "rwaix.evidence.graph.v1",
    graphId: "zk-allow",
    nodes: [
      { nodeId: "cred", nodeType: "CREDENTIAL", sourceId: "issuer", controllerId: owner.publicRef, contentDigest: meta, issuer: owner.publicRef, capturedAt: "2026-10-11T00:00:00Z" },
      { nodeId: "obs", nodeType: "OBSERVATION", sourceId: "src", controllerId: owner.publicRef, contentDigest: meta, capturedAt: "2026-10-11T00:00:00Z", payload: adapter.mapEvidence({ ...terms, reservationId: "res", deviceId: "gpu", workloadDigest: meta, outputDigest: meta, quantity: "1", unit: "job" }) },
    ],
    edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
  };
  const issued = service.evaluatePolicy(signRequest(owner, "evaluatePolicy", {
    schemaId: "rwaix.request.evaluatePolicy.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "zk-eval",
    context: {
      schemaId: "rwaix.context.v1", protocolVersion: "rwaix-0.1.0", audience: "rwaix:compute-customer", purpose: "compute.delivery.verify",
      objectRef: { objectId: "zk-obj", bindingVersion: "1" }, requestedAction: "compute.deliver", domain: "compute",
      subjectRef: "zk-subject", challengeNonce: "zk-challenge-01", deadline: "2026-12-01T00:00:00Z", policyVersion: "1.0.0",
    },
    policy: adapter.buildPolicy(),
    graph: evidence,
    statusSnapshot: { schemaId: "rwaix.status.snapshot.v1", snapshotId: "zk-snap", asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: "zk-subject", status: "ACTIVE" }] },
    terms, evaluationTime: "2026-10-11T00:00:00Z", startedAtMs: 0, nowMs: 1,
  }, { nonce: "zk-nonce-0005", deadline: "2027-01-01T00:00:00Z" }));
  assert.equal(issued.ok, true, issued.ok ? "" : issued.error);
  if (!issued.ok) return;
  const verifyBody = {
    schemaId: "rwaix.request.verifyReceipt.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "zk-verify",
    receipt: issued.value.receipt, receiptProof: issued.value.proof, zkProof: proof,
  };
  const gate = new ReferenceService({ verifier, clock: { now: () => "2026-10-11T00:00:00Z" } });
  const blocked = gate.verifyReceipt(signRequest(owner, "verifyReceipt", verifyBody, { nonce: "zk-nonce-0006", deadline: "2027-01-01T00:00:00Z" }));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error, "SIGNATURE_INVALID");
  const checked = await verifyReceiptWithProof(
    gate,
    signRequest(owner, "verifyReceipt", verifyBody, { nonce: "zk-nonce-0007", deadline: "2027-01-01T00:00:00Z" }),
    proof,
  );
  assert.equal(checked.ok, true, checked.ok ? "" : `${checked.error} ${checked.message}`);
  await shutdownProver();
});

test("verifyReceiptWithProof is exported", () => {
  assert.equal(typeof verifyReceiptWithProof, "function");
});
