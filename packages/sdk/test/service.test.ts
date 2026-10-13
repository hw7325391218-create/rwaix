import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputeAdapter } from "@rwaix/adapter-compute";
import type { EvidenceGraph, StatusSnapshot, TrustContext, TrustPolicy } from "@rwaix/policy-engine";
import {
  ManualClock,
  digestPrefixed,
  keyFromSeed,
  schemaDigest,
  signJws,
  signRequest,
  type ActionName,
  type P256Key,
} from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";

const clock = new ManualClock("2026-10-11T00:00:00Z");
const verifier = keyFromSeed("verifier");
const customer = keyFromSeed("customer");
const provider = keyFromSeed("provider");
const issuer = keyFromSeed("issuer");
const executor = keyFromSeed("executor");
const treasury = keyFromSeed("treasury");
const admin = keyFromSeed("status-admin");
const stranger = keyFromSeed("stranger");
const adapter = new ComputeAdapter(issuer.publicRef);

const service = new ReferenceService({
  clock,
  verifier,
  grants: [
    { signer: executor.publicRef, role: "EXECUTOR" },
    { signer: treasury.publicRef, role: "TREASURY" },
    { signer: admin.publicRef, role: "STATUS_ADMIN" },
  ],
});

let nonce = 0;
function call(key: P256Key, action: ActionName, request: Record<string, unknown>) {
  nonce += 1;
  return signRequest(key, action, request, {
    nonce: `nonce-${nonce.toString().padStart(8, "0")}`,
    deadline: "2027-01-01T00:00:00Z",
  });
}

const meta = digestPrefixed({ name: "compute-service" });
const content = digestPrefixed({ version: 1 });
const content2 = digestPrefixed({ version: 2 });

function baseRequest(schemaId: string, idempotencyKey: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { schemaId, protocolVersion: "rwaix-0.1.0", idempotencyKey, ...extra };
}

test("a signer who holds neither token can register and read", () => {
  const access = service.accessPath(stranger.publicRef);
  assert.deepEqual(access, { allowed: true, holdsDcnft: false, holdsRwaix: false });
  const created = service.registerObject(call(stranger, "registerObject", baseRequest("rwaix.request.registerObject.v1", "idem-stranger", {
    objectId: "stranger-obj",
    objectType: "SUBJECT",
    controller: stranger.publicRef,
    lifecyclePolicy: "NON_TRANSFERABLE",
    metadataDigest: meta,
  })));
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.value.tokenBalanceChecked, false);
  const again = service.registerObject(call(stranger, "registerObject", baseRequest("rwaix.request.registerObject.v1", "idem-stranger", {
    objectId: "stranger-obj",
    objectType: "SUBJECT",
    controller: stranger.publicRef,
    lifecyclePolicy: "NON_TRANSFERABLE",
    metadataDigest: meta,
  })));
  assert.equal(again.ok, true);
  const conflict = service.registerObject(call(stranger, "registerObject", baseRequest("rwaix.request.registerObject.v1", "idem-stranger", {
    objectId: "other-obj",
    objectType: "SUBJECT",
    controller: stranger.publicRef,
    lifecyclePolicy: "NON_TRANSFERABLE",
    metadataDigest: meta,
  })));
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error, "IDEMPOTENCY_CONFLICT");
});

