import {
  ENGINE_VERSION,
  ProtocolError,
  digestPrefixed,
  secondsBetween,
} from "@rwaix/protocol";

export const ENGINE_BUILD_DIGEST = digestPrefixed(`engine-build:${ENGINE_VERSION}`);

export type DecisionCode = "ALLOW" | "DENY" | "INDETERMINATE";
export type PredicateOutcome = "pass" | "deny" | "indeterminate";

export interface PredicateResult {
  ruleId: string;
  predicate: string;
  outcome: PredicateOutcome;
  reasonCode: string;
}

export interface TrustPolicy {
  schemaId: "rwaix.policy.v1";
  policyId: string;
  version: string;
  unknownField: "REJECT" | "IGNORE_BEHAVIOR_KEEP_SIGNED";
  budget: { maxNodes: number; maxEdges: number; maxDepth: number; maxSteps: number; timeoutMs: number };
  allowedFields: string[];
  rules: Array<{ id: string; predicate: string; params: Record<string, unknown> }>;
}

export interface EvidenceNode {
  nodeId: string;
  nodeType: string;
  sourceId: string;
  controllerId: string;
  contentDigest: string;
  issuer?: string;
  capturedAt?: string;
  payload?: Record<string, unknown>;
}

export interface EvidenceGraph {
  schemaId: "rwaix.evidence.graph.v1";
  graphId: string;
  nodes: EvidenceNode[];
  edges: Array<{ edgeId: string; edgeType: string; from: string; to: string }>;
}

export interface StatusSnapshot {
  schemaId: "rwaix.status.snapshot.v1";
  snapshotId: string;
  asOf: string;
  entries: Array<{ subjectRef: string; status: string; validUntil?: string }>;
}

export interface TrustContext {
  schemaId: "rwaix.context.v1";
  audience: string;
  purpose: string;
  objectRef: { objectId: string; bindingVersion: string };
  requestedAction: string;
  domain: string;
  subjectRef?: string;
  challengeNonce: string;
  deadline: string;
  policyVersion: string;
  [key: string]: unknown;
}

export interface PolicyDecision {
  schemaId: "rwaix.decision.v1";
  decisionId: string;
  ruleSetDigest: string;
  engineVersion: string;
  engineBuildDigest: string;
  inputSnapshotDigest: string;
  dependencyGraphDigest: string;
  predicateResults: PredicateResult[];
  decision: DecisionCode;
  reasonCodes: string[];
  evaluationTime: string;
}

export interface EvaluationInput {
  context: TrustContext;
  policy: TrustPolicy;
  graph: EvidenceGraph;
  statusSnapshot: StatusSnapshot;
  terms: Record<string, string>;
  evaluationTime: string;
  startedAtMs: number;
  nowMs: number;
}

export type EngineResult = { ok: true; decision: PolicyDecision } | { ok: false; error: string; message: string };

const PARAMS: Record<string, readonly string[]> = {
  issuerAllowlist: ["issuers"],
  statusNotIn: ["forbidden"],
  evidenceFresh: ["maxAgeSeconds"],
  fieldEquals: ["field", "equals"],
  graphAcyclic: [],
  graphWithinBudget: [],
  purposeEquals: ["purpose"],
  audienceEquals: ["audience"],
  actionAllowlist: ["actions"],
  requiredPresent: ["fields"],
  deadlineNotPassed: [],
  domainScopeMatch: ["fields"],
};

interface GraphFacts {
  cyclic: boolean;
  nodes: number;
  edges: number;
  depth: number;
  steps: number;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProtocolError("SCHEMA_INVALID", `${field} must be a string array`);
  }
  return value as string[];
}

function analyze(graph: EvidenceGraph, budget: TrustPolicy["budget"]): GraphFacts {
  if (graph.nodes.length > budget.maxNodes || graph.edges.length > budget.maxEdges) {
    throw new ProtocolError("GRAPH_LIMIT_EXCEEDED", "evidence graph exceeds the policy node or edge budget");
  }
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.nodeId)) throw new ProtocolError("SCHEMA_INVALID", `duplicate node ${node.nodeId}`);
    ids.add(node.nodeId);
  }
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new ProtocolError("SCHEMA_INVALID", `edge ${edge.edgeId} leaves the node set`);
    }
    adj.get(edge.from)?.push(edge.to);
  }
  const color = new Map<string, number>();
  const memo = new Map<string, number>();
  let cyclic = false;
  let depth = 0;
  let steps = graph.nodes.length + graph.edges.length;
  const dfs = (id: string): number => {
    steps += 1;
    if (steps > budget.maxSteps) throw new ProtocolError("TIMEOUT", "graph walk exceeded maxSteps");
    const mark = color.get(id) ?? 0;
    if (mark === 1) {
      cyclic = true;
      return 1;
    }
    if (mark === 2) return memo.get(id) ?? 1;
    color.set(id, 1);
    let best = 1;
    for (const next of adj.get(id) ?? []) best = Math.max(best, 1 + dfs(next));
    color.set(id, 2);
    memo.set(id, best);
    depth = Math.max(depth, best);
    return best;
  };
  for (const id of ids) {
    if ((color.get(id) ?? 0) === 0) dfs(id);
  }
  if (!cyclic && graph.nodes.length > 0 && depth > budget.maxDepth) {
    throw new ProtocolError("DEPTH_EXCEEDED", "evidence dependency depth exceeds the policy budget");
  }
  return { cyclic, nodes: graph.nodes.length, edges: graph.edges.length, depth: graph.nodes.length === 0 ? 0 : depth, steps };
}

