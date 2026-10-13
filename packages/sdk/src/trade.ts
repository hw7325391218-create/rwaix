import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NetworkLedger } from "@rwaix/economics";
import { ProtocolError, digestPrefixed, schemaDigest, type Clock } from "@rwaix/protocol";

interface ExtensionRow {
  id: string;
  required: boolean;
  profileId: string;
}

const registry = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../schemas/v1/extension-registry.json"), "utf8"),
) as { extensions: ExtensionRow[] };

export interface TradeEnvelope {
  schemaId: "rwaix.trade.envelope.v1";
  protocolVersion: string;
  profileId: string;
  profileVersion: string;
  schemaDigest: string;
  tradeId: string;
  termsDigest: string;
  parties: Array<{ partyId: string; role: string; authorityRef: string }>;
  objects: Array<{ objectId: string; quantity: string; unit: string }>;
  obligations: Array<{
    obligationId: string;
    kind: "SERVICE" | "NETWORK_FEE" | "RIGHTS_DISTRIBUTION" | "NONE";
    amount: string;
    assetId: string;
    decimals: number;
    rounding: "EXACT_INTEGER";
  }>;
  terms?: Record<string, string>;
  extensions?: Record<string, Record<string, unknown>>;
  timeTerms: { effectiveAt: string; deliveryDeadline?: string };
  paymentTerms: { trigger: string };
}

export interface TradeEvent {
  schemaId: "rwaix.trade.event.v1";
  eventId: string;
  tradeId: string;
  obligationApplicable: boolean;
  obligationId?: string;
  eventType: string;
  actor: string;
  authorityRef: string;
  streamId: string;
  sourceId: string;
  prevEventDigest: string;
  sequence: string;
  causalRefs: string[];
  effectiveAt: string;
  recordedAt?: string;
  evidenceRefs: string[];
  signingDomain: "rwaix.signing.v1";
  quantity?: string;
  unit?: string;
  dimension?: string;
  inclusion?: string;
}

export interface AcceptanceBody {
  acceptanceId: string;
  tradeId: string;
  obligationId: string;
  portionId: string;
  objectVersion: string;
  quantity: string;
  unit: string;
  acceptor: string;
  authorityRef: string;
  acceptedAt: string;
}

export interface DisputeBody {
  disputeId: string;
  tradeId: string;
  obligationId: string;
  claimant: string;
  affectedAmount: string;
  assetId: string;
  status: "OPEN" | "RESOLVED";
  evidenceDeadline: string;
}

interface StreamState {
  next: bigint;
  lastDigest: string;
}

interface StoredTrade {
  envelope: TradeEnvelope;
  commitment: "NONE" | "COMMITTED";
  commits: Set<string>;
  fulfillment: "NONE" | "PARTIAL" | "FULFILLED";
  dispute: "NONE" | "OPEN" | "RESOLVED";
  delivered: Map<string, bigint>;
  accepted: Map<string, bigint>;
  portions: Map<string, { acceptanceId: string; quantity: bigint }>;
}

const DIMENSION: Record<string, string> = {
  COMMITTED: "COMMITMENT",
  DELIVERED: "FULFILLMENT",
  VERIFIED: "FULFILLMENT",
  ACCEPTED: "FULFILLMENT",
  PAYMENT_AUTHORIZED: "PAYMENT_EXECUTION",
  PAYMENT_SUBMITTED: "PAYMENT_EXECUTION",
  FUNDS_RECORDED: "FUNDS",
  DISCHARGED: "FUNDS",
  DISPUTED: "DISPUTE",
  CANCELLED: "COMMITMENT",
  REORGED: "PAYMENT_EXECUTION",
};

export class TradeBook {
  private readonly trades = new Map<string, StoredTrade>();
  private readonly events = new Map<string, { digest: string; stored: TradeEvent; result: Record<string, unknown> }>();
  private readonly streams = new Map<string, StreamState>();
  private readonly held = new Map<string, TradeEvent>();
  private readonly disputes = new Map<string, DisputeBody>();

  constructor(
    private readonly clock: Clock,
    private readonly network: NetworkLedger,
  ) {}