test("versions are immutable and terminal lifecycle does not revive", () => {
  assert.equal(service.registerObject(call(provider, "registerObject", baseRequest("rwaix.request.registerObject.v1", "idem-svc", {
    objectId: "svc-1",
    objectType: "SERVICE_COMMITMENT",
    controller: provider.publicRef,
    subjectRef: "subject-provider",
    lifecyclePolicy: "NON_TRANSFERABLE",
    metadataDigest: meta,
  }))).ok, true);
  const v1 = service.publishVersion(call(provider, "publishVersion", baseRequest("rwaix.request.publishVersion.v1", "idem-v1", {
    objectId: "svc-1",
    bindingVersion: "1",
    contentDigest: content,
    metadataDigest: meta,
    subjectBinding: "subject-provider",
  })));
  assert.equal(v1.ok, true);
  if (v1.ok) assert.equal(v1.value.lifecycleState, "ACTIVE");
  const v2 = service.publishVersion(call(provider, "publishVersion", baseRequest("rwaix.request.publishVersion.v1", "idem-v2", {
    objectId: "svc-1",
    bindingVersion: "2",
    contentDigest: content2,
    metadataDigest: digestPrefixed({ name: "compute-service", rev: 2 }),
  })));
  assert.equal(v2.ok, true);
  const old = service.resolveBinding(call(customer, "resolveBinding", baseRequest("rwaix.request.resolveBinding.v1", "idem-resolve-1", {
    objectId: "svc-1",
    bindingVersion: "1",
  })));
  assert.equal(old.ok, true);
  if (old.ok) assert.equal((old.value.version as { contentDigest: string }).contentDigest, content);
  const revoked = service.publishVersion(call(admin, "publishVersion", baseRequest("rwaix.request.publishVersion.v1", "idem-revoke", {
    objectId: "svc-1",
    bindingVersion: "3",
    contentDigest: digestPrefixed({ version: 3 }),
    metadataDigest: meta,
    lifecycleTransition: "REVOKED",
  })));
  assert.equal(revoked.ok, false);
  if (!revoked.ok) assert.equal(revoked.error, "UNAUTHORIZED");
});

function policy(): TrustPolicy {
  return adapter.buildPolicy();
}

function graph(challengeId: string): EvidenceGraph {
  const claims = { role: "provider" };
  const credentialBody = {
    schemaId: "rwaix.credential.v1",
    issuer: issuer.publicRef,
    subjectRef: "subject-provider",
    claimsDigest: digestPrefixed(claims),
    claims,
    schemaRef: "rwaix.claims.qualification.v1",
    validFrom: "2026-10-01T00:00:00Z",
    validUntil: "2027-10-01T00:00:00Z",
    statusRef: "status-subject-provider",
    proofSuite: "jws-p256",
  };
  return {
    schemaId: "rwaix.evidence.graph.v1",
    graphId: `graph-${challengeId}`,
    nodes: [
      {
        nodeId: "cred-1",
        nodeType: "CREDENTIAL",
        sourceId: "issuer-1",
        controllerId: issuer.publicRef,
        contentDigest: digestPrefixed(credentialBody),
        issuer: issuer.publicRef,
        capturedAt: "2026-10-11T00:00:00Z",
        payload: { quantity: "1", unit: "job" },
      },
      {
        nodeId: "obs-1",
        nodeType: "OBSERVATION",
        sourceId: "device-1",
        controllerId: provider.publicRef,
        contentDigest: digestPrefixed({ challengeId }),
        capturedAt: "2026-10-11T00:00:00Z",
        payload: adapter.mapEvidence({
          challengeId,
          outputFormat: "sha256",
          reservationId: "res-1",
          deviceId: "gpu-1",
          workloadDigest: digestPrefixed({ w: 1 }),
          outputDigest: digestPrefixed({ o: 1 }),
          quantity: "1",
          unit: "job",
        }),
      },
    ],
    edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs-1", to: "cred-1" }],
  };
}

function context(): TrustContext {
  return {
    schemaId: "rwaix.context.v1",
    protocolVersion: "rwaix-0.1.0",
    audience: "rwaix:compute-customer",
    purpose: "compute.delivery.verify",
    objectRef: { objectId: "svc-1", bindingVersion: "2" },
    requestedAction: "compute.deliver",
    domain: "compute",
    subjectRef: "subject-provider",
    challengeNonce: "challenge-nonce-1",
    deadline: "2026-10-12T00:00:00Z",
    policyVersion: "1.0.0",
  };
}

