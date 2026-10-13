import { BudgetLedger } from "@rwaix/agent";
import { verifySelectiveDisclosure } from "@rwaix/disclosure";
import { NetworkLedger, RightsLedger, type RightsBindingRecord } from "@rwaix/economics";
import { verifyStatusList, type StatusListCredential, type StatusPurpose } from "@rwaix/status-list";
import type { EvaluationInput, PolicyDecision } from "@rwaix/policy-engine";
import {
  ManualClock,
  ProtocolError,
  SERVICE_AUDIENCE,
  buildSigningEnvelope,
  digestPrefixed,
  isProtocolError,
  secondsBetween,
  validateBySchemaId,
  verifyJws,
  type ActionName,
  type Clock,
  type P256Key,
  type Result,
  type SignedRequest,
} from "@rwaix/protocol";
import { issueReceipt, verifyReceipt, type TrustReceipt } from "@rwaix/verifier";
import { TradeBook, type AcceptanceBody, type DisputeBody, type TradeEnvelope, type TradeEvent } from "./trade.js";

export type Role = "REGISTRAR" | "EXECUTOR" | "TREASURY" | "SLASHER" | "BOND_RELEASE" | "REWARD_APPROVER" | "STATUS_ADMIN";

interface ObjectRecord {
  objectId: string;
  objectType: string;
  controller: string;
  subjectRef?: string;
  lifecyclePolicy: string;
  lifecycleState: "DRAFT" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "RETIRED";
  bindingVersion: string;
  metadataDigest: string;
  tokenBalanceChecked: false;
}

interface VersionRecord {
  bindingVersion: string;
  contentDigest: string;
  metadataDigest: string;
  subjectBinding?: string;
  rightsDescriptorRef?: string;
  chainId?: string;
  contractAddress?: string;
  tokenId?: string;
  recordedAt: string;
}

interface StatusRecord {
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
  updatedAt: string;
}

interface StoredReceipt {
  receipt: TrustReceipt;
  proof: string;
  decision: PolicyDecision;
  input: EvaluationInput;
}

interface IntentRecord {
  intentId: string;
  receiptId: string;
  action: string;
  payer: string;
  payee: string;
  assetId: string;
  amount: string;
  obligationId: string;
  intentNonce: string;
  deadline: string;
  state: "PREPARED" | "SUBMITTED" | "OUTCOME_UNKNOWN" | "EXECUTED" | "FAILED_CONFIRMED";
  inclusion: "NONE" | "SUBMITTED" | "INCLUDED" | "FINAL" | "REORGED";
  paymentAttemptId: string;
  agentGrantId?: string;
}

const LIFECYCLE: Record<ObjectRecord["lifecycleState"], ObjectRecord["lifecycleState"][]> = {
  DRAFT: ["ACTIVE", "RETIRED"],
  ACTIVE: ["SUSPENDED", "REVOKED", "RETIRED"],
  SUSPENDED: ["ACTIVE", "REVOKED", "RETIRED"],
  REVOKED: [],
  RETIRED: [],
};

export class ReferenceService {
  readonly network = new NetworkLedger();
  readonly rights = new RightsLedger();
  readonly audience: string;
  private readonly objects = new Map<string, ObjectRecord>();
  private readonly versions = new Map<string, Map<string, VersionRecord>>();
  private readonly evidence = new Map<string, unknown>();
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly intents = new Map<string, IntentRecord>();
  private readonly intentNonces = new Set<string>();
  private readonly status = new Map<string, StatusRecord>();
  private readonly roles = new Map<string, Set<Role>>();
  private readonly idem = new Map<string, { digest: string; value: unknown; recordedAt: string }>();
  private readonly nonces = new Set<string>();
  private readonly balances = { dcnft: new Map<string, bigint>(), rwaix: new Map<string, bigint>() };
  private readonly notedProofs = new Set<string>();
  readonly budgets = new BudgetLedger();
  private readonly trades: TradeBook;
  private readonly clockValue: Clock;

