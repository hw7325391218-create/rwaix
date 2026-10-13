import { ProtocolError } from "@rwaix/protocol";

export interface AgentGrant {
  grantId: string;
  controller: string;
  agent: string;
  parentId?: string;
  tools: string[];
  payees: string[];
  assets: string[];
  cap: string;
  delegated: string;
  expiry: string;
  allowRedelegate: boolean;
  frozen: boolean;
}

interface Reservation {
  opId: string;
  grantId: string;
  amount: bigint;
  state: "RESERVED" | "SPENT" | "RELEASED" | "UNKNOWN";
}

interface StoredGrant extends Omit<AgentGrant, "cap" | "delegated"> {
  cap: bigint;
  delegated: bigint;
  spent: bigint;
  reserved: bigint;
}

/**
 * Section 14 constrained agent budget.
 * Child grants can only narrow tools, payees, assets, expiry, and amount.
 * Untrusted text is never read. OUTCOME_UNKNOWN keeps the reservation.
 */
export class BudgetLedger {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly reservations = new Map<string, Reservation>();

  open(input: {
    grantId: string;
    controller: string;
    agent: string;
    tools: string[];
    payees: string[];
    assets: string[];
    cap: bigint;
    expiry: string;
    allowRedelegate: boolean;
  }): AgentGrant {
    if (this.grants.has(input.grantId)) throw new ProtocolError("STATE_CONFLICT", "grant exists");
    if (input.cap < 0n) throw new ProtocolError("SCHEMA_INVALID", "cap");
    const grant: StoredGrant = { ...input, delegated: 0n, spent: 0n, reserved: 0n, frozen: false };
    this.grants.set(input.grantId, grant);
    return this.view(input.grantId);
  }

  delegate(parentId: string, child: {
    grantId: string;
    agent: string;
    tools: string[];
    payees: string[];
    assets: string[];
    cap: bigint;
    expiry: string;
    allowRedelegate: boolean;
  }): AgentGrant {
    const parent = this.must(parentId);
    if (parent.frozen) throw new ProtocolError("STATE_CONFLICT", "grant is frozen");
    if (!parent.allowRedelegate) throw new ProtocolError("UNAUTHORIZED", "parent forbids redelegation");
    if (child.expiry > parent.expiry) throw new ProtocolError("STATE_CONFLICT", "child expiry exceeds the parent");
    if (child.allowRedelegate && !parent.allowRedelegate) throw new ProtocolError("UNAUTHORIZED", "child cannot add redelegation");
    assertSubset(child.tools, parent.tools, "tool");
    assertSubset(child.payees, parent.payees, "payee");
    assertSubset(child.assets, parent.assets, "asset");
    if (child.cap > this.remaining(parent)) throw new ProtocolError("OVERSPEND", "child cap exceeds the parent budget");
    parent.delegated += child.cap;
    this.grants.set(child.grantId, {
      ...child,
      controller: parent.controller,
      parentId,
      delegated: 0n,
      spent: 0n,
      reserved: 0n,
      frozen: false,
    });
    return this.view(child.grantId);
  }

  freeze(grantId: string, controller: string): void {
    const grant = this.must(grantId);
    if (controller !== grant.controller) throw new ProtocolError("UNAUTHORIZED");
    grant.frozen = true;
  }

  /**
   * `note` is untrusted input. It is accepted and ignored so a prompt cannot
   * change the payee, tool, asset, or amount.
   */
  reserve(input: { grantId: string; opId: string; tool: string; payee: string; asset: string; amount: bigint; now: string; note?: string }): void {
    void input.note;
    if (this.reservations.has(input.opId)) throw new ProtocolError("STATE_CONFLICT", "reservation exists");
    const grant = this.must(input.grantId);
    if (grant.frozen) throw new ProtocolError("STATE_CONFLICT", "grant is frozen");
    if (input.now > grant.expiry) throw new ProtocolError("EXPIRED", "agent grant expired");
    if (!grant.tools.includes(input.tool)) throw new ProtocolError("UNAUTHORIZED", "tool is outside the grant");
    if (!grant.payees.includes(input.payee)) throw new ProtocolError("UNAUTHORIZED", "payee is outside the grant");
    if (!grant.assets.includes(input.asset)) throw new ProtocolError("UNAUTHORIZED", "asset is outside the grant");
    if (input.amount < 0n || input.amount > this.remaining(grant)) throw new ProtocolError("OVERSPEND", "agent budget");
    grant.reserved += input.amount;
    this.reservations.set(input.opId, { opId: input.opId, grantId: input.grantId, amount: input.amount, state: "RESERVED" });
  }

