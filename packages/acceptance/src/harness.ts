import { ComputeAdapter } from "@rwaix/adapter-compute";
import type { EvidenceGraph, TrustPolicy } from "@rwaix/policy-engine";
import {
  ManualClock,
  digestPrefixed,
  keyFromSeed,
  schemaDigest,
  signRequest,
  type ActionName,
  type P256Key,
  type SignedRequest,
} from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";

export interface World {
  clock: ManualClock;
  service: ReferenceService;
  customer: P256Key;
  provider: P256Key;
  issuer: P256Key;
  executor: P256Key;
  treasury: P256Key;
  admin: P256Key;
  stranger: P256Key;
  adapter: ComputeAdapter;
  call: (
    key: P256Key,
    action: ActionName,
    request: Record<string, unknown>,
    meta?: { nonce?: string; deadline?: string; audience?: string },
  ) => SignedRequest;
  req: (schemaId: string, idempotencyKey: string, extra: Record<string, unknown>) => Record<string, unknown>;
}

export function world(seed = "acceptance"): World {
  const clock = new ManualClock("2026-10-11T00:00:00Z");
  const verifier = keyFromSeed(`${seed}-verifier`);
  const customer = keyFromSeed(`${seed}-customer`);
  const provider = keyFromSeed(`${seed}-provider`);
  const issuer = keyFromSeed(`${seed}-issuer`);
  const executor = keyFromSeed(`${seed}-executor`);
  const treasury = keyFromSeed(`${seed}-treasury`);
  const admin = keyFromSeed(`${seed}-admin`);
  const stranger = keyFromSeed(`${seed}-stranger`);
  const service = new ReferenceService({
    clock,
    verifier,
    grants: [
      { signer: executor.publicRef, role: "EXECUTOR" },
      { signer: treasury.publicRef, role: "TREASURY" },
      { signer: admin.publicRef, role: "STATUS_ADMIN" },
      { signer: admin.publicRef, role: "REGISTRAR" },
    ],
  });
  let n = 0;
  const call: World["call"] = (key, action, request, meta) => {
    n += 1;
    return signRequest(key, action, request, {
      nonce: meta?.nonce ?? `acc-${n.toString().padStart(8, "0")}`,
      deadline: meta?.deadline ?? "2027-01-01T00:00:00Z",
      ...(meta?.audience ? { audience: meta.audience } : {}),
    });
  };
  const req: World["req"] = (schemaId, idempotencyKey, extra) => ({
    schemaId,
    protocolVersion: "rwaix-0.1.0",
    idempotencyKey,
    ...extra,
  });
  return {
    clock,
    service,
    customer,
    provider,
    issuer,
    executor,
    treasury,
    admin,
    stranger,
    adapter: new ComputeAdapter(issuer.publicRef),
    call,
    req,
  };
}

export function objectRequest(w: World, objectId: string, controller: string, idem: string): Record<string, unknown> {
  return w.req("rwaix.request.registerObject.v1", idem, {
    objectId,
    objectType: "SERVICE_COMMITMENT",
    controller,
    subjectRef: "subject-provider",
    lifecyclePolicy: "NON_TRANSFERABLE",
    metadataDigest: digestPrefixed({ objectId }),
  });
}