  open(envelope: TradeEnvelope): { tradeId: string; obligations: string[] } {
    if (this.trades.has(envelope.tradeId)) throw new ProtocolError("STATE_CONFLICT", "trade exists");
    if (envelope.schemaDigest !== schemaDigest("rwaix.trade.envelope.v1")) {
      throw new ProtocolError("SCHEMA_INVALID", "schemaDigest is not the frozen trade envelope");
    }
    if (envelope.termsDigest !== digestPrefixed(envelope.terms ?? {})) {
      throw new ProtocolError("SCHEMA_INVALID", "termsDigest does not match canonical terms");
    }
    this.checkExtensions(envelope);
    for (const obligation of envelope.obligations) {
      this.network.openObligation({
        obligationId: obligation.obligationId,
        tradeId: envelope.tradeId,
        kind: obligation.kind,
        assetId: obligation.assetId,
        approved: BigInt(obligation.amount),
        authorized: obligation.amount === "0" || obligation.kind === "NONE",
      });
    }
    this.trades.set(envelope.tradeId, {
      envelope,
      commitment: "NONE",
      commits: new Set(),
      fulfillment: "NONE",
      dispute: "NONE",
      delivered: new Map(),
      accepted: new Map(),
      portions: new Map(),
    });
    return { tradeId: envelope.tradeId, obligations: envelope.obligations.map((item) => item.obligationId) };
  }

  submit(event: TradeEvent, signer: string): Record<string, unknown> {
    if (event.actor !== signer) throw new ProtocolError("UNAUTHORIZED", "event actor is not the signer");
    if (!event.authorityRef) throw new ProtocolError("MISSING_AUTHORITY", "authorityRef is required");
    if (event.obligationApplicable === false && event.obligationId) {
      throw new ProtocolError("SCHEMA_INVALID", "obligationId must be omitted when obligationApplicable is false");
    }
    if (event.obligationApplicable === true && !event.obligationId) {
      throw new ProtocolError("SCHEMA_INVALID", "obligationId is required");
    }
    const prior = this.events.get(event.eventId);
    const comparable = this.withoutRecorded(event);
    if (prior) {
      if (digestPrefixed(this.withoutRecorded(prior.stored)) !== digestPrefixed(comparable)) {
        throw new ProtocolError("IDEMPOTENCY_CONFLICT", "eventId is already bound to different content");
      }
      return prior.result;
    }
    const trade = this.must(event.tradeId);
    if (event.eventType === "COMMITTED") {
      const party = trade.envelope.parties.find((item) => item.partyId === signer);
      if (!party) throw new ProtocolError("UNAUTHORIZED", "committer is not a party");
      if (event.sourceId !== trade.envelope.termsDigest) {
        throw new ProtocolError("STATE_CONFLICT", "commit must bind the same termsDigest");
      }
    }
    const stream = this.stream(event.streamId);
    const sequence = BigInt(event.sequence);
    if (sequence < stream.next) throw new ProtocolError("STATE_CONFLICT", "sequence is behind the stream head");
    if (sequence > stream.next) {
      this.held.set(this.heldKey(event.streamId, sequence), event);
      return {
        status: "HELD_FOR_RECONCILE",
        eventId: event.eventId,
        streamId: event.streamId,
        sequence: event.sequence,
        effectiveAt: event.effectiveAt,
      };
    }
    return this.apply(event, trade, stream);
  }

  accept(body: AcceptanceBody, signer: string): { acceptedQuantity: string; portionId: string } {
    if (body.acceptor !== signer) throw new ProtocolError("UNAUTHORIZED", "acceptor mismatch");
    if (!body.authorityRef) throw new ProtocolError("MISSING_AUTHORITY");
    const trade = this.must(body.tradeId);
    const party = trade.envelope.parties.find((item) => item.partyId === signer);
    if (!party || (party.role !== "CUSTOMER" && party.role !== "ACCEPTOR")) {
      throw new ProtocolError("UNAUTHORIZED", "acceptance requires the customer or acceptor role");
    }
    const existing = trade.portions.get(body.portionId);
    const quantity = BigInt(body.quantity);
    if (existing) {
      if (existing.acceptanceId === body.acceptanceId && existing.quantity === quantity) {
        return { acceptedQuantity: (trade.accepted.get(body.obligationId) ?? 0n).toString(), portionId: body.portionId };
      }
      throw new ProtocolError("PORTION_DUPLICATE", "the same portion cannot increase quantity or payables");
    }
    const delivered = trade.delivered.get(body.obligationId) ?? 0n;
    const accepted = trade.accepted.get(body.obligationId) ?? 0n;
    if (trade.envelope.profileId === "nft.trade" && (quantity <= 0n || quantity !== delivered)) {
      throw new ProtocolError("STATE_CONFLICT", "an indivisible NFT uses one full portion and does not invent a partial transfer");
    }
    if (accepted + quantity > delivered) throw new ProtocolError("OVERSPEND", "accepted quantity exceeds delivered quantity");
    trade.portions.set(body.portionId, { acceptanceId: body.acceptanceId, quantity });
    trade.accepted.set(body.obligationId, accepted + quantity);
    if ((trade.accepted.get(body.obligationId) ?? 0n) >= delivered && delivered > 0n) trade.fulfillment = "FULFILLED";
    else trade.fulfillment = "PARTIAL";
    return { acceptedQuantity: (trade.accepted.get(body.obligationId) ?? 0n).toString(), portionId: body.portionId };
  }