  constructor(private readonly opts: { clock?: Clock; verifier: P256Key; audience?: string; grants?: Array<{ signer: string; role: Role }> }) {
    this.audience = opts.audience ?? SERVICE_AUDIENCE;
    this.clockValue = opts.clock ?? new ManualClock("2026-10-11T00:00:00Z");
    this.trades = new TradeBook(this.clockValue, this.network);
    for (const grant of opts.grants ?? []) this.grant(grant.signer, grant.role);
  }

  grant(signer: string, role: Role): void {
    const set = this.roles.get(signer) ?? new Set<Role>();
    set.add(role);
    this.roles.set(signer, set);
  }

  /** Open participation path. Token balances are reported and are not a gate. */
  accessPath(signer: string): { allowed: true; holdsDcnft: boolean; holdsRwaix: boolean } {
    return {
      allowed: true,
      holdsDcnft: (this.balances.dcnft.get(signer) ?? 0n) > 0n,
      holdsRwaix: (this.balances.rwaix.get(signer) ?? 0n) > 0n,
    };
  }

  noteBalance(kind: "dcnft" | "rwaix", signer: string, amount: bigint): void {
    this.balances[kind].set(signer, amount);
  }

  registerObject(signed: SignedRequest): Result<ObjectRecord> {
    return this.mutate("registerObject", "rwaix.request.registerObject.v1", signed, (signer, request) => {
      if (request.controller !== signer && !this.has(signer, "REGISTRAR")) throw new ProtocolError("UNAUTHORIZED");
      if (this.objects.has(String(request.objectId))) throw new ProtocolError("STATE_CONFLICT", "object exists");
      const record: ObjectRecord = {
        objectId: String(request.objectId),
        objectType: String(request.objectType),
        controller: String(request.controller),
        ...(request.subjectRef ? { subjectRef: String(request.subjectRef) } : {}),
        lifecyclePolicy: String(request.lifecyclePolicy),
        lifecycleState: "DRAFT",
        bindingVersion: "0",
        metadataDigest: String(request.metadataDigest),
        tokenBalanceChecked: false,
      };
      this.objects.set(record.objectId, record);
      this.versions.set(record.objectId, new Map());
      return record;
    });
  }

  publishVersion(signed: SignedRequest): Result<VersionRecord & { lifecycleState: string }> {
    return this.mutate("publishVersion", "rwaix.request.publishVersion.v1", signed, (signer, request) => {
      const object = this.mustObject(String(request.objectId));
      if (signer !== object.controller && !this.has(signer, "REGISTRAR")) throw new ProtocolError("UNAUTHORIZED");
      const version = String(request.bindingVersion);
      const expected = String(BigInt(object.bindingVersion) + 1n);
      if (version !== expected) throw new ProtocolError("STATE_CONFLICT", `next bindingVersion is ${expected}`);
      const versions = this.versions.get(object.objectId);
      if (!versions || versions.has(version)) throw new ProtocolError("STATE_CONFLICT", "version already published");
      const transition = request.lifecycleTransition as ObjectRecord["lifecycleState"] | undefined;
      if (transition) {
        if (transition === "REVOKED" && !this.has(signer, "STATUS_ADMIN")) throw new ProtocolError("UNAUTHORIZED");
        if (!LIFECYCLE[object.lifecycleState].includes(transition)) throw new ProtocolError("LIFECYCLE_TERMINAL", `${object.lifecycleState} -> ${transition}`);
        object.lifecycleState = transition;
      } else if (object.lifecycleState === "DRAFT") {
        object.lifecycleState = "ACTIVE";
      } else if (object.lifecycleState === "REVOKED" || object.lifecycleState === "RETIRED") {
        throw new ProtocolError("LIFECYCLE_TERMINAL", object.lifecycleState);
      }
      const stored: VersionRecord = {
        bindingVersion: version,
        contentDigest: String(request.contentDigest),
        metadataDigest: String(request.metadataDigest),
        recordedAt: this.clock().now(),
        ...(request.subjectBinding ? { subjectBinding: String(request.subjectBinding) } : {}),
        ...(request.rightsDescriptorRef ? { rightsDescriptorRef: String(request.rightsDescriptorRef) } : {}),
        ...(request.chainId ? { chainId: String(request.chainId) } : {}),
        ...(request.contractAddress ? { contractAddress: String(request.contractAddress) } : {}),
        ...(request.tokenId ? { tokenId: String(request.tokenId) } : {}),
      };
      versions.set(version, stored);
      object.bindingVersion = version;
      object.metadataDigest = stored.metadataDigest;
      return { ...stored, lifecycleState: object.lifecycleState };
    });
  }

