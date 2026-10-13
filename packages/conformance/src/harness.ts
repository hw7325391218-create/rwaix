import { ComputeAdapter } from "@rwaix/adapter-compute";
import type { EvidenceGraph, StatusSnapshot, TrustContext } from "@rwaix/policy-engine";
import {
  ManualClock,
  digestPrefixed,
  keyFromSeed,
  schemaDigest,
  signRequest,
  type ActionName,
  type P256Key,
  type Result,
} from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";

export const clock = new ManualClock("2026-10-11T00:00:00Z");
export const keys = {
  verifier: keyFromSeed("conformance-verifier"),
  customer: keyFromSeed("conformance-customer"),
  provider: keyFromSeed("conformance-provider"),
  issuer: keyFromSeed("conformance-issuer"),
  executor: keyFromSeed("conformance-executor"),
  treasury: keyFromSeed("conformance-treasury"),
  admin: keyFromSeed("conformance-admin"),
  stranger: keyFromSeed("conformance-stranger"),
};

export function freshService(): ReferenceService {
  return new ReferenceService({
    clock,
    verifier: keys.verifier,
    grants: [
      { signer: keys.executor.publicRef, role: "EXECUTOR" },
      { signer: keys.treasury.publicRef, role: "TREASURY" },
      { signer: keys.admin.publicRef, role: "STATUS_ADMIN" },
    ],
  });
}

let nonce = 0;
export function call(key: P256Key, action: ActionName, request: Record<string, unknown>) {
  nonce += 1;
  return signRequest(key, action, request, {
    nonce: `conf-${nonce.toString().padStart(8, "0")}`,
    deadline: "2027-01-01T00:00:00Z",
  });
}

export function req(schemaId: string, idempotencyKey: string, extra: Record<string, unknown>) {
  return { schemaId, protocolVersion: "rwaix-0.1.0", idempotencyKey, ...extra };
}

export function must<T>(result: Result<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.error} ${result.message}`);
  return result.value;
}

export function metaDigest(): string {
  return digestPrefixed({ conformance: true });
}

export function adapter(): ComputeAdapter {
  return new ComputeAdapter(keys.issuer.publicRef);
}

export function deliveryGraph(challengeId: string): EvidenceGraph {
  return {
    schemaId: "rwaix.evidence.graph.v1",
    graphId: `g-${challengeId}`.replace(/[^A-Za-z0-9._:-]/g, ""),
    nodes: [
      {
        nodeId: "cred",
        nodeType: "CREDENTIAL",
        sourceId: "issuer",
        controllerId: keys.issuer.publicRef,
        contentDigest: metaDigest(),
        issuer: keys.issuer.publicRef,
        capturedAt: "2026-10-11T00:00:00Z",
        payload: { quantity: "1", unit: "job" },
      },
      {
        nodeId: "obs",
        nodeType: "OBSERVATION",
        sourceId: "device",
        controllerId: keys.provider.publicRef,
        contentDigest: metaDigest(),
        capturedAt: "2026-10-11T00:00:00Z",
        payload: {
          challengeId,
          outputFormat: "sha256",
          reservationId: "res-1",
          deviceId: "gpu-1",
          workloadDigest: metaDigest(),
          outputDigest: metaDigest(),
          quantity: "1",
          unit: "job",
        },
      },
    ],
    edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
  };
}

export function context(objectId: string, version: string, subjectRef: string): TrustContext {
  return {
    schemaId: "rwaix.context.v1",
    protocolVersion: "rwaix-0.1.0",
    audience: "rwaix:compute-customer",
    purpose: "compute.delivery.verify",
    objectRef: { objectId, bindingVersion: version },
    requestedAction: "compute.deliver",
    domain: "compute",
    subjectRef,
    challengeNonce: "challenge-0001",
    deadline: "2026-12-01T00:00:00Z",
    policyVersion: "1.0.0",
  };
}

export function snapshot(subjectRef: string, status = "ACTIVE"): StatusSnapshot {
  return {
    schemaId: "rwaix.status.snapshot.v1",
    snapshotId: "snap-conf",
    asOf: "2026-10-11T00:00:00Z",
    entries: [{ subjectRef, status }],
  };
}

export function tradeEnvelope(
  tradeId: string,
  terms: Record<string, string>,
  obligations: unknown[],
  options?: { extensions?: Record<string, unknown>; profileId?: string },
) {
  return {
    schemaId: "rwaix.trade.envelope.v1",
    protocolVersion: "rwaix-0.1.0",
    profileId: options?.profileId ?? "compute.delivery",
    profileVersion: "1.0.0",
    schemaDigest: schemaDigest("rwaix.trade.envelope.v1"),
    tradeId,
    termsDigest: digestPrefixed(terms),
    parties: [
      { partyId: keys.customer.publicRef, role: "CUSTOMER", authorityRef: "auth-customer" },
      { partyId: keys.provider.publicRef, role: "PROVIDER", authorityRef: "auth-provider" },
    ],
    objects: [{ objectId: "obj-1", quantity: "1", unit: "job" }],
    obligations,
    acceptanceRule: "CUSTOMER_SIGNATURE",
    timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" },
    paymentTerms: { trigger: "ACCEPTANCE" },
    applicableDocuments: [metaDigest()],
    disputePath: "profile-dispute-v1",
    terms,
    extensions: options?.extensions ?? { "compute.metering": { samples: "1" } },
  };
}

export { digestPrefixed, schemaDigest };
