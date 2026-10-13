import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePolicy } from "@rwaix/policy-engine";
import { keyFromSeed } from "@rwaix/protocol";
import { PROFILE_IDS, adapterFor } from "../src/index.js";

test("each profile allows its own scope and denies a mismatch", () => {
  const issuer = keyFromSeed("profile-issuer").publicRef;
  assert.equal(PROFILE_IDS.length, 8);
  assert.equal(PROFILE_IDS[0], "nft");
  assert.equal(adapterFor("nft", issuer).profileId, "nft.trade");
  for (const id of PROFILE_IDS) {
    const adapter = adapterFor(id, issuer);
    assert.ok(adapter.externalFacts.length > 0, id);
    const policy = adapter.buildPolicy();
    const scope = policy.rules.find((rule) => rule.predicate === "domainScopeMatch");
    const fields = scope?.params.fields as string[];
    const terms: Record<string, string> = {};
    for (const field of fields) terms[field] = `${field}-ok`;
    const graph = {
      schemaId: "rwaix.evidence.graph.v1" as const,
      graphId: `g-${id}`,
      nodes: [
        { nodeId: "cred", nodeType: "CREDENTIAL", sourceId: "issuer", controllerId: issuer, contentDigest: "sha256:" + "ab".repeat(32), issuer, capturedAt: "2026-10-11T00:00:00Z" },
        { nodeId: "obs", nodeType: "OBSERVATION", sourceId: "src", controllerId: issuer, contentDigest: "sha256:" + "ab".repeat(32), capturedAt: "2026-10-11T00:00:00Z", payload: terms },
      ],
      edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
    };
    const context = {
      schemaId: "rwaix.context.v1" as const,
      audience: String(policy.rules.find((rule) => rule.predicate === "audienceEquals")?.params.audience),
      purpose: String(policy.rules.find((rule) => rule.predicate === "purposeEquals")?.params.purpose),
      objectRef: { objectId: "obj", bindingVersion: "1" },
      requestedAction: String((policy.rules.find((rule) => rule.predicate === "actionAllowlist")?.params.actions as string[])[0]),
      domain: id,
      subjectRef: "subject",
      challengeNonce: "nonce-0001",
      deadline: "2026-12-01T00:00:00Z",
      policyVersion: "1.0.0",
    };
    const allow = evaluatePolicy({
      context, policy, graph, terms, evaluationTime: "2026-10-11T00:00:00Z", startedAtMs: 0, nowMs: 1,
      statusSnapshot: { schemaId: "rwaix.status.snapshot.v1", snapshotId: "snap", asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: "subject", status: "ACTIVE" }] },
    });
    assert.equal(allow.ok && allow.decision.decision === "ALLOW", true, id);
    const bad = { ...terms, [fields[0] ?? "x"]: "other" };
    const deny = evaluatePolicy({
      context, policy, graph: { ...graph, graphId: `bad-${id}`, nodes: graph.nodes.map((node) => node.nodeId === "obs" ? { ...node, payload: bad } : node) },
      terms, evaluationTime: "2026-10-11T00:00:00Z", startedAtMs: 0, nowMs: 1,
      statusSnapshot: { schemaId: "rwaix.status.snapshot.v1", snapshotId: "snap", asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: "subject", status: "ACTIVE" }] },
    });
    assert.equal(deny.ok && deny.decision.decision === "DENY" && deny.decision.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH"), true, id);
  }
});