  resolveBinding(signed: SignedRequest): Result<Record<string, unknown>> {
    return this.mutate("resolveBinding", "rwaix.request.resolveBinding.v1", signed, (_signer, request) => {
      const object = this.mustObject(String(request.objectId));
      const version = String(request.bindingVersion ?? object.bindingVersion);
      const stored = this.versions.get(object.objectId)?.get(version);
      if (!stored) throw new ProtocolError("NOT_FOUND", version);
      return { ...object, version: stored };
    });
  }

  submitEvidence(signed: SignedRequest): Result<{ evidenceId: string; evidenceRoot: string }> {
    return this.mutate("submitEvidence", "rwaix.request.submitEvidence.v1", signed, (_signer, request) => {
      const credential = request.credential as { proof?: string; claims?: unknown; claimsDigest?: string; issuer?: string } | undefined;
      if (credential?.proof) {
        const body = { ...credential };
        delete body.proof;
        const kid = verifyJws(credential.proof, body);
        if (credential.issuer?.startsWith("p256:") && credential.issuer !== kid) {
          throw new ProtocolError("SIGNATURE_INVALID", "credential issuer does not match the proof key");
        }
      }
      if (credential?.claims) {
        if (digestPrefixed(credential.claims) !== credential.claimsDigest) {
          throw new ProtocolError("SCHEMA_INVALID", "claimsDigest mismatch");
        }
      }
      if (typeof request.selectiveDisclosure === "string") {
        const presented = verifySelectiveDisclosure(request.selectiveDisclosure);
        const claims = credential?.claims as Record<string, unknown> | undefined;
        if (claims) {
          for (const [key, value] of Object.entries(presented.claims)) {
            if (claims[key] !== value) throw new ProtocolError("SCHEMA_INVALID", `disclosed claim ${key} does not match the credential`);
          }
        }
      }
      if (request.zkProof) {
        const digest = digestPrefixed(request.zkProof);
        if (!this.notedProofs.has(digest)) throw new ProtocolError("SIGNATURE_INVALID", "zk proof was not verified");
      }
      const evidenceId = String(request.evidenceId);
      if (this.evidence.has(evidenceId)) throw new ProtocolError("STATE_CONFLICT", "evidence exists");
      this.evidence.set(evidenceId, request.graph);
      return { evidenceId, evidenceRoot: digestPrefixed(request.graph) };
    });
  }

  evaluatePolicy(signed: SignedRequest): Result<{ decision: PolicyDecision; receipt: TrustReceipt; proof: string }> {
    return this.mutate("evaluatePolicy", "rwaix.request.evaluatePolicy.v1", signed, (_signer, request) => {
      const input = this.evaluationInput(request);
      const object = this.mustObject(input.context.objectRef.objectId);
      if (!this.versions.get(object.objectId)?.has(input.context.objectRef.bindingVersion)) {
        throw new ProtocolError("NOT_FOUND", "object version");
      }
      const issued = issueReceipt(input, this.opts.verifier);
      validateBySchemaId("rwaix.receipt.v1", issued.receipt);
      validateBySchemaId("rwaix.decision.v1", issued.decision);
      this.receipts.set(issued.receipt.receiptId, { ...issued, input });
      return issued;
    });
  }

  verifyReceipt(signed: SignedRequest): Result<Record<string, unknown>> {
    return this.mutate("verifyReceipt", "rwaix.request.verifyReceipt.v1", signed, (_signer, request) => {
      const receipt = request.receipt as unknown as TrustReceipt;
      const replayRequest = request.replay as Record<string, unknown> | undefined;
      const checked = verifyReceipt({
        receipt,
        proof: String(request.receiptProof),
        ...(request.expectedPolicyDigest ? { expectedPolicyDigest: String(request.expectedPolicyDigest) } : {}),
        ...(replayRequest ? { replay: this.evaluationInput(replayRequest) } : {}),
      });
      if (typeof request.selectiveDisclosure === "string") verifySelectiveDisclosure(request.selectiveDisclosure);
      if (request.zkProof && !this.notedProofs.has(digestPrefixed(request.zkProof))) {
        throw new ProtocolError("SIGNATURE_INVALID", "zk proof was not verified");
      }
      return { ...checked, decision: receipt.decision, reasonCodes: receipt.reasonCodes, policyDigest: receipt.policyDigest };
    });
  }