function snapshot(): StatusSnapshot {
  return {
    schemaId: "rwaix.status.snapshot.v1",
    snapshotId: "snap-1",
    asOf: "2026-10-11T00:00:00Z",
    entries: [{ subjectRef: "subject-provider", status: "ACTIVE" }],
  };
}

function evaluateBody(g: EvidenceGraph, idem: string) {
  return baseRequest("rwaix.request.evaluatePolicy.v1", idem, {
    context: context(),
    policy: policy(),
    graph: g,
    statusSnapshot: snapshot(),
    terms: { challengeId: "chal-1", outputFormat: "sha256" },
    evaluationTime: "2026-10-11T00:00:00Z",
    startedAtMs: 0,
    nowMs: 1,
  });
}

test("compute delivery allow, scope deny, and independent replay", () => {
  const allow = service.evaluatePolicy(call(customer, "evaluatePolicy", evaluateBody(graph("chal-1"), "idem-eval-allow")));
  assert.equal(allow.ok, true, allow.ok ? "" : allow.message);
  if (!allow.ok) return;
  assert.equal(allow.value.decision.decision, "ALLOW");
  assert.equal(allow.value.receipt.policyDigest, digestPrefixed(policy()));
  const replay = service.verifyReceipt(call(stranger, "verifyReceipt", baseRequest("rwaix.request.verifyReceipt.v1", "idem-verify-1", {
    receipt: allow.value.receipt,
    receiptProof: allow.value.proof,
    expectedPolicyDigest: allow.value.receipt.policyDigest,
    replay: evaluateBody(graph("chal-1"), "idem-eval-replay-body"),
  })));
  assert.equal(replay.ok, true, replay.ok ? "" : replay.message);
  if (replay.ok) assert.equal(replay.value.replayed, true);
  const mismatch = adapter.checkScope({ challengeId: "chal-1", outputFormat: "sha256" }, { challengeId: "other", outputFormat: "sha256" });
  assert.equal(mismatch.ok, false);
  const denied = service.evaluatePolicy(call(customer, "evaluatePolicy", evaluateBody(graph("other"), "idem-eval-deny")));
  assert.equal(denied.ok, true, denied.ok ? "" : denied.message);
  if (denied.ok) {
    assert.equal(denied.value.decision.decision, "DENY");
    assert.ok(denied.value.decision.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH"));
  }
});

test("missing evidence is indeterminate, not allow", () => {
  const empty = graph("chal-1");
  empty.nodes = [];
  empty.edges = [];
  empty.graphId = "graph-empty";
  const result = service.evaluatePolicy(call(customer, "evaluatePolicy", evaluateBody(empty, "idem-eval-empty")));
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (result.ok) {
    assert.equal(result.value.decision.decision, "INDETERMINATE");
    assert.notEqual(result.value.decision.decision, "ALLOW");
  }
});

function envelope(tradeId: string, obligations: Array<Record<string, unknown>>, terms: Record<string, string>) {
  const body = {
    schemaId: "rwaix.trade.envelope.v1" as const,
    protocolVersion: "rwaix-0.1.0" as const,
    profileId: "compute.delivery",
    profileVersion: "1.0.0",
    schemaDigest: schemaDigest("rwaix.trade.envelope.v1"),
    tradeId,
    termsDigest: digestPrefixed(terms),
    parties: [
      { partyId: customer.publicRef, role: "CUSTOMER", authorityRef: "auth-customer" },
      { partyId: provider.publicRef, role: "PROVIDER", authorityRef: "auth-provider" },
    ],
    objects: [{ objectId: "svc-1", quantity: "1", unit: "job" }],
    obligations,
    acceptanceRule: "CUSTOMER_SIGNATURE",
    timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" },
    paymentTerms: { trigger: "ACCEPTANCE" },
    applicableDocuments: [digestPrefixed({ doc: tradeId })],
    disputePath: "profile-dispute-v1",
    terms,
    extensions: { "compute.metering": { samples: "1" } },
  };
  return body;
}

test("trade ordering, partial acceptance, separate payment dimension, and silence", () => {
  const terms = { challengeId: "chal-1", outputFormat: "sha256" };
  const opened = service.trade(call(customer, "trade", baseRequest("rwaix.request.trade.v1", "idem-open", {
    op: "OPEN",
    envelope: envelope("trade-1", [
      { obligationId: "obl-svc", kind: "SERVICE", amount: "1000", assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" },
      { obligationId: "obl-fee", kind: "NETWORK_FEE", amount: "10", assetId: "RWAIX_TEST", decimals: 18, rounding: "EXACT_INTEGER" },
    ], terms),
  })));
  assert.equal(opened.ok, true, opened.ok ? "" : opened.message);
  const unknownExt = service.trade(call(customer, "trade", baseRequest("rwaix.request.trade.v1", "idem-bad-ext", {
    op: "OPEN",
    envelope: { ...envelope("trade-x", [], terms), tradeId: "trade-x", extensions: { "not.registered": {} }, termsDigest: digestPrefixed(terms) },
  })));
  assert.equal(unknownExt.ok, false);
  if (!unknownExt.ok) assert.equal(unknownExt.error, "EXTENSION_UNKNOWN");

  const commit = (who: P256Key, eventId: string, sequence: string, prev: string, idem: string) => service.trade(call(who, "trade", baseRequest("rwaix.request.trade.v1", idem, {
    op: "EVENT",
    event: {
      schemaId: "rwaix.trade.event.v1",
      eventId,
      tradeId: "trade-1",
      obligationApplicable: false,
      eventType: "COMMITTED",
      actor: who.publicRef,
      authorityRef: "auth",
      streamId: "stream-commit",
      sourceId: digestPrefixed(terms),
      prevEventDigest: prev,
      sequence,
      causalRefs: [],
      effectiveAt: "2026-10-10T00:00:00Z",
      evidenceRefs: [],
      signingDomain: "rwaix.signing.v1",
    },
  })));

  const first = commit(customer, "evt-c1", "1", "genesis", "idem-c1");
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  if (!first.ok) return;
  assert.notEqual(first.value.effectiveAt, first.value.recordedAt);
  const second = commit(provider, "evt-c2", "2", String(first.value.eventDigest), "idem-c2");
  assert.equal(second.ok, true, second.ok ? "" : second.message);
  if (second.ok) assert.equal(second.value.commitment, "COMMITTED");
  const duplicate = commit(provider, "evt-c2", "2", String(first.value.eventDigest), "idem-c2-again");
  assert.equal(duplicate.ok, true);

  const delivered = service.trade(call(provider, "trade", baseRequest("rwaix.request.trade.v1", "idem-del", {
    op: "EVENT",
    event: {
      schemaId: "rwaix.trade.event.v1",
      eventId: "evt-d1",
      tradeId: "trade-1",
      obligationApplicable: true,
      obligationId: "obl-svc",
      eventType: "DELIVERED",
      actor: provider.publicRef,
      authorityRef: "auth-provider",
      streamId: "stream-del",
      sourceId: "delivery-1",
      prevEventDigest: "genesis",
      sequence: "1",
      causalRefs: [],
      effectiveAt: "2026-10-11T00:00:00Z",
      evidenceRefs: [],
      quantity: "1",
      unit: "job",
      signingDomain: "rwaix.signing.v1",
    },
  })));
  assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.message);

  const later = {
    schemaId: "rwaix.trade.event.v1",
    eventId: "evt-pay-2",
    tradeId: "trade-1",
    obligationApplicable: true,
    obligationId: "obl-svc",
    eventType: "PAYMENT_SUBMITTED",
    actor: treasury.publicRef,
    authorityRef: "auth-treasury",
    streamId: "stream-pay",
    sourceId: "pay-src",
    prevEventDigest: "pending",
    sequence: "2",
    causalRefs: [],
    effectiveAt: "2026-10-11T00:00:00Z",
    evidenceRefs: [],
    signingDomain: "rwaix.signing.v1",
    dimension: "PAYMENT_EXECUTION",
  };
  const head = {
    ...later,
    eventId: "evt-pay-1",
    sequence: "1",
    prevEventDigest: "genesis",
    eventType: "PAYMENT_AUTHORIZED",
  };
  const headDigest = digestPrefixed({ ...head, recordedAt: clock.now() });
  const held = service.trade(call(treasury, "trade", baseRequest("rwaix.request.trade.v1", "idem-held", {
    op: "EVENT",
    event: { ...later, prevEventDigest: headDigest },
  })));
  assert.equal(held.ok, true, held.ok ? "" : held.message);
  if (held.ok) assert.equal(held.value.status, "HELD_FOR_RECONCILE");
  const applied = service.trade(call(treasury, "trade", baseRequest("rwaix.request.trade.v1", "idem-pay-1", { op: "EVENT", event: head })));
  assert.equal(applied.ok, true, applied.ok ? "" : applied.message);
  const view = service.tradeView("trade-1");
  assert.equal(view.fulfillment, "PARTIAL");
  assert.equal(view.commitment, "COMMITTED");

  const acceptance = {
    schemaId: "rwaix.acceptance.v1",
    acceptanceId: "acc-1",
    tradeId: "trade-1",
    obligationId: "obl-svc",
    portionId: "portion-1",
    objectVersion: "2",
    quantity: "1",
    unit: "job",
    acceptor: customer.publicRef,
    authorityRef: "auth-customer",
    acceptedAt: "2026-10-11T00:00:00Z",
  };
  const accepted = service.trade(call(customer, "trade", baseRequest("rwaix.request.trade.v1", "idem-acc", { op: "ACCEPT", acceptance })));
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.message);
  if (accepted.ok) assert.equal(accepted.value.acceptedQuantity, "1");
  const doubled = service.trade(call(customer, "trade", baseRequest("rwaix.request.trade.v1", "idem-acc-2", {
    op: "ACCEPT",
    acceptance: { ...acceptance, acceptanceId: "acc-2" },
  })));
  assert.equal(doubled.ok, false);
  if (!doubled.ok) assert.equal(doubled.error, "PORTION_DUPLICATE");
  assert.equal(service.tradeView("trade-1").accepted["obl-svc"], "1");

  const disputed = service.trade(call(customer, "trade", baseRequest("rwaix.request.trade.v1", "idem-dispute", {
    op: "DISPUTE",
    dispute: {
      schemaId: "rwaix.dispute.v1",
      disputeId: "disp-1",
      tradeId: "trade-1",
      obligationId: "obl-fee",
      claimant: customer.publicRef,
      affectedAmount: "10",
      assetId: "RWAIX_TEST",
      reason: "meter",
      evidenceDeadline: "2026-10-20T00:00:00Z",
      supplementRule: "written-supplement",
      dispositionAuthority: "named-panel",
      noticeRef: "notice-1",
      remedyPath: "profile-dispute-v1",
      status: "OPEN",
    },
  })));
  assert.equal(disputed.ok, true, disputed.ok ? "" : disputed.message);
  clock.set("2026-10-21T00:00:00Z");
  const sweep = service.trade(call(customer, "trade", baseRequest("rwaix.request.trade.v1", "idem-sweep", { op: "SWEEP" })));
  assert.equal(sweep.ok, true);
  if (sweep.ok) assert.equal(sweep.value.disputesResolvedBySilence, 0);
  assert.equal(service.tradeView("trade-1").dispute, "OPEN");
  clock.set("2026-10-11T00:00:00Z");
});