function payloadStrings(node: EvidenceNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.payload ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pass(ruleId: string, predicate: string): PredicateResult {
  return { ruleId, predicate, outcome: "pass", reasonCode: "OK" };
}

function deny(ruleId: string, predicate: string, reasonCode: string): PredicateResult {
  return { ruleId, predicate, outcome: "deny", reasonCode };
}

function indet(ruleId: string, predicate: string, reasonCode: string): PredicateResult {
  return { ruleId, predicate, outcome: "indeterminate", reasonCode };
}

function checkParams(predicate: string, params: Record<string, unknown>): void {
  const allowed = PARAMS[predicate];
  if (!allowed) throw new ProtocolError("UNKNOWN_PREDICATE", predicate);
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new ProtocolError("UNKNOWN_FIELD", `unknown param ${predicate}.${key}`);
  }
  for (const key of allowed) {
    if (!(key in params)) throw new ProtocolError("SCHEMA_INVALID", `missing param ${predicate}.${key}`);
  }
}

function unknownPayload(policy: TrustPolicy, graph: EvidenceGraph): PredicateResult | undefined {
  const allowed = new Set(policy.allowedFields);
  const extra: string[] = [];
  for (const node of graph.nodes) {
    for (const key of Object.keys(node.payload ?? {})) {
      if (!allowed.has(key)) extra.push(key);
    }
  }
  if (extra.length === 0 || policy.unknownField === "IGNORE_BEHAVIOR_KEEP_SIGNED") return undefined;
  return deny("unknown-fields", "unknownField", "UNKNOWN_FIELD");
}

function evalRule(
  rule: TrustPolicy["rules"][number],
  input: EvaluationInput,
  facts: GraphFacts,
): PredicateResult {
  const { id, predicate, params } = rule;
  const { context, graph, statusSnapshot, terms, evaluationTime } = input;
  switch (predicate) {
    case "issuerAllowlist": {
      const issuers = new Set(asStringArray(params.issuers, "issuers"));
      const credentials = graph.nodes.filter((node) => node.nodeType === "CREDENTIAL");
      if (credentials.length === 0) return indet(id, predicate, "MISSING_AUTHORITY");
      for (const node of credentials) {
        if (!node.issuer || !issuers.has(node.issuer)) return deny(id, predicate, "ISSUER_NOT_ALLOWED");
      }
      return pass(id, predicate);
    }
    case "statusNotIn": {
      const forbidden = new Set(asStringArray(params.forbidden, "forbidden"));
      if (!context.subjectRef) return indet(id, predicate, "STATUS_UNAVAILABLE");
      const entry = statusSnapshot.entries.find((item) => item.subjectRef === context.subjectRef);
      if (!entry) return indet(id, predicate, "STATUS_UNAVAILABLE");
      if (!forbidden.has(entry.status)) return pass(id, predicate);
      if (entry.status === "REVOKED") return deny(id, predicate, "STATUS_REVOKED");
      if (entry.status === "SUSPENDED") return deny(id, predicate, "STATUS_SUSPENDED");
      if (entry.status === "EXPIRED") return deny(id, predicate, "STATUS_EXPIRED");
      return deny(id, predicate, "POLICY_NOT_SATISFIED");
    }
    case "evidenceFresh": {
      const maxAge = params.maxAgeSeconds;
      if (typeof maxAge !== "number" || !Number.isSafeInteger(maxAge) || maxAge < 0) {
        throw new ProtocolError("SCHEMA_INVALID", "maxAgeSeconds");
      }
      const stamped = graph.nodes.filter((node) => node.capturedAt);
      if (stamped.length === 0) return indet(id, predicate, "EVIDENCE_UNAVAILABLE");
      for (const node of stamped) {
        const age = secondsBetween(evaluationTime, node.capturedAt as string);
        if (age < 0 || age > maxAge) return deny(id, predicate, "EVIDENCE_STALE");
      }
      return pass(id, predicate);
    }
    case "fieldEquals": {
      const field = params.field;
      const equals = params.equals;
      if (typeof field !== "string" || typeof equals !== "string") throw new ProtocolError("SCHEMA_INVALID", "fieldEquals");
      if (!(field in terms)) return indet(id, predicate, "MISSING_REQUIRED_FIELD");
      return terms[field] === equals ? pass(id, predicate) : deny(id, predicate, "POLICY_NOT_SATISFIED");
    }
    case "graphAcyclic":
      return facts.cyclic ? deny(id, predicate, "GRAPH_CYCLE") : pass(id, predicate);
    case "graphWithinBudget":
      return facts.nodes <= input.policy.budget.maxNodes &&
        facts.edges <= input.policy.budget.maxEdges &&
        facts.depth <= input.policy.budget.maxDepth
        ? pass(id, predicate)
        : deny(id, predicate, "GRAPH_LIMIT_EXCEEDED");
    case "purposeEquals":
      return context.purpose === params.purpose ? pass(id, predicate) : deny(id, predicate, "PURPOSE_MISMATCH");
    case "audienceEquals":
      return context.audience === params.audience ? pass(id, predicate) : deny(id, predicate, "AUDIENCE_MISMATCH");
    case "actionAllowlist": {
      const actions = asStringArray(params.actions, "actions");
      return actions.includes(context.requestedAction) ? pass(id, predicate) : deny(id, predicate, "ACTION_NOT_ALLOWED");
    }
    case "requiredPresent": {
      for (const field of asStringArray(params.fields, "fields")) {
        if (!terms[field]) return indet(id, predicate, "MISSING_REQUIRED_FIELD");
      }
      return pass(id, predicate);
    }
    case "deadlineNotPassed":
      return evaluationTime <= context.deadline ? pass(id, predicate) : deny(id, predicate, "DEADLINE_PASSED");
    case "domainScopeMatch": {
      const fields = asStringArray(params.fields, "fields");
      for (const field of fields) {
        if (!(field in terms)) return indet(id, predicate, "MISSING_REQUIRED_FIELD");
        const seen = new Set<string>();
        for (const node of graph.nodes) {
          const payload = payloadStrings(node);
          if (field in payload) seen.add(payload[field] as string);
        }
        if (seen.size === 0) return indet(id, predicate, "MISSING_REQUIRED_FIELD");
        if (seen.size !== 1 || !seen.has(terms[field] as string)) {
          return deny(id, predicate, "DOMAIN_POLICY_SCOPE_MISMATCH");
        }
      }
      return pass(id, predicate);
    }
    default:
      throw new ProtocolError("UNKNOWN_PREDICATE", predicate);
  }
}