  checkStatus(signed: SignedRequest): Result<Record<string, unknown>> {
    return this.mutate("checkStatus", "rwaix.request.checkStatus.v1", signed, (_signer, request) => {
      if (!request.subjectRef && !request.objectId) throw new ProtocolError("SCHEMA_INVALID", "subjectRef or objectId is required");
      const result: Record<string, unknown> = { atTime: request.atTime, determinate: true };
      if (request.objectId) {
        const object = this.objects.get(String(request.objectId));
        if (!object) {
          result.objectStatus = "UNKNOWN";
          result.determinate = false;
          result.reason = "STATUS_UNAVAILABLE";
        } else {
          result.objectStatus = object.lifecycleState;
          result.bindingVersion = object.bindingVersion;
        }
      }
      if (request.subjectRef) {
        const subjectRef = String(request.subjectRef);
        const snapshot = request.snapshot as { entries?: Array<{ subjectRef: string; status: string }> } | undefined;
        const entry = snapshot
          ? snapshot.entries?.find((item) => item.subjectRef === subjectRef)
          : this.status.get(subjectRef);
        if (!entry) {
          result.subjectStatus = "UNKNOWN";
          result.determinate = false;
          result.reason = "STATUS_UNAVAILABLE";
        } else {
          result.subjectStatus = entry.status;
          if (entry.status === "REVOKED" || entry.status === "SUSPENDED" || entry.status === "EXPIRED") {
            result.determinate = true;
            result.reason = entry.status;
          }
        }
      }
      if (request.statusList && request.statusProof && request.statusIndex && request.statusPurpose) {
        const listed = verifyStatusList({
          credential: request.statusList as StatusListCredential,
          proof: String(request.statusProof),
          index: Number(request.statusIndex),
          purpose: String(request.statusPurpose) as StatusPurpose,
          atTime: String(request.atTime),
          trustedIssuers: Array.isArray(request.trustedIssuers) ? request.trustedIssuers.map(String) : [],
        });
        result.listBit = listed.bit;
        result.listStatus = listed.status;
        if (listed.status !== "ACTIVE") {
          result.subjectStatus = listed.status;
          result.determinate = true;
          result.reason = listed.status;
        }
      }
      result.decision = "NOT_A_TRUST_DECISION";
      return result;
    });
  }