test("revocation after an ALLOW receipt blocks execution; unknown payment keeps coverage", () => {
  service.network.registerAsset({ assetId: "USD_TEST", chainId: "0", contractAddress: "0x0000000000000000000000000000000000000001", decimals: 2, kind: "FIAT_TEST" });
  service.network.registerAsset({ assetId: "RWAIX_TEST", chainId: "31337", contractAddress: "0x1111111111111111111111111111111111111111", decimals: 18, kind: "NETWORK_FEE" });
  assert.equal(service.setStatus(call(admin, "setStatus", baseRequest("rwaix.request.setStatus.v1", "idem-status", {
    subjectRef: "subject-provider",
    status: "ACTIVE",
  }))).ok, true);
  assert.equal(service.trade(call(treasury, "trade", baseRequest("rwaix.request.trade.v1", "idem-auth", {
    op: "AUTHORIZE",
    obligationId: "obl-svc",
  }))).ok, true);
  const allow = service.evaluatePolicy(call(customer, "evaluatePolicy", evaluateBody(graph("chal-1"), "idem-eval-exec")));
  assert.equal(allow.ok, true, allow.ok ? "" : allow.message);
  if (!allow.ok) return;
  assert.equal(service.setStatus(call(admin, "setStatus", baseRequest("rwaix.request.setStatus.v1", "idem-revoke-status", {
    subjectRef: "subject-provider",
    status: "REVOKED",
  }))).ok, true);
  const blocked = service.prepareIntent(call(executor, "prepareIntent", baseRequest("rwaix.request.prepareIntent.v1", "idem-prep-blocked", {
    intentId: "intent-blocked",
    receiptId: allow.value.receipt.receiptId,
    action: "pay",
    payer: customer.publicRef,
    payee: provider.publicRef,
    assetId: "USD_TEST",
    amount: "1000",
    obligationId: "obl-svc",
    intentNonce: "intent-nonce-1",
    intentDeadline: "2026-10-12T00:00:00Z",
    maxStalenessSeconds: "3600",
  })));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error, "REVOKED");
  assert.equal(service.setStatus(call(admin, "setStatus", baseRequest("rwaix.request.setStatus.v1", "idem-reactivate", {
    subjectRef: "subject-provider",
    status: "ACTIVE",
  }))).ok, false);

  const fresh = service.registerObject(call(provider, "registerObject", baseRequest("rwaix.request.registerObject.v1", "idem-svc-2", {
    objectId: "svc-2",
    objectType: "SERVICE_COMMITMENT",
    controller: provider.publicRef,
    subjectRef: "subject-2",
    lifecyclePolicy: "NON_TRANSFERABLE",
    metadataDigest: meta,
  })));
  assert.equal(fresh.ok, true, fresh.ok ? "" : fresh.message);
  assert.equal(service.publishVersion(call(provider, "publishVersion", baseRequest("rwaix.request.publishVersion.v1", "idem-svc2-v1", {
    objectId: "svc-2",
    bindingVersion: "1",
    contentDigest: content,
    metadataDigest: meta,
  }))).ok, true);
  assert.equal(service.setStatus(call(admin, "setStatus", baseRequest("rwaix.request.setStatus.v1", "idem-status-2", {
    subjectRef: "subject-2",
    status: "ACTIVE",
  }))).ok, true);
  const terms = { challengeId: "chal-1", outputFormat: "sha256" };
  assert.equal(service.trade(call(customer, "trade", baseRequest("rwaix.request.trade.v1", "idem-open-2", {
    op: "OPEN",
    envelope: {
      ...envelope("trade-2", [
        { obligationId: "obl-2", kind: "SERVICE", amount: "100", assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" },
      ], terms),
    },
  }))).ok, true);
  assert.equal(service.trade(call(treasury, "trade", baseRequest("rwaix.request.trade.v1", "idem-auth-2", { op: "AUTHORIZE", obligationId: "obl-2" }))).ok, true);
  const ctx = context();
  ctx.objectRef = { objectId: "svc-2", bindingVersion: "1" };
  ctx.subjectRef = "subject-2";
  const evalReq = evaluateBody(graph("chal-1"), "idem-eval-2");
  evalReq.context = ctx;
  evalReq.statusSnapshot = {
    schemaId: "rwaix.status.snapshot.v1",
    snapshotId: "snap-2",
    asOf: "2026-10-11T00:00:00Z",
    entries: [{ subjectRef: "subject-2", status: "ACTIVE" }],
  };
  const issued = service.evaluatePolicy(call(customer, "evaluatePolicy", evalReq));
  assert.equal(issued.ok, true, issued.ok ? "" : issued.message);
  if (!issued.ok) return;
  const prepared = service.prepareIntent(call(executor, "prepareIntent", baseRequest("rwaix.request.prepareIntent.v1", "idem-prep-2", {
    intentId: "intent-2",
    receiptId: issued.value.receipt.receiptId,
    action: "pay",
    payer: customer.publicRef,
    payee: provider.publicRef,
    assetId: "USD_TEST",
    amount: "40",
    obligationId: "obl-2",
    intentNonce: "intent-nonce-2",
    intentDeadline: "2026-10-12T00:00:00Z",
    maxStalenessSeconds: "3600",
  })));
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.message);
  const early = service.executeIntent(call(executor, "executeIntent", baseRequest("rwaix.request.executeIntent.v1", "idem-exec-early", {
    intentId: "intent-2",
    mode: "CONFIRM",
    inclusion: "INCLUDED",
  })));
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.error, "FINALITY_NOT_REACHED");
  const unknown = service.executeIntent(call(executor, "executeIntent", baseRequest("rwaix.request.executeIntent.v1", "idem-exec-unknown", {
    intentId: "intent-2",
    mode: "TIMEOUT",
    inclusion: "FINAL",
  })));
  assert.equal(unknown.ok, true, unknown.ok ? "" : unknown.message);
  if (unknown.ok) assert.equal(unknown.value.state, "OUTCOME_UNKNOWN");
  assert.equal(service.network.coverage("obl-2"), 40n);
  const second = service.prepareIntent(call(executor, "prepareIntent", baseRequest("rwaix.request.prepareIntent.v1", "idem-prep-3", {
    intentId: "intent-3",
    receiptId: issued.value.receipt.receiptId,
    action: "pay",
    payer: customer.publicRef,
    payee: provider.publicRef,
    assetId: "RWAIX_TEST",
    amount: "1",
    obligationId: "obl-2",
    intentNonce: "intent-nonce-3",
    intentDeadline: "2026-10-12T00:00:00Z",
    maxStalenessSeconds: "3600",
  })));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error, "OUTCOME_UNKNOWN");
  const release = service.executeIntent(call(executor, "executeIntent", baseRequest("rwaix.request.executeIntent.v1", "idem-exec-fail", {
    intentId: "intent-2",
    mode: "FAIL_CONFIRMED",
    inclusion: "FINAL",
  })));
  assert.equal(release.ok, false);
  if (!release.ok) assert.equal(release.error, "OUTCOME_UNKNOWN");
  assert.equal(service.network.coverage("obl-2"), 40n);
});

test("credential proof is checked when present", () => {
  const claims = { level: "basic" };
  const body = {
    schemaId: "rwaix.credential.v1",
    issuer: issuer.publicRef,
    subjectRef: "subject-provider",
    claimsDigest: digestPrefixed(claims),
    claims,
    schemaRef: "qual",
    validFrom: "2026-10-01T00:00:00Z",
    validUntil: "2027-10-01T00:00:00Z",
    statusRef: "status-subject-provider",
    proofSuite: "jws-p256",
  };
  const proof = signJws(issuer, body);
  const stored = service.submitEvidence(call(issuer, "submitEvidence", baseRequest("rwaix.request.submitEvidence.v1", "idem-ev", {
    evidenceId: "ev-1",
    graph: graph("chal-1"),
    credential: { ...body, proof },
  })));
  assert.equal(stored.ok, true, stored.ok ? "" : stored.message);
});