  dispute(body: DisputeBody, signer: string): { status: "OPEN" } {
    if (body.claimant !== signer) throw new ProtocolError("UNAUTHORIZED");
    const trade = this.must(body.tradeId);
    if (this.disputes.has(body.disputeId)) throw new ProtocolError("STATE_CONFLICT", "dispute exists");
    this.disputes.set(body.disputeId, { ...body, status: "OPEN" });
    trade.dispute = "OPEN";
    return { status: "OPEN" };
  }

  authorize(obligationId: string, roleHeld: boolean): { authorized: true } {
    if (!roleHeld) throw new ProtocolError("UNAUTHORIZED", "payment authorization requires TREASURY");
    const account = this.network.obligations.get(obligationId);
    if (!account) throw new ProtocolError("NOT_FOUND", obligationId);
    account.authorized = true;
    return { authorized: true };
  }

  sweep(): { disputesResolvedBySilence: 0; openDisputes: number } {
    return { disputesResolvedBySilence: 0, openDisputes: [...this.disputes.values()].filter((item) => item.status === "OPEN").length };
  }

  toJSON(): unknown {
    return {
      trades: [...this.trades].map(([tradeId, trade]) => ({
        tradeId,
        envelope: trade.envelope,
        commitment: trade.commitment,
        commits: [...trade.commits],
        fulfillment: trade.fulfillment,
        dispute: trade.dispute,
        delivered: [...trade.delivered].map(([key, value]) => [key, value.toString()]),
        accepted: [...trade.accepted].map(([key, value]) => [key, value.toString()]),
        portions: [...trade.portions].map(([key, value]) => [key, { acceptanceId: value.acceptanceId, quantity: value.quantity.toString() }]),
      })),
      events: [...this.events.values()],
      streams: [...this.streams].map(([id, stream]) => ({ id, next: stream.next.toString(), lastDigest: stream.lastDigest })),
      held: [...this.held.values()],
      disputes: [...this.disputes.values()],
    };
  }

  loadJSON(raw: {
    trades: Array<{
      tradeId: string;
      envelope: TradeEnvelope;
      commitment: StoredTrade["commitment"];
      commits: string[];
      fulfillment: StoredTrade["fulfillment"];
      dispute: StoredTrade["dispute"];
      delivered: Array<[string, string]>;
      accepted: Array<[string, string]>;
      portions: Array<[string, { acceptanceId: string; quantity: string }]>;
    }>;
    events: Array<{ digest: string; stored: TradeEvent; result: Record<string, unknown> }>;
    streams: Array<{ id: string; next: string; lastDigest: string }>;
    held: TradeEvent[];
    disputes: DisputeBody[];
  }): void {
    this.trades.clear();
    this.events.clear();
    this.streams.clear();
    this.held.clear();
    this.disputes.clear();
    for (const trade of raw.trades) {
      this.trades.set(trade.tradeId, {
        envelope: trade.envelope,
        commitment: trade.commitment,
        commits: new Set(trade.commits),
        fulfillment: trade.fulfillment,
        dispute: trade.dispute,
        delivered: new Map(trade.delivered.map(([key, value]) => [key, BigInt(value)])),
        accepted: new Map(trade.accepted.map(([key, value]) => [key, BigInt(value)])),
        portions: new Map(trade.portions.map(([key, value]) => [key, { acceptanceId: value.acceptanceId, quantity: BigInt(value.quantity) }])),
      });
    }
    for (const event of raw.events) this.events.set(event.stored.eventId, event);
    for (const stream of raw.streams) this.streams.set(stream.id, { next: BigInt(stream.next), lastDigest: stream.lastDigest });
    for (const event of raw.held) this.held.set(this.heldKey(event.streamId, BigInt(event.sequence)), event);
    for (const dispute of raw.disputes) this.disputes.set(dispute.disputeId, dispute);
  }