  prepareIntent(signed: SignedRequest): Result<IntentRecord> {
    return this.mutate("prepareIntent", "rwaix.request.prepareIntent.v1", signed, (signer, request) => {
      if (!this.has(signer, "EXECUTOR")) throw new ProtocolError("UNAUTHORIZED");
      const stored = this.receipts.get(String(request.receiptId));
      if (!stored) throw new ProtocolError("NOT_FOUND", "receipt");
      verifyReceipt({ receipt: stored.receipt, proof: stored.proof });
      if (stored.receipt.decision !== "ALLOW") throw new ProtocolError("STATE_CONFLICT", "execution requires ALLOW");
      const now = this.clock().now();
      if (now > stored.receipt.validUntil || now > String(request.intentDeadline)) throw new ProtocolError("EXPIRED");
      const object = this.mustObject(stored.input.context.objectRef.objectId);
      if (object.bindingVersion !== stored.receipt.objectVersion) throw new ProtocolError("OBJECT_VERSION_MISMATCH");
      if (object.lifecycleState === "REVOKED") throw new ProtocolError("REVOKED");
      if (object.lifecycleState === "SUSPENDED") throw new ProtocolError("SUSPENDED");
      if (object.lifecycleState !== "ACTIVE") throw new ProtocolError("STATE_CONFLICT", object.lifecycleState);
      const subjectRef = stored.input.context.subjectRef;
      if (!subjectRef) throw new ProtocolError("STATUS_UNAVAILABLE");
      const current = this.status.get(subjectRef);
      if (!current) throw new ProtocolError("STATUS_UNAVAILABLE");
      if (current.status === "REVOKED") throw new ProtocolError("REVOKED");
      if (current.status === "SUSPENDED") throw new ProtocolError("SUSPENDED");
      if (current.status === "EXPIRED") throw new ProtocolError("EXPIRED");
      const age = secondsBetween(now, current.updatedAt);
      if (age < 0 || age > Number(request.maxStalenessSeconds)) throw new ProtocolError("STATUS_STALE");
      const nonce = String(request.intentNonce);
      if (this.intentNonces.has(nonce)) throw new ProtocolError("NONCE_REUSED");
      const account = this.network.obligations.get(String(request.obligationId));
      if (!account) throw new ProtocolError("NOT_FOUND", "obligation");
      if (!account.authorized) throw new ProtocolError("UNAUTHORIZED", "obligation is not authorized for payment");
      const intent: IntentRecord = {
        intentId: String(request.intentId),
        receiptId: String(request.receiptId),
        action: String(request.action),
        payer: String(request.payer),
        payee: String(request.payee),
        assetId: String(request.assetId),
        amount: String(request.amount),
        obligationId: String(request.obligationId),
        intentNonce: nonce,
        deadline: String(request.intentDeadline),
        state: "PREPARED",
        inclusion: "NONE",
        paymentAttemptId: `pay-${String(request.intentId)}`,
      };
      if (this.intents.has(intent.intentId)) throw new ProtocolError("STATE_CONFLICT", "intent exists");
      if (request.agentGrantId) {
        if (!request.agentTool) throw new ProtocolError("SCHEMA_INVALID", "agentTool is required with agentGrantId");
        intent.agentGrantId = String(request.agentGrantId);
        this.budgets.reserve({
          grantId: intent.agentGrantId,
          opId: intent.intentId,
          tool: String(request.agentTool),
          payee: intent.payee,
          asset: intent.assetId,
          amount: BigInt(intent.amount),
          now,
          ...(typeof request.untrustedNote === "string" ? { note: request.untrustedNote } : {}),
        });
      }
      try {
        this.network.reserve({
          obligationId: intent.obligationId,
          paymentAttemptId: intent.paymentAttemptId,
          assetId: intent.assetId,
          amount: intent.amount,
        });
      } catch (error) {
        if (intent.agentGrantId) this.budgets.release(intent.intentId);
        throw error;
      }
      this.intentNonces.add(nonce);
      this.intents.set(intent.intentId, intent);
      return intent;
    });
  }

  executeIntent(signed: SignedRequest): Result<IntentRecord> {
    return this.mutate("executeIntent", "rwaix.request.executeIntent.v1", signed, (signer, request) => {
      if (!this.has(signer, "EXECUTOR")) throw new ProtocolError("UNAUTHORIZED");
      const intent = this.intents.get(String(request.intentId));
      if (!intent) throw new ProtocolError("NOT_FOUND", "intent");
      const inclusion = String(request.inclusion);
      if (inclusion === "REORGED") {
        intent.inclusion = "REORGED";
        intent.state = "PREPARED";
        throw new ProtocolError("CHAIN_EVENT_REORGED", "reorged operation is re-checked and is not treated as final");
      }
      if (inclusion !== "FINAL") {
        intent.inclusion = inclusion === "INCLUDED" ? "INCLUDED" : "SUBMITTED";
        throw new ProtocolError("FINALITY_NOT_REACHED", "authorization waits for the configured finality condition");
      }
      if (intent.state !== "PREPARED" && intent.state !== "OUTCOME_UNKNOWN") {
        throw new ProtocolError("STATE_CONFLICT", intent.state);
      }
      intent.inclusion = "FINAL";
      const mode = String(request.mode);
      if (mode === "TIMEOUT") {
        this.network.markUnknown(intent.paymentAttemptId);
        if (intent.agentGrantId) this.budgets.markUnknown(intent.intentId);
        intent.state = "OUTCOME_UNKNOWN";
        return intent;
      }
      if (mode === "FAIL_CONFIRMED") {
        this.network.confirmFailed(intent.paymentAttemptId);
        if (intent.agentGrantId) this.budgets.release(intent.intentId);
        intent.state = "FAILED_CONFIRMED";
        return intent;
      }
      if (mode === "CONFIRM") {
        this.network.confirmExecution(intent.paymentAttemptId);
        if (intent.agentGrantId) this.budgets.confirm(intent.intentId);
        intent.state = "EXECUTED";
        return intent;
      }
      throw new ProtocolError("SCHEMA_INVALID", "mode");
    });
  }

