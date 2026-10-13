import { evaluatePolicy, type EvaluationInput, type PolicyDecision } from "@rwaix/policy-engine";
import {
  ProtocolError,
  canonicalStringify,
  digestPrefixed,
  signJws,
  verifyJws,
  type P256Key,
} from "@rwaix/protocol";

export interface TrustReceipt {
  schemaId: "rwaix.receipt.v1";
  protocolVersion: "rwaix-0.1.0";
  receiptId: string;
  contextDigest: string;
  policyDigest: string;
  decisionRef: string;
  evidenceRoot: string;
  objectVersion: string;
  statusSnapshotRef: string;
  stateReference: string;
  evaluatedAt: string;
  validUntil: string;
  predicateResults: PolicyDecision["predicateResults"];
  decision: PolicyDecision["decision"];
  reasonCodes: string[];
  verifierRef: string;
}

export interface IssuedReceipt {
  decision: PolicyDecision;
  receipt: TrustReceipt;
  proof: string;
}

export function issueReceipt(input: EvaluationInput, verifier: P256Key): IssuedReceipt {
  const evaluated = evaluatePolicy(input);
  if (!evaluated.ok) throw new ProtocolError(evaluated.error, evaluated.message);
  const decision = evaluated.decision;
  const receipt: TrustReceipt = {
    schemaId: "rwaix.receipt.v1",
    protocolVersion: "rwaix-0.1.0",
    receiptId: `rcpt-${decision.decisionId.slice("sha256:".length, "sha256:".length + 32)}`,
    contextDigest: digestPrefixed(input.context),
    policyDigest: decision.ruleSetDigest,
    decisionRef: decision.decisionId,
    evidenceRoot: digestPrefixed(input.graph),
    objectVersion: input.context.objectRef.bindingVersion,
    statusSnapshotRef: digestPrefixed(input.statusSnapshot),
    stateReference: input.statusSnapshot.snapshotId,
    evaluatedAt: input.evaluationTime,
    validUntil: input.context.deadline,
    predicateResults: decision.predicateResults,
    decision: decision.decision,
    reasonCodes: decision.reasonCodes,
    verifierRef: verifier.publicRef,
  };
  return { decision, receipt, proof: signJws(verifier, receipt) };
}

export interface ReceiptCheck {
  signer: string;
  policyDigest: string;
  replayed: boolean;
}

export function verifyReceipt(input: {
  receipt: TrustReceipt;
  proof: string;
  expectedPolicyDigest?: string;
  replay?: EvaluationInput;
}): ReceiptCheck {
  const signer = verifyJws(input.proof, input.receipt);
  if (signer !== input.receipt.verifierRef) throw new ProtocolError("SIGNATURE_INVALID", "verifier key does not match verifierRef");
  if (input.receipt.decision === "ALLOW" && input.receipt.reasonCodes.some((code) => ["STATUS_REVOKED", "STATUS_EXPIRED", "STATUS_SUSPENDED", "DEADLINE_PASSED"].includes(code))) {
    throw new ProtocolError("STATE_CONFLICT", "revoked, expired, or suspended reasons cannot be ALLOW");
  }
  if (input.expectedPolicyDigest && input.expectedPolicyDigest !== input.receipt.policyDigest) {
    throw new ProtocolError("POLICY_DIGEST_MISMATCH", "receipt is pinned to a different policy digest");
  }
  if (!input.replay) return { signer, policyDigest: input.receipt.policyDigest, replayed: false };
  const replayed = evaluatePolicy(input.replay);
  if (!replayed.ok) throw new ProtocolError(replayed.error, replayed.message);
  const same =
    replayed.decision.decision === input.receipt.decision &&
    canonicalStringify(replayed.decision.reasonCodes) === canonicalStringify(input.receipt.reasonCodes) &&
    canonicalStringify(replayed.decision.predicateResults) === canonicalStringify(input.receipt.predicateResults) &&
    replayed.decision.ruleSetDigest === input.receipt.policyDigest &&
    replayed.decision.decisionId === input.receipt.decisionRef;
  if (!same) throw new ProtocolError("DECISION_MISMATCH", "independent replay did not reproduce the receipt");
  return { signer, policyDigest: input.receipt.policyDigest, replayed: true };
}
