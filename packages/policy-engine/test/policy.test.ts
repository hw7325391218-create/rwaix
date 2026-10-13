import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePolicy, type EvaluationInput, type TrustPolicy } from "@rwaix/policy-engine";
import { digestPrefixed } from "@rwaix/protocol";

const digest = digestPrefixed({ v: 1 });

function policy(over: Partial<TrustPolicy> = {}): TrustPolicy {
  return {
    schemaId: "rwaix.policy.v1",
    policyId: "unit",
    version: "1.0.0",
    unknownField: "REJECT",
    budget: { maxNodes: 4, maxEdges: 4, maxDepth: 2, maxSteps: 50, timeoutMs: 20 },
    allowedFields: ["challengeId"],
    rules: [{ id: "acyclic", predicate: "graphAcyclic", params: {} }],
    ...over,
  };
}

function input(over: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    context: {
      schemaId: "rwaix.context.v1",
      audience: "aud",
      purpose: "purpose",
      objectRef: { objectId: "obj-1", bindingVersion: "1" },
      requestedAction: "read",
      domain: "unit",
      subjectRef: "subject-1",
      challengeNonce: "nonce-1234",
      deadline: "2026-10-12T00:00:00Z",
      policyVersion: "1.0.0",
    },
    policy: policy(),
    graph: {
      schemaId: "rwaix.evidence.graph.v1",
      graphId: "g1",
      nodes: [
        { nodeId: "n1", nodeType: "OBSERVATION", sourceId: "s1", controllerId: "c1", contentDigest: digest, capturedAt: "2026-10-11T00:00:00Z", payload: { challengeId: "c" } },
      ],
      edges: [],
    },
    statusSnapshot: { schemaId: "rwaix.status.snapshot.v1", snapshotId: "snap-1", asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: "subject-1", status: "ACTIVE" }] },
    terms: { challengeId: "c" },
    evaluationTime: "2026-10-11T00:00:00Z",
    startedAtMs: 0,
    nowMs: 1,
    ...over,
  };
}

test("cycle is an explicit deny and over-depth is an error", () => {
  const cyclic = input();
  cyclic.graph.nodes.push({ nodeId: "n2", nodeType: "OBSERVATION", sourceId: "s1", controllerId: "c1", contentDigest: digest, payload: {} });
  cyclic.graph.edges.push(
    { edgeId: "e1", edgeType: "BASED_ON", from: "n1", to: "n2" },
    { edgeId: "e2", edgeType: "BASED_ON", from: "n2", to: "n1" },
  );
  const denied = evaluatePolicy(cyclic);
  assert.equal(denied.ok, true);
  if (denied.ok) {
    assert.equal(denied.decision.decision, "DENY");
    assert.ok(denied.decision.reasonCodes.includes("GRAPH_CYCLE"));
  }
  const deep = input();
  deep.policy = policy({ budget: { maxNodes: 8, maxEdges: 8, maxDepth: 2, maxSteps: 50, timeoutMs: 20 } });
  deep.graph.nodes = ["n1", "n2", "n3"].map((nodeId) => ({
    nodeId,
    nodeType: "OBSERVATION",
    sourceId: "s1",
    controllerId: "c1",
    contentDigest: digest,
    payload: {},
  }));
  deep.graph.edges = [
    { edgeId: "e1", edgeType: "BASED_ON", from: "n1", to: "n2" },
    { edgeId: "e2", edgeType: "BASED_ON", from: "n2", to: "n3" },
  ];
  const limited = evaluatePolicy(deep);
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.error, "DEPTH_EXCEEDED");
});

test("timeout, unknown predicate, and unknown field do not become ALLOW", () => {
  const timed = evaluatePolicy(input({ nowMs: 100, startedAtMs: 0 }));
  assert.equal(timed.ok, false);
  if (!timed.ok) assert.equal(timed.error, "TIMEOUT");
  const unknownPred = input();
  unknownPred.policy = policy({ rules: [{ id: "x", predicate: "eval", params: {} }] });
  const pred = evaluatePolicy(unknownPred);
  assert.equal(pred.ok, false);
  if (!pred.ok) assert.equal(pred.error, "UNKNOWN_PREDICATE");
  const extra = input();
  extra.graph.nodes[0]?.payload && (extra.graph.nodes[0].payload.secret = "no");
  const field = evaluatePolicy(extra);
  assert.equal(field.ok, true);
  if (field.ok) {
    assert.equal(field.decision.decision, "DENY");
    assert.ok(field.decision.reasonCodes.includes("UNKNOWN_FIELD"));
  }
});