  setStatus(signed: SignedRequest): Result<StatusRecord> {
    return this.mutate("setStatus", "rwaix.request.setStatus.v1", signed, (signer, request) => {
      if (!this.has(signer, "STATUS_ADMIN")) throw new ProtocolError("UNAUTHORIZED");
      const subjectRef = String(request.subjectRef);
      const next = String(request.status) as StatusRecord["status"];
      const prev = this.status.get(subjectRef);
      if (prev && (prev.status === "REVOKED" || prev.status === "EXPIRED") && prev.status !== next) {
        throw new ProtocolError("LIFECYCLE_TERMINAL", `${prev.status} does not return to ${next}`);
      }
      const record = { status: next, updatedAt: this.clock().now() };
      this.status.set(subjectRef, record);
      return record;
    });
  }

  trade(signed: SignedRequest): Result<Record<string, unknown>> {
    return this.mutate("trade", "rwaix.request.trade.v1", signed, (signer, request) => {
      const op = String(request.op);
      if (op === "OPEN") {
        if (!request.envelope) throw new ProtocolError("SCHEMA_INVALID", "envelope is required");
        return this.trades.open(request.envelope as TradeEnvelope);
      }
      if (op === "EVENT") {
        if (!request.event) throw new ProtocolError("SCHEMA_INVALID", "event is required");
        return this.trades.submit(request.event as TradeEvent, signer);
      }
      if (op === "ACCEPT") {
        if (!request.acceptance) throw new ProtocolError("SCHEMA_INVALID", "acceptance is required");
        return this.trades.accept(request.acceptance as AcceptanceBody, signer);
      }
      if (op === "DISPUTE") {
        if (!request.dispute) throw new ProtocolError("SCHEMA_INVALID", "dispute is required");
        return this.trades.dispute(request.dispute as DisputeBody, signer);
      }
      if (op === "AUTHORIZE") {
        if (!request.obligationId) throw new ProtocolError("SCHEMA_INVALID", "obligationId is required");
        return this.trades.authorize(String(request.obligationId), this.has(signer, "TREASURY"));
      }
      if (op === "RECONCILE") {
        if (!this.has(signer, "TREASURY")) throw new ProtocolError("UNAUTHORIZED");
        const attempt = this.network.attribute(String(request.paymentAttemptId));
        return { fundsReceiptState: attempt.fundsReceiptState, dischargeState: attempt.dischargeState, instructionState: attempt.instructionState };
      }
      if (op === "APPLY") {
        if (!this.has(signer, "TREASURY")) throw new ProtocolError("UNAUTHORIZED");
        const attempt = this.network.discharge(String(request.paymentAttemptId));
        return { dischargeState: attempt.dischargeState, fundsReceiptState: attempt.fundsReceiptState, instructionState: attempt.instructionState };
      }
      if (op === "SWEEP") return this.trades.sweep();
      throw new ProtocolError("SCHEMA_INVALID", op);
    });
  }

  agent(signed: SignedRequest): Result<unknown> {
    return this.mutate("agent", "rwaix.request.agent.v1", signed, (signer, request) => {
      const op = String(request.op);
      if (op === "OPEN") {
        const grant = request.grant as Record<string, unknown>;
        return this.budgets.open({
          grantId: String(grant.grantId),
          controller: signer,
          agent: String(grant.agent),
          tools: asStrings(grant.tools),
          payees: asStrings(grant.payees),
          assets: asStrings(grant.assets),
          cap: BigInt(String(grant.cap)),
          expiry: String(grant.expiry),
          allowRedelegate: grant.allowRedelegate === true,
        });
      }
      if (op === "DELEGATE") {
        const grant = request.grant as Record<string, unknown>;
        const parent = this.budgets.view(String(request.parentId));
        if (signer !== parent.agent && signer !== parent.controller) throw new ProtocolError("UNAUTHORIZED", "delegation signer");
        return this.budgets.delegate(String(request.parentId), {
          grantId: String(grant.grantId),
          agent: String(grant.agent),
          tools: asStrings(grant.tools),
          payees: asStrings(grant.payees),
          assets: asStrings(grant.assets),
          cap: BigInt(String(grant.cap)),
          expiry: String(grant.expiry),
          allowRedelegate: grant.allowRedelegate === true,
        });
      }
      if (op === "FREEZE") {
        this.budgets.freeze(String(request.grantId), signer);
        return { frozen: true };
      }
      throw new ProtocolError("SCHEMA_INVALID", op);
    });
  }