  view(tradeId: string) {
    const trade = this.must(tradeId);
    return {
      tradeId,
      termsDigest: trade.envelope.termsDigest,
      extensions: trade.envelope.extensions ?? {},
      commitment: trade.commitment,
      fulfillment: trade.fulfillment,
      dispute: trade.dispute,
      delivered: Object.fromEntries([...trade.delivered].map(([key, value]) => [key, value.toString()])),
      accepted: Object.fromEntries([...trade.accepted].map(([key, value]) => [key, value.toString()])),
      payment: this.network.exportNetwork().attempts.filter((attempt) =>
        trade.envelope.obligations.some((item) => item.obligationId === attempt.obligationId),
      ),
    };
  }

  private apply(event: TradeEvent, trade: StoredTrade, stream: StreamState): Record<string, unknown> {
    const expectedPrev = stream.next === 1n ? "genesis" : stream.lastDigest;
    if (event.prevEventDigest !== expectedPrev) throw new ProtocolError("STATE_CONFLICT", "prevEventDigest does not match the stream head");
    const stored: TradeEvent = { ...event, recordedAt: this.clock.now() };
    const digest = digestPrefixed(stored);
    this.effect(stored, trade);
    stream.lastDigest = digest;
    stream.next += 1n;
    const result = {
      status: "APPLIED",
      eventId: stored.eventId,
      effectiveAt: stored.effectiveAt,
      recordedAt: stored.recordedAt,
      eventDigest: digest,
      dimension: stored.dimension ?? DIMENSION[stored.eventType] ?? "COMMITMENT",
      commitment: trade.commitment,
      fulfillment: trade.fulfillment,
      dispute: trade.dispute,
    };
    this.events.set(stored.eventId, { digest, stored, result });
    const nextHeld = this.held.get(this.heldKey(stored.streamId, stream.next));
    if (nextHeld) {
      this.held.delete(this.heldKey(stored.streamId, stream.next));
      this.apply(nextHeld, this.must(nextHeld.tradeId), stream);
    }
    return result;
  }

  private effect(event: TradeEvent, trade: StoredTrade): void {
    const dimension = event.dimension ?? DIMENSION[event.eventType] ?? "COMMITMENT";
    if (event.eventType === "COMMITTED") {
      trade.commits.add(event.actor);
      const needed = trade.envelope.parties.filter((party) => party.role === "CUSTOMER" || party.role === "PROVIDER");
      const required = needed.length > 0 ? needed : trade.envelope.parties;
      if (required.every((party) => trade.commits.has(party.partyId))) trade.commitment = "COMMITTED";
    } else if (event.eventType === "DELIVERED") {
      if (!event.obligationId || !event.quantity) throw new ProtocolError("SCHEMA_INVALID", "delivery requires obligationId and quantity");
      const next = (trade.delivered.get(event.obligationId) ?? 0n) + BigInt(event.quantity);
      trade.delivered.set(event.obligationId, next);
      if (trade.fulfillment !== "FULFILLED") trade.fulfillment = "PARTIAL";
    } else if (event.eventType === "REORGED") {
      event.inclusion = "REORGED";
    }
    if (dimension === "PAYMENT_EXECUTION" || dimension === "FUNDS") {
      // Payment facts must not be rewritten as fulfillment or dispute resolution.
      return;
    }
  }

  private checkExtensions(envelope: TradeEnvelope): void {
    const extensions = envelope.extensions ?? {};
    for (const key of Object.keys(extensions)) {
      if (!registry.extensions.some((item) => item.id === key)) {
        throw new ProtocolError("EXTENSION_UNKNOWN", key);
      }
    }
    for (const item of registry.extensions) {
      if (item.required && item.profileId === envelope.profileId && !extensions[item.id]) {
        throw new ProtocolError("EXTENSION_REQUIRED", item.id);
      }
    }
  }

  private stream(id: string): StreamState {
    let state = this.streams.get(id);
    if (!state) {
      state = { next: 1n, lastDigest: "genesis" };
      this.streams.set(id, state);
    }
    return state;
  }

  private heldKey(streamId: string, sequence: bigint): string {
    return `${streamId}:${sequence.toString()}`;
  }

  private must(tradeId: string): StoredTrade {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new ProtocolError("NOT_FOUND", tradeId);
    return trade;
  }

  private withoutRecorded(event: TradeEvent): Omit<TradeEvent, "recordedAt"> {
    const copy = { ...event };
    delete copy.recordedAt;
    return copy;
  }
}