export function computeGraph(w: World, challengeId: string): EvidenceGraph {
  const claims = { role: "provider" };
  const credentialBody = {
    schemaId: "rwaix.credential.v1",
    issuer: w.issuer.publicRef,
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
        controllerId: w.issuer.publicRef,
        contentDigest: digestPrefixed(credentialBody),
        issuer: w.issuer.publicRef,
        capturedAt: "2026-10-11T00:00:00Z",
        payload: { quantity: "1", unit: "job" },
      },
      {
        nodeId: "obs-1",
        nodeType: "OBSERVATION",
        sourceId: "device-1",
        controllerId: w.provider.publicRef,
        contentDigest: digestPrefixed({ challengeId }),
        capturedAt: "2026-10-11T00:00:00Z",
        payload: w.adapter.mapEvidence({
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

export function evaluateRequest(w: World, graph: EvidenceGraph, idem: string, challengeId = "chal-1"): Record<string, unknown> {
  return w.req("rwaix.request.evaluatePolicy.v1", idem, {
    context: {
      schemaId: "rwaix.context.v1",
      protocolVersion: "rwaix-0.1.0",
      audience: "rwaix:compute-customer",
      purpose: "compute.delivery.verify",
      objectRef: { objectId: "svc-1", bindingVersion: "1" },
      requestedAction: "compute.deliver",
      domain: "compute",
      subjectRef: "subject-provider",
      challengeNonce: "challenge-nonce-1",
      deadline: "2026-10-12T00:00:00Z",
      policyVersion: "1.0.0",
    },
    policy: w.adapter.buildPolicy(),
    graph,
    statusSnapshot: {
      schemaId: "rwaix.status.snapshot.v1",
      snapshotId: "snap-1",
      asOf: "2026-10-11T00:00:00Z",
      entries: [{ subjectRef: "subject-provider", status: "ACTIVE" }],
    },
    terms: { challengeId, outputFormat: "sha256" },
    evaluationTime: "2026-10-11T00:00:00Z",
    startedAtMs: 0,
    nowMs: 1,
  });
}

/** Object, active subject, priced obligation, and an ALLOW receipt. */
export function readyAllow(seed: string): { w: World; receiptId: string } {
  const w = world(seed);
  const created = w.service.registerObject(w.call(w.provider, "registerObject", objectRequest(w, "svc-1", w.provider.publicRef, "idem-reg")));
  if (!created.ok) throw new Error(`register ${created.error}`);
  const published = w.service.publishVersion(w.call(w.provider, "publishVersion", w.req("rwaix.request.publishVersion.v1", "idem-ver", {
    objectId: "svc-1",
    bindingVersion: "1",
    contentDigest: digestPrefixed({ version: 1 }),
    metadataDigest: digestPrefixed({ objectId: "svc-1" }),
    subjectBinding: "subject-provider",
  })));
  if (!published.ok) throw new Error(`publish ${published.error}`);
  const status = w.service.setStatus(w.call(w.admin, "setStatus", w.req("rwaix.request.setStatus.v1", "idem-status", {
    subjectRef: "subject-provider",
    status: "ACTIVE",
  })));
  if (!status.ok) throw new Error(`status ${status.error}`);
  const terms = { challengeId: "chal-1", outputFormat: "sha256" };
  const opened = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-open", {
    op: "OPEN",
    envelope: {
      schemaId: "rwaix.trade.envelope.v1",
      protocolVersion: "rwaix-0.1.0",
      profileId: "compute.delivery",
      profileVersion: "1.0.0",
      schemaDigest: schemaDigest("rwaix.trade.envelope.v1"),
      tradeId: "trade-1",
      termsDigest: digestPrefixed(terms),
      parties: [
        { partyId: w.customer.publicRef, role: "CUSTOMER", authorityRef: "auth-customer" },
        { partyId: w.provider.publicRef, role: "PROVIDER", authorityRef: "auth-provider" },
      ],
      objects: [{ objectId: "svc-1", quantity: "1", unit: "job" }],
      obligations: [
        { obligationId: "obl-svc", kind: "SERVICE", amount: "100", assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" },
      ],
      acceptanceRule: "CUSTOMER_SIGNATURE",
      timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" },
      paymentTerms: { trigger: "ACCEPTANCE" },
      applicableDocuments: [digestPrefixed({ doc: "trade-1" })],
      disputePath: "profile-dispute-v1",
      terms,
      extensions: { "compute.metering": { samples: "1" } },
    },
  })));
  if (!opened.ok) throw new Error(`open ${opened.error} ${opened.message}`);
  const authorized = w.service.trade(w.call(w.treasury, "trade", w.req("rwaix.request.trade.v1", "idem-auth", {
    op: "AUTHORIZE",
    obligationId: "obl-svc",
  })));
  if (!authorized.ok) throw new Error(`authorize ${authorized.error}`);
  w.service.network.registerAsset({
    assetId: "USD_TEST",
    chainId: "0",
    contractAddress: "0x0000000000000000000000000000000000000001",
    decimals: 2,
    kind: "FIAT_TEST",
  });
  const issued = w.service.evaluatePolicy(w.call(w.customer, "evaluatePolicy", evaluateRequest(w, computeGraph(w, "chal-1"), "idem-eval")));
  if (!issued.ok) throw new Error(`evaluate ${issued.error} ${issued.message}`);
  if (issued.value.decision.decision !== "ALLOW") throw new Error(`expected ALLOW, got ${issued.value.decision.decision}`);
  return { w, receiptId: issued.value.receipt.receiptId };
}

export function simplePolicy(over: Partial<TrustPolicy> = {}): TrustPolicy {
  return {
    schemaId: "rwaix.policy.v1",
    policyId: "acceptance",
    version: "1.0.0",
    unknownField: "REJECT",
    budget: { maxNodes: 8, maxEdges: 8, maxDepth: 4, maxSteps: 50, timeoutMs: 20 },
    allowedFields: ["challengeId"],
    rules: [
      { id: "status", predicate: "statusNotIn", params: { forbidden: ["REVOKED", "SUSPENDED", "EXPIRED"] } },
      { id: "acyclic", predicate: "graphAcyclic", params: {} },
    ],
    ...over,
  };
}

export function fail(message: string): never {
  throw new Error(message);
}