  noteProof(digest: string): void {
    this.notedProofs.add(digest);
  }

  toJSON(): unknown {
    return {
      stateVersion: 1,
      objects: [...this.objects.values()],
      versions: [...this.versions].map(([objectId, versions]) => [objectId, [...versions.values()]]),
      evidence: [...this.evidence],
      receipts: [...this.receipts],
      intents: [...this.intents.values()],
      intentNonces: [...this.intentNonces],
      status: [...this.status],
      roles: [...this.roles].map(([signer, roles]) => [signer, [...roles]]),
      idem: [...this.idem],
      nonces: [...this.nonces],
      balances: {
        dcnft: [...this.balances.dcnft].map(([key, value]) => [key, value.toString()]),
        rwaix: [...this.balances.rwaix].map(([key, value]) => [key, value.toString()]),
      },
      notedProofs: [...this.notedProofs],
      network: this.network.toJSON(),
      rights: this.rights.exportRights(),
      trades: this.trades.toJSON(),
      budgets: this.budgets.toJSON(),
    };
  }

  loadJSON(raw: {
    objects: ObjectRecord[];
    versions: Array<[string, VersionRecord[]]>;
    evidence: Array<[string, unknown]>;
    receipts: Array<[string, StoredReceipt]>;
    intents: IntentRecord[];
    intentNonces: string[];
    status: Array<[string, StatusRecord]>;
    roles: Array<[string, Role[]]>;
    idem: Array<[string, { digest: string; value: unknown; recordedAt: string }]>;
    nonces: string[];
    balances: { dcnft: Array<[string, string]>; rwaix: Array<[string, string]> };
    notedProofs: string[];
    network: ReturnType<NetworkLedger["toJSON"]>;
    rights: RightsBindingRecord[];
    trades: Parameters<TradeBook["loadJSON"]>[0];
    budgets: Parameters<BudgetLedger["loadJSON"]>[0];
  }): void {
    this.objects.clear();
    this.versions.clear();
    this.evidence.clear();
    this.receipts.clear();
    this.intents.clear();
    this.intentNonces.clear();
    this.status.clear();
    this.roles.clear();
    this.idem.clear();
    this.nonces.clear();
    this.balances.dcnft.clear();
    this.balances.rwaix.clear();
    this.notedProofs.clear();
    for (const object of raw.objects) this.objects.set(object.objectId, object);
    for (const [objectId, versions] of raw.versions) this.versions.set(objectId, new Map(versions.map((version) => [version.bindingVersion, version])));
    for (const [id, value] of raw.evidence) this.evidence.set(id, value);
    for (const [id, value] of raw.receipts) this.receipts.set(id, value);
    for (const intent of raw.intents) this.intents.set(intent.intentId, intent);
    for (const nonce of raw.intentNonces) this.intentNonces.add(nonce);
    for (const [id, value] of raw.status) this.status.set(id, value);
    for (const [signer, roles] of raw.roles) this.roles.set(signer, new Set(roles));
    for (const [id, value] of raw.idem) this.idem.set(id, value);
    for (const nonce of raw.nonces) this.nonces.add(nonce);
    for (const [key, value] of raw.balances.dcnft) this.balances.dcnft.set(key, BigInt(value));
    for (const [key, value] of raw.balances.rwaix) this.balances.rwaix.set(key, BigInt(value));
    for (const digest of raw.notedProofs) this.notedProofs.add(digest);
    this.network.loadJSON(raw.network);
    this.rights.loadJSON(raw.rights);
    this.trades.loadJSON(raw.trades);
    this.budgets.loadJSON(raw.budgets);
  }

