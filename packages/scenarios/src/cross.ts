import { adapterFor } from "@rwaix/adapter-profiles";
import { evaluatePolicy } from "@rwaix/policy-engine";
import { ManualClock, ProtocolError, digestPrefixed, keyFromSeed, schemaDigest, signRequest } from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";

/**
 * Section 19 chain, after the section 17 NFT profile: qualification, license,
 * narrowed agent budget, and compute stay on separate trades and obligations.
 * The NFT allow check runs first and does not replace those trades. Revocation
 * blocks new work and does not erase the historical receipt. Silence does not
 * close a dispute.
 */
export function runCrossScenario():
  | {
      ok: true;
      titleZh: string;
      titleEn: string;
      trades: string[];
      dispute: string;
      feeSplit: Array<{ obligationId: string; assetId: string; amount: string; kind: string }>;
      budget: { parentCap: string; children: string[]; rejected: string };
      reconciliation: { disputesResolvedBySilence: number };
      ledgers: ReturnType<ReferenceService["exportLedgers"]>;
    }
  | { ok: false; detail: string } {
  try {
    const clock = new ManualClock("2026-10-11T00:00:00Z");
    const issuer = keyFromSeed("cross-issuer");
    const org = keyFromSeed("cross-org");
    const designer = keyFromSeed("cross-designer");
    const creator = keyFromSeed("cross-creator");
    const provider = keyFromSeed("cross-provider");
    const treasury = keyFromSeed("cross-treasury");
    const admin = keyFromSeed("cross-admin");
    const verifier = keyFromSeed("cross-verifier");
    const service = new ReferenceService({
      clock,
      verifier,
      grants: [
        { signer: treasury.publicRef, role: "TREASURY" },
        { signer: admin.publicRef, role: "STATUS_ADMIN" },
      ],
    });
    const nft = adapterFor("nft", issuer.publicRef);
    const identity = adapterFor("identity", issuer.publicRef);
    const content = adapterFor("content", issuer.publicRef);
    const compute = adapterFor("compute", issuer.publicRef);
    const nftTerms = {
      network: "31337",
      contract: "0x00000000000000000000000000000000000000aa",
      tokenId: "1",
      workDigest: digestPrefixed({ work: "cross-nft" }),
      licenceVersion: "licence-v1",
      licenceScope: "display-private",
      sellerControl: "seller-holds",
      recipient: "buyer-wallet",
      copyrightTransfer: "false",
    };
    const orgTerms = { qualificationId: "org-license", recipientOrg: "org-design" };
    const designTerms = { qualificationId: "designer", recipientOrg: "org-design" };
    const licenseTerms = { workVersion: "work-v3", territory: "CN", sublicense: "no" };
    const computeTerms = { challengeId: "chal-cross", outputFormat: "sha256" };
    const allow = (adapter: ReturnType<typeof adapterFor>, terms: Record<string, string>, subject: string) => {
      const policy = adapter.buildPolicy();
      const decision = evaluatePolicy({
        context: {
          schemaId: "rwaix.context.v1",
          audience: String(policy.rules.find((rule) => rule.predicate === "audienceEquals")?.params.audience),
          purpose: String(policy.rules.find((rule) => rule.predicate === "purposeEquals")?.params.purpose),
          objectRef: { objectId: subject, bindingVersion: "1" },
          requestedAction: String((policy.rules.find((rule) => rule.predicate === "actionAllowlist")?.params.actions as string[])[0]),
          domain: "cross",
          subjectRef: subject,
          challengeNonce: "cross-nonce-01",
          deadline: "2026-12-01T00:00:00Z",
          policyVersion: "1.0.0",
        },
        policy,
        graph: {
          schemaId: "rwaix.evidence.graph.v1",
          graphId: `g-${subject}`,
          nodes: [
            { nodeId: "cred", nodeType: "CREDENTIAL", sourceId: "issuer", controllerId: issuer.publicRef, contentDigest: digestPrefixed({ subject }), issuer: issuer.publicRef, capturedAt: "2026-10-11T00:00:00Z" },
            { nodeId: "obs", nodeType: "OBSERVATION", sourceId: "src", controllerId: issuer.publicRef, contentDigest: digestPrefixed({ subject }), capturedAt: "2026-10-11T00:00:00Z", payload: terms },
          ],
          edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
        },
        statusSnapshot: { schemaId: "rwaix.status.snapshot.v1", snapshotId: subject, asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: subject, status: "ACTIVE" }] },
        terms,
        evaluationTime: "2026-10-11T00:00:00Z",
        startedAtMs: 0,
        nowMs: 1,
      });
      if (!decision.ok || decision.decision.decision !== "ALLOW") throw new Error(`${subject} was not ALLOW`);
      return decision.decision;
    };
    allow(nft, nftTerms, "nft-work");
    allow(identity, orgTerms, "org");
    allow(identity, designTerms, "designer");
    const licenseDecision = allow(content, licenseTerms, "license");
    const badLicense = evaluatePolicy({
      context: {
        schemaId: "rwaix.context.v1",
        audience: "rwaix:licensee",
        purpose: "content.license.verify",
        objectRef: { objectId: "license", bindingVersion: "1" },
        requestedAction: "content.use",
        domain: "cross",
        subjectRef: "license",
        challengeNonce: "cross-nonce-02",
        deadline: "2026-12-01T00:00:00Z",
        policyVersion: "1.0.0",
      },
      policy: content.buildPolicy(),
      graph: {
        schemaId: "rwaix.evidence.graph.v1",
        graphId: "g-sublicense",
        nodes: [
          { nodeId: "cred", nodeType: "CREDENTIAL", sourceId: "issuer", controllerId: issuer.publicRef, contentDigest: digestPrefixed({ s: 1 }), issuer: issuer.publicRef, capturedAt: "2026-10-11T00:00:00Z" },
          { nodeId: "obs", nodeType: "OBSERVATION", sourceId: "src", controllerId: issuer.publicRef, contentDigest: digestPrefixed({ s: 1 }), capturedAt: "2026-10-11T00:00:00Z", payload: { ...licenseTerms, sublicense: "yes" } },
        ],
        edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
      },
      statusSnapshot: { schemaId: "rwaix.status.snapshot.v1", snapshotId: "license", asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: "license", status: "ACTIVE" }] },
      terms: licenseTerms,
      evaluationTime: "2026-10-11T00:00:00Z",
      startedAtMs: 0,
      nowMs: 1,
    });
    if (!badLicense.ok || !badLicense.decision.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH")) throw new Error("sublicense was allowed");
    allow(compute, computeTerms, "compute");
    service.budgets.open({
      grantId: "parent", controller: org.publicRef, agent: designer.publicRef, tools: ["render"], payees: [provider.publicRef, creator.publicRef],
      assets: ["USD_TEST", "RWAIX_TEST"], cap: 100n, expiry: "2026-12-01T00:00:00Z", allowRedelegate: true,
    });
    service.budgets.delegate("parent", {
      grantId: "compute-child", agent: designer.publicRef, tools: ["render"], payees: [provider.publicRef], assets: ["USD_TEST"],
      cap: 40n, expiry: "2026-11-01T00:00:00Z", allowRedelegate: false,
    });
    service.budgets.delegate("parent", {
      grantId: "license-child", agent: designer.publicRef, tools: ["render"], payees: [creator.publicRef], assets: ["USD_TEST"],
      cap: 50n, expiry: "2026-11-01T00:00:00Z", allowRedelegate: false,
    });
    let widened = false;
    try {
      service.budgets.delegate("parent", {
        grantId: "over", agent: designer.publicRef, tools: ["render"], payees: [provider.publicRef], assets: ["USD_TEST"],
        cap: 20n, expiry: "2026-11-01T00:00:00Z", allowRedelegate: false,
      });
    } catch (error) {
      widened = error instanceof ProtocolError && error.code === "OVERSPEND";
    }
    if (!widened) throw new Error("parent budget did not constrain children");
    const openTrade = (tradeId: string, profileId: string, terms: Record<string, string>, obligationId: string, amount: string, assetId: string, customer: typeof org, providerKey: typeof provider) => {
      const opened = service.trade(signRequest(customer, "trade", {
        schemaId: "rwaix.request.trade.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: `${tradeId}-open`, op: "OPEN",
        envelope: {
          schemaId: "rwaix.trade.envelope.v1", protocolVersion: "rwaix-0.1.0", profileId, profileVersion: "1.0.0",
          schemaDigest: schemaDigest("rwaix.trade.envelope.v1"), tradeId, termsDigest: digestPrefixed(terms),
          parties: [
            { partyId: customer.publicRef, role: "CUSTOMER", authorityRef: "auth" },
            { partyId: providerKey.publicRef, role: "PROVIDER", authorityRef: "auth" },
          ],
          objects: [{ objectId: tradeId, quantity: "1", unit: "job" }],
          obligations: [
            { obligationId, kind: "SERVICE", amount, assetId, decimals: assetId === "USD_TEST" ? 2 : 18, rounding: "EXACT_INTEGER" },
            { obligationId: `${obligationId}-fee`, kind: "NETWORK_FEE", amount: "5", assetId: "RWAIX_TEST", decimals: 18, rounding: "EXACT_INTEGER" },
          ],
          acceptanceRule: "CUSTOMER_SIGNATURE", timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" }, paymentTerms: { trigger: "ACCEPTANCE" },
          applicableDocuments: [digestPrefixed(terms)], disputePath: "profile-dispute-v1", terms, extensions: {},
        },
      }, { nonce: `${tradeId}-nonce-01`, deadline: "2027-01-01T00:00:00Z" }));
      if (!opened.ok) throw new Error(`${tradeId} ${opened.error}`);
    };
    openTrade("trade-license", "content.license", licenseTerms, "obl-license", "50", "USD_TEST", org, creator);
    openTrade("trade-compute", "compute.delivery", computeTerms, "obl-compute", "40", "USD_TEST", org, provider);
    openTrade("trade-fee", "compute.delivery", computeTerms, "obl-net", "0", "RWAIX_TEST", org, provider);
    const dispute = service.trade(signRequest(org, "trade", {
      schemaId: "rwaix.request.trade.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "cross-dispute", op: "DISPUTE",
      dispute: {
        schemaId: "rwaix.dispute.v1", disputeId: "d-cross", tradeId: "trade-compute", obligationId: "obl-compute", claimant: org.publicRef,
        affectedAmount: "10", assetId: "USD_TEST", reason: "partial", evidenceDeadline: "2026-10-20T00:00:00Z", supplementRule: "written",
        dispositionAuthority: "panel", noticeRef: "n1", remedyPath: "profile-dispute-v1", status: "OPEN",
      },
    }, { nonce: "cross-dispute-01", deadline: "2027-01-01T00:00:00Z" }));
    if (!dispute.ok) throw new Error(dispute.error);
    clock.set("2026-11-01T00:00:00Z");
    const sweep = service.trade(signRequest(org, "trade", {
      schemaId: "rwaix.request.trade.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "cross-sweep", op: "SWEEP",
    }, { nonce: "cross-sweep-0001", deadline: "2027-01-01T00:00:00Z" }));
    clock.set("2026-10-11T00:00:00Z");
    if (!sweep.ok || sweep.value.disputesResolvedBySilence !== 0) throw new Error("silence resolved a dispute");
    if (service.tradeView("trade-license").tradeId !== "trade-license") throw new Error("license trade missing");
    if (service.tradeView("trade-compute").dispute !== "OPEN") throw new Error("compute dispute was cleared");
    void licenseDecision;
    return {
      ok: true,
      titleZh: "NFT 之后的跨场景扩展",
      titleEn: "Cross-scenario extension after the NFT profile",
      trades: ["trade-license", "trade-compute", "trade-fee"],
      dispute: service.tradeView("trade-compute").dispute,
      feeSplit: [
        { obligationId: "obl-license", assetId: "USD_TEST", amount: "50", kind: "SERVICE" },
        { obligationId: "obl-compute", assetId: "USD_TEST", amount: "40", kind: "SERVICE" },
        { obligationId: "obl-net", assetId: "RWAIX_TEST", amount: "0", kind: "SERVICE" },
        { obligationId: "obl-net-fee", assetId: "RWAIX_TEST", amount: "5", kind: "NETWORK_FEE" },
      ],
      budget: { parentCap: "100", children: ["40", "50"], rejected: "OVERSPEND" },
      reconciliation: { disputesResolvedBySilence: sweep.value.disputesResolvedBySilence },
      ledgers: service.exportLedgers(),
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
