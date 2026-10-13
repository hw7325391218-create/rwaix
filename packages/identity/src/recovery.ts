import { ProtocolError, type Clock } from "@rwaix/protocol";

export interface RecoveryPolicy {
  accountId: string;
  controller: string;
  guardians: string[];
  threshold: number;
  delaySeconds: number;
  controllerVersion: number;
}

interface RecoveryRequest {
  requestId: string;
  accountId: string;
  proposedController: string;
  approvals: string[];
  requestedAt: string;
  executeAfter: string;
  status: "PENDING" | "FROZEN" | "EXECUTED" | "CANCELLED";
  notices: string[];
}

/**
 * Section 12 account recovery: threshold guardians, a delay, a notice,
 * and a dispute freeze. Executing a recovery rotates the controller version.
 * It does not restore revoked credentials and it does not move assets.
 */
export class AccountRecovery {
  private readonly policies = new Map<string, RecoveryPolicy>();
  private readonly requests = new Map<string, RecoveryRequest>();
  private readonly revoked = new Set<string>();

  constructor(private readonly clock: Clock) {}

  register(policy: Omit<RecoveryPolicy, "controllerVersion">): RecoveryPolicy {
    if (policy.threshold < 1 || policy.threshold > policy.guardians.length) {
      throw new ProtocolError("SCHEMA_INVALID", "recovery threshold");
    }
    if (new Set(policy.guardians).size !== policy.guardians.length) throw new ProtocolError("SCHEMA_INVALID", "duplicate guardian");
    const stored: RecoveryPolicy = { ...policy, guardians: [...policy.guardians], controllerVersion: 1 };
    this.policies.set(policy.accountId, stored);
    return stored;
  }

  revokeCredential(credentialId: string): void {
    this.revoked.add(credentialId);
  }

  isRevoked(credentialId: string): boolean {
    return this.revoked.has(credentialId);
  }

  propose(requestId: string, accountId: string, proposedController: string, guardian: string): RecoveryRequest {
    const policy = this.must(accountId);
    if (!policy.guardians.includes(guardian)) throw new ProtocolError("UNAUTHORIZED", "not a guardian");
    if (this.requests.has(requestId)) throw new ProtocolError("STATE_CONFLICT", "recovery request exists");
    const requestedAt = this.clock.now();
    const request: RecoveryRequest = {
      requestId,
      accountId,
      proposedController,
      approvals: [guardian],
      requestedAt,
      executeAfter: addSeconds(requestedAt, policy.delaySeconds),
      status: "PENDING",
      notices: [`notice:${policy.controller}:${requestedAt}`],
    };
    this.requests.set(requestId, request);
    return request;
  }

  approve(requestId: string, guardian: string): RecoveryRequest {
    const request = this.mustRequest(requestId);
    if (request.status !== "PENDING") throw new ProtocolError("STATE_CONFLICT", request.status);
    const policy = this.must(request.accountId);
    if (!policy.guardians.includes(guardian)) throw new ProtocolError("UNAUTHORIZED", "not a guardian");
    if (!request.approvals.includes(guardian)) request.approvals.push(guardian);
    return request;
  }

  freeze(requestId: string, actor: string): RecoveryRequest {
    const request = this.mustRequest(requestId);
    const policy = this.must(request.accountId);
    if (actor !== policy.controller && !policy.guardians.includes(actor)) throw new ProtocolError("UNAUTHORIZED");
    if (request.status === "EXECUTED") throw new ProtocolError("STATE_CONFLICT", "executed recovery cannot be frozen");
    request.status = "FROZEN";
    request.notices.push(`frozen:${actor}:${this.clock.now()}`);
    return request;
  }

  removeGuardian(accountId: string, guardian: string, controller: string): RecoveryPolicy {
    const policy = this.must(accountId);
    if (controller !== policy.controller) throw new ProtocolError("UNAUTHORIZED", "only the controller removes a guardian");
    policy.guardians = policy.guardians.filter((item) => item !== guardian);
    if (policy.threshold > policy.guardians.length) policy.threshold = policy.guardians.length;
    for (const request of this.requests.values()) {
      if (request.accountId === accountId && request.status === "PENDING") {
        request.approvals = request.approvals.filter((item) => item !== guardian);
      }
    }
    return policy;
  }

  execute(requestId: string): { controller: string; previousController: string; controllerVersion: number; assetsMoved: false; credentialsRestored: false } {
    const request = this.mustRequest(requestId);
    if (request.status === "FROZEN") throw new ProtocolError("STATE_CONFLICT", "recovery is frozen");
    if (request.status !== "PENDING") throw new ProtocolError("STATE_CONFLICT", request.status);
    const policy = this.must(request.accountId);
    const approvals = request.approvals.filter((item) => policy.guardians.includes(item));
    if (approvals.length < policy.threshold) throw new ProtocolError("UNAUTHORIZED", "threshold not met");
    if (this.clock.now() < request.executeAfter) throw new ProtocolError("STATE_CONFLICT", "recovery delay has not elapsed");
    const previousController = policy.controller;
    policy.controller = request.proposedController;
    policy.controllerVersion += 1;
    request.status = "EXECUTED";
    return {
      controller: policy.controller,
      previousController,
      controllerVersion: policy.controllerVersion,
      assetsMoved: false,
      credentialsRestored: false,
    };
  }

  view(accountId: string): RecoveryPolicy {
    return this.must(accountId);
  }

  private must(accountId: string): RecoveryPolicy {
    const policy = this.policies.get(accountId);
    if (!policy) throw new ProtocolError("NOT_FOUND", accountId);
    return policy;
  }

  private mustRequest(requestId: string): RecoveryRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new ProtocolError("NOT_FOUND", requestId);
    return request;
  }
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString().slice(0, 19) + "Z";
}