  tradeView(tradeId: string) {
    return this.trades.view(tradeId);
  }

  bindRights(signer: string, record: RightsBindingRecord): void {
    if (!this.has(signer, "REGISTRAR")) throw new ProtocolError("UNAUTHORIZED");
    const object = this.mustObject(record.objectId);
    if (object.objectType !== "DCNFT_SERIES") throw new ProtocolError("FEE_RIGHT_MISMATCH", "only a DCNFT_SERIES object can carry a series binding");
    validateBySchemaId("rwaix.rights.binding.v1", {
      schemaId: "rwaix.rights.binding.v1",
      ...record,
      transferRestriction: "DISABLED",
    });
    this.rights.bind(record);
  }

  exportLedgers() {
    return {
      objects: [...this.objects.values()],
      evidenceIds: [...this.evidence.keys()],
      rights: this.rights.exportRights(),
      network: this.network.exportNetwork(),
    };
  }

  private evaluationInput(request: Record<string, unknown>): EvaluationInput {
    return {
      context: request.context as EvaluationInput["context"],
      policy: request.policy as EvaluationInput["policy"],
      graph: request.graph as EvaluationInput["graph"],
      statusSnapshot: request.statusSnapshot as EvaluationInput["statusSnapshot"],
      terms: request.terms as Record<string, string>,
      evaluationTime: String(request.evaluationTime),
      startedAtMs: Number(request.startedAtMs),
      nowMs: Number(request.nowMs),
    };
  }

  private mutate<T>(action: ActionName, schemaId: string, signed: SignedRequest, fn: (signer: string, request: Record<string, unknown>) => T): Result<T> {
    try {
      const { signer, request } = this.authenticate(action, schemaId, signed);
      const idemKey = String(request.idempotencyKey);
      const digest = digestPrefixed(request);
      const slot = `${signer}|${action}|${idemKey}`;
      const prev = this.idem.get(slot);
      if (prev) {
        if (prev.digest !== digest) throw new ProtocolError("IDEMPOTENCY_CONFLICT");
        return { ok: true, value: prev.value as T, recordedAt: prev.recordedAt };
      }
      if (signed.deadline < this.clock().now()) throw new ProtocolError("EXPIRED");
      const nonceSlot = `${signer}|${action}|${signed.nonce}`;
      if (this.nonces.has(nonceSlot)) throw new ProtocolError("NONCE_REUSED");
      this.nonces.add(nonceSlot);
      const value = fn(signer, request);
      const recordedAt = this.clock().now();
      this.idem.set(slot, { digest, value, recordedAt });
      return { ok: true, value, recordedAt };
    } catch (error) {
      if (isProtocolError(error)) return { ok: false, error: error.code, message: error.message };
      throw error;
    }
  }

  private authenticate(action: ActionName, schemaId: string, signed: SignedRequest): { signer: string; request: Record<string, unknown> } {
    validateBySchemaId("rwaix.signed.v1", signed);
    const request = signed.request;
    if (request.schemaId !== schemaId) throw new ProtocolError("SCHEMA_INVALID", "request schemaId does not match the called interface");
    validateBySchemaId(schemaId, request);
    if (signed.audience !== this.audience) throw new ProtocolError("AUDIENCE_MISMATCH");
    const envelope = buildSigningEnvelope({
      action,
      chainId: signed.chainId,
      audience: signed.audience,
      nonce: signed.nonce,
      deadline: signed.deadline,
      request,
    });
    validateBySchemaId("rwaix.signing.v1", envelope);
    return { signer: verifyJws(signed.proof, envelope), request };
  }

  private mustObject(objectId: string): ObjectRecord {
    const object = this.objects.get(objectId);
    if (!object) throw new ProtocolError("NOT_FOUND", objectId);
    return object;
  }

  private has(signer: string, role: Role): boolean {
    return this.roles.get(signer)?.has(role) ?? false;
  }

  private clock(): Clock {
    return this.clockValue;
  }
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ProtocolError("SCHEMA_INVALID", "expected strings");
  return value as string[];
}
