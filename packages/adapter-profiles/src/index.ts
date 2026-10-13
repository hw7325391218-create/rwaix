import { ComputeAdapter } from "@rwaix/adapter-compute";
import { assertStringMap, type IndustryAdapter, type ScopeResult } from "@rwaix/adapter-sdk";
import type { TrustPolicy } from "@rwaix/policy-engine";

export interface ProfileSpec {
  profileId: string;
  audience: string;
  purpose: string;
  action: string;
  scopeFields: readonly string[];
  allowedFields: readonly string[];
  externalFacts: readonly string[];
}

export const PROFILES: Record<string, ProfileSpec> = {
  nft: {
    profileId: "nft.trade",
    audience: "rwaix:nft-buyer",
    purpose: "nft.trade.verify",
    action: "nft.accept",
    scopeFields: ["network", "contract", "tokenId", "workDigest", "licenceVersion", "licenceScope", "sellerControl", "recipient", "copyrightTransfer"],
    allowedFields: ["network", "contract", "tokenId", "workDigest", "licenceVersion", "licenceScope", "sellerControl", "recipient", "copyrightTransfer"],
    externalFacts: [
      "This profile is a synthetic order. It does not connect to a company NFT platform, mint a token, or review copyright.",
      "Wallet balance does not grant listing, transfer, or licence authority.",
      "An NFT transfer does not transfer copyright. Signed terms keep copyrightTransfer false.",
      "A rights check evaluates the submitted evidence and authorization chain. It does not guarantee originality or the absence of a third-party claim.",
      "Digests do not decide originality or lawful title.",
      "This indivisible object and the zero network fee are synthetic demo parameters. They do not describe every existing company NFT product, its fees, or its legal classification.",
      "Acceptance then payment is the selected demo order. A real prepay, installment, or final payment would be its own obligation.",
      "A chain observation is an external fact. It is not acceptance of every licensed right.",
      "A delivery dispute does not authorize a refund, a remint, or a reverse transfer.",
      "This ordinary NFT object is not a facility DCNFT. Order price is not shared with DCNFT or RWAIX holders.",
    ],
  },
  identity: {
    profileId: "identity.qualification",
    audience: "rwaix:receiving-org",
    purpose: "identity.qualification.verify",
    action: "identity.present",
    scopeFields: ["qualificationId", "recipientOrg"],
    allowedFields: ["qualificationId", "recipientOrg", "subjectDid"],
    externalFacts: [
      "Key control does not prove a natural person is unique.",
      "A qualification cannot be sold by transferring an asset NFT.",
      "Buying a test token is not a condition of the qualification.",
    ],
  },
  content: {
    profileId: "content.license",
    audience: "rwaix:licensee",
    purpose: "content.license.verify",
    action: "content.use",
    scopeFields: ["workVersion", "territory", "sublicense"],
    allowedFields: ["workVersion", "territory", "sublicense", "trainingUse"],
    externalFacts: [
      "A timestamp does not prove authorship or copyright ownership.",
      "Revoking a credential does not retrieve copies already downloaded.",
      "A work NFT is not a facility DCNFT.",
    ],
  },
  data: {
    profileId: "data.authorization",
    audience: "rwaix:data-recipient",
    purpose: "data.authorization.verify",
    action: "data.query",
    scopeFields: ["purpose", "recipient", "queryType"],
    allowedFields: ["purpose", "recipient", "queryType", "datasetVersion"],
    externalFacts: [
      "An on-chain commitment does not keep the payload confidential.",
      "Revocation blocks later access and does not erase copies or model effects.",
      "Holding a test token does not buy training rights.",
    ],
  },
  supply: {
    profileId: "supply.batch",
    audience: "rwaix:receiver",
    purpose: "supply.batch.verify",
    action: "supply.receive",
    scopeFields: ["batchId", "inspection"],
    allowedFields: ["batchId", "inspection", "quantity", "unit"],
    externalFacts: [
      "A signature identifies the declarant, not the contents of a box.",
      "Sensors can be manipulated. Unobserved physical facts stay indeterminate.",
      "Goods payment is a separate obligation from a verification fee.",
    ],
  },
  agent: {
    profileId: "agent.workflow",
    audience: "rwaix:agent-operator",
    purpose: "agent.workflow.verify",
    action: "agent.invoke",
    scopeFields: ["tool", "payee", "redelegate"],
    allowedFields: ["tool", "payee", "redelegate", "taskId"],
    externalFacts: [
      "Untrusted text cannot widen a grant or change a payee.",
      "A child delegation can only narrow the parent.",
      "Service orchestration is not permission to buy or transfer a DCNFT.",
    ],
  },
  device: {
    profileId: "device.service",
    audience: "rwaix:device-customer",
    purpose: "device.service.verify",
    action: "device.dispatch",
    scopeFields: ["taskId", "localSafetyPermit"],
    allowedFields: ["taskId", "localSafetyPermit", "deviceId"],
    externalFacts: [
      "Chain finality does not replace a local emergency stop.",
      "A low token balance must not block a safety action.",
      "Maintenance credentials are not facility DCNFT rights.",
    ],
  },
};

