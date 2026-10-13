import { assertStringMap, type IndustryAdapter, type ScopeResult } from "@rwaix/adapter-sdk";
import type { TrustPolicy } from "@rwaix/policy-engine";

export interface ComputeDelivery {
  challengeId: string;
  outputFormat: string;
  reservationId: string;
  deviceId: string;
  workloadDigest: string;
  outputDigest: string;
  quantity: string;
  unit: string;
}

const SCOPE_FIELDS = ["challengeId", "outputFormat"] as const;

/**
 * Compute / 算力 is a later extension (whitepaper v6.4 section 18.6).
 * The first planned application is the NFT trade profile. Remote
 * attestation and telemetry stay external facts: a signed meter reading
 * is not proof that a GPU result is semantically correct.
 */
export class ComputeAdapter implements IndustryAdapter<ComputeDelivery> {
  readonly profileId = "compute.delivery";
  readonly profileVersion = "1.0.0";
  readonly externalFacts = [
    "Compute delivery is a later extension, not the first planned application.",
    "Physical capacity outside this ledger can still be oversold.",
    "A device signature does not prove the computation result is correct.",
    "Customer acceptance is a separate signature from the TrustReceipt.",
    "A synthetic DCNFT series reference does not pay the invoice and is not minted here.",
    "The facility split among a technology operator, an SPV, and a local operator is proposed and still needs a valid grant.",
  ];

  constructor(private readonly issuerRef: string, private readonly audience = "rwaix:compute-customer") {}

  buildPolicy(): TrustPolicy {
    return {
      schemaId: "rwaix.policy.v1",
      policyId: "compute.delivery",
      version: "1.0.0",
      unknownField: "REJECT",
      budget: { maxNodes: 32, maxEdges: 64, maxDepth: 8, maxSteps: 400, timeoutMs: 1000 },
      allowedFields: ["challengeId", "outputFormat", "reservationId", "deviceId", "workloadDigest", "outputDigest", "quantity", "unit"],
      rules: [
        { id: "issuer", predicate: "issuerAllowlist", params: { issuers: [this.issuerRef] } },
        { id: "status", predicate: "statusNotIn", params: { forbidden: ["REVOKED", "SUSPENDED", "EXPIRED"] } },
        { id: "fresh", predicate: "evidenceFresh", params: { maxAgeSeconds: 86400 } },
        { id: "audience", predicate: "audienceEquals", params: { audience: this.audience } },
        { id: "action", predicate: "actionAllowlist", params: { actions: ["compute.deliver"] } },
        { id: "scope", predicate: "domainScopeMatch", params: { fields: ["challengeId", "outputFormat"] } },
        { id: "acyclic", predicate: "graphAcyclic", params: {} },
        { id: "budget", predicate: "graphWithinBudget", params: {} },
        { id: "purpose", predicate: "purposeEquals", params: { purpose: "compute.delivery.verify" } },
        { id: "deadline", predicate: "deadlineNotPassed", params: {} },
      ],
    };
  }

  mapEvidence(input: ComputeDelivery): Record<string, string> {
    return { ...input };
  }

  checkScope(terms: Record<string, string>, evidence: Record<string, string>): ScopeResult {
    const present = assertStringMap(evidence, SCOPE_FIELDS);
    if (!present.ok) return present;
    for (const field of SCOPE_FIELDS) {
      if (terms[field] !== evidence[field]) return { ok: false, reasonCode: "DOMAIN_POLICY_SCOPE_MISMATCH" };
    }
    return { ok: true };
  }
}