export function evaluatePolicy(input: EvaluationInput): EngineResult {
  try {
    if (!Number.isSafeInteger(input.startedAtMs) || !Number.isSafeInteger(input.nowMs) || input.nowMs < input.startedAtMs) {
      throw new ProtocolError("SCHEMA_INVALID", "evaluation clock inputs are inconsistent");
    }
    if (input.nowMs - input.startedAtMs > input.policy.budget.timeoutMs) {
      throw new ProtocolError("TIMEOUT", "policy evaluation exceeded timeoutMs");
    }
    if (input.policy.version !== input.context.policyVersion) {
      throw new ProtocolError("POLICY_DIGEST_MISMATCH", "context.policyVersion does not match the policy document");
    }
    for (const rule of input.policy.rules) checkParams(rule.predicate, rule.params);
    const facts = analyze(input.graph, input.policy.budget);
    if (facts.steps > input.policy.budget.maxSteps) {
      throw new ProtocolError("TIMEOUT", "policy evaluation exceeded maxSteps");
    }
    const results: PredicateResult[] = [];
    const unknown = unknownPayload(input.policy, input.graph);
    if (unknown) results.push(unknown);
    for (const rule of input.policy.rules) results.push(evalRule(rule, input, facts));
    const denies = results.filter((item) => item.outcome === "deny");
    const indeterminates = results.filter((item) => item.outcome === "indeterminate");
    const decision: DecisionCode = denies.length > 0 ? "DENY" : indeterminates.length > 0 ? "INDETERMINATE" : "ALLOW";
    const reasonCodes =
      decision === "ALLOW" ? ["OK"] : unique((decision === "DENY" ? denies : indeterminates).map((item) => item.reasonCode));
    const policyDigest = digestPrefixed(input.policy);
    const evidenceRoot = digestPrefixed(input.graph);
    const body = {
      schemaId: "rwaix.decision.v1" as const,
      ruleSetDigest: policyDigest,
      engineVersion: ENGINE_VERSION,
      engineBuildDigest: ENGINE_BUILD_DIGEST,
      inputSnapshotDigest: digestPrefixed({
        context: input.context,
        policyDigest,
        evidenceRoot,
        statusSnapshot: input.statusSnapshot,
        terms: input.terms,
        evaluationTime: input.evaluationTime,
      }),
      dependencyGraphDigest: evidenceRoot,
      predicateResults: results,
      decision,
      reasonCodes,
      evaluationTime: input.evaluationTime,
    };
    return { ok: true, decision: { ...body, decisionId: digestPrefixed(body) } };
  } catch (error) {
    if (error instanceof ProtocolError) return { ok: false, error: error.code, message: error.message };
    throw error;
  }
}