class ProfileAdapter implements IndustryAdapter<Record<string, string>> {
  readonly profileVersion = "1.0.0";
  readonly profileId: string;
  readonly externalFacts: readonly string[];

  constructor(
    private readonly spec: ProfileSpec,
    private readonly issuerRef: string,
  ) {
    this.profileId = spec.profileId;
    this.externalFacts = spec.externalFacts;
  }

  buildPolicy(): TrustPolicy {
    return {
      schemaId: "rwaix.policy.v1",
      policyId: this.spec.profileId,
      version: "1.0.0",
      unknownField: "REJECT",
      budget: { maxNodes: 32, maxEdges: 64, maxDepth: 8, maxSteps: 400, timeoutMs: 1000 },
      allowedFields: [...this.spec.allowedFields],
      rules: [
        { id: "issuer", predicate: "issuerAllowlist", params: { issuers: [this.issuerRef] } },
        { id: "status", predicate: "statusNotIn", params: { forbidden: ["REVOKED", "SUSPENDED", "EXPIRED"] } },
        { id: "fresh", predicate: "evidenceFresh", params: { maxAgeSeconds: 86400 } },
        { id: "audience", predicate: "audienceEquals", params: { audience: this.spec.audience } },
        { id: "action", predicate: "actionAllowlist", params: { actions: [this.spec.action] } },
        { id: "scope", predicate: "domainScopeMatch", params: { fields: [...this.spec.scopeFields] } },
        { id: "acyclic", predicate: "graphAcyclic", params: {} },
        { id: "budget", predicate: "graphWithinBudget", params: {} },
        { id: "purpose", predicate: "purposeEquals", params: { purpose: this.spec.purpose } },
        { id: "deadline", predicate: "deadlineNotPassed", params: {} },
      ],
    };
  }

  mapEvidence(input: Record<string, string>): Record<string, string> {
    return { ...input };
  }

  checkScope(terms: Record<string, string>, evidence: Record<string, string>): ScopeResult {
    const present = assertStringMap(evidence, this.spec.scopeFields);
    if (!present.ok) return present;
    for (const field of this.spec.scopeFields) {
      if (terms[field] !== evidence[field]) return { ok: false, reasonCode: "DOMAIN_POLICY_SCOPE_MISMATCH" };
    }
    return { ok: true };
  }
}

export function adapterFor(id: string, issuerRef: string): IndustryAdapter<Record<string, string>> {
  if (id === "compute") {
    const inner = new ComputeAdapter(issuerRef);
    return {
      profileId: inner.profileId,
      profileVersion: inner.profileVersion,
      externalFacts: inner.externalFacts,
      buildPolicy: () => inner.buildPolicy(),
      mapEvidence: (input) => inner.mapEvidence(input as unknown as Parameters<ComputeAdapter["mapEvidence"]>[0]),
      checkScope: (terms, evidence) => inner.checkScope(terms, evidence),
    };
  }
  const spec = PROFILES[id];
  if (!spec) throw new Error(`unknown profile ${id}`);
  return new ProfileAdapter(spec, issuerRef);
}

export const PROFILE_IDS = ["nft", "identity", "content", "data", "supply", "agent", "compute", "device"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