  confirm(opId: string): void {
    const reservation = this.mustReservation(opId);
    if (reservation.state === "SPENT") return;
    if (reservation.state !== "RESERVED" && reservation.state !== "UNKNOWN") throw new ProtocolError("STATE_CONFLICT", reservation.state);
    const grant = this.must(reservation.grantId);
    grant.reserved -= reservation.amount;
    grant.spent += reservation.amount;
    reservation.state = "SPENT";
  }

  markUnknown(opId: string): void {
    const reservation = this.mustReservation(opId);
    if (reservation.state !== "RESERVED") throw new ProtocolError("STATE_CONFLICT", reservation.state);
    reservation.state = "UNKNOWN";
  }

  release(opId: string): void {
    const reservation = this.mustReservation(opId);
    if (reservation.state === "RELEASED") return;
    if (reservation.state === "UNKNOWN") throw new ProtocolError("OUTCOME_UNKNOWN", "unknown agent reservation stays in the budget");
    if (reservation.state !== "RESERVED") throw new ProtocolError("STATE_CONFLICT", reservation.state);
    const grant = this.must(reservation.grantId);
    grant.reserved -= reservation.amount;
    reservation.state = "RELEASED";
  }

  view(grantId: string): AgentGrant {
    const grant = this.must(grantId);
    return {
      grantId: grant.grantId,
      controller: grant.controller,
      agent: grant.agent,
      ...(grant.parentId ? { parentId: grant.parentId } : {}),
      tools: [...grant.tools],
      payees: [...grant.payees],
      assets: [...grant.assets],
      cap: grant.cap.toString(),
      delegated: grant.delegated.toString(),
      expiry: grant.expiry,
      allowRedelegate: grant.allowRedelegate,
      frozen: grant.frozen,
    };
  }

  used(grantId: string): bigint {
    const grant = this.must(grantId);
    return grant.spent + grant.reserved + grant.delegated;
  }

  toJSON(): unknown {
    return {
      grants: [...this.grants.values()].map((grant) => ({
        ...this.view(grant.grantId),
        spent: grant.spent.toString(),
        reserved: grant.reserved.toString(),
      })),
      reservations: [...this.reservations.values()].map((item) => ({ ...item, amount: item.amount.toString() })),
    };
  }

  loadJSON(raw: { grants: Array<AgentGrant & { spent: string; reserved: string }>; reservations: Array<Omit<Reservation, "amount"> & { amount: string }> }): void {
    this.grants.clear();
    this.reservations.clear();
    for (const grant of raw.grants) {
      this.grants.set(grant.grantId, {
        ...grant,
        cap: BigInt(grant.cap),
        delegated: BigInt(grant.delegated),
        spent: BigInt(grant.spent),
        reserved: BigInt(grant.reserved),
      });
    }
    for (const item of raw.reservations) {
      this.reservations.set(item.opId, { ...item, amount: BigInt(item.amount) });
    }
  }

  private remaining(grant: StoredGrant): bigint {
    return grant.cap - grant.spent - grant.reserved - grant.delegated;
  }

  private must(grantId: string): StoredGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new ProtocolError("NOT_FOUND", grantId);
    return grant;
  }

  private mustReservation(opId: string): Reservation {
    const reservation = this.reservations.get(opId);
    if (!reservation) throw new ProtocolError("NOT_FOUND", opId);
    return reservation;
  }
}

function assertSubset(child: string[], parent: string[], label: string): void {
  for (const item of child) {
    if (!parent.includes(item)) throw new ProtocolError("UNAUTHORIZED", `${label} ${item} widens the parent grant`);
  }
}
