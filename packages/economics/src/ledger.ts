import { ProtocolError } from "@rwaix/protocol";

export interface AssetRecord {
  assetId: string;
  chainId: string;
  contractAddress: string;
  decimals: number;
  kind: string;
}

export interface ObligationAccount {
  obligationId: string;
  tradeId: string;
  kind: "SERVICE" | "NETWORK_FEE" | "RIGHTS_DISTRIBUTION" | "NONE";
  assetId: string;
  approved: bigint;
  authorized: boolean;
}

export interface PaymentAttempt {
  paymentAttemptId: string;
  obligationId: string;
  assetId: string;
  amount: bigint;
  quoteId?: string;
  instructionState: "RESERVED" | "SUBMITTED" | "OUTCOME_UNKNOWN" | "FAILED_CONFIRMED";
  fundsReceiptState: "NONE" | "PENDING" | "ATTRIBUTED";
  dischargeState: "NONE" | "DISCHARGED";
  outcome: "NONE" | "OUTCOME_UNKNOWN" | "CONFIRMED_EXECUTION" | "FAILED_CONFIRMED";
}

export interface QuoteRecord {
  quoteId: string;
  assetId: string;
  chainId: string;
  contractAddress: string;
  decimals: number;
  maxDebit: bigint;
  settledAmount: bigint;
  expiry: string;
  obligationId: string;
  obligationKind: "NETWORK_FEE" | "SERVICE";
  consumed: bigint;
  accepted: boolean;
}

export interface BondRecord {
  bondId: string;
  subject: string;
  assetId: string;
  lockedAmount: bigint;
  state: "PROPOSED" | "LOCKED" | "DISPUTED" | "RELEASED" | "SLASHED";
}

export interface RewardRecord {
  claimId: string;
  serviceId: string;
  provider: string;
  budgetPeriod: string;
  amount: bigint;
  assetId: string;
  source: "EARNED_FEE" | "APPROVED_SUBSIDY" | "APPROVED_EMISSION";
  state: "SUBMITTED" | "APPROVED" | "CLAIMABLE" | "CLAIMED" | "REJECTED";
}

function parseAmount(value: string | bigint): bigint {
  const amount = typeof value === "bigint" ? value : BigInt(value);
  if (amount < 0n) throw new ProtocolError("SCHEMA_INVALID", "negative amount");
  return amount;
}

/**
 * Network fee, bond, and reward ledger. Rights distributions are rejected here
 * so a fee path cannot settle a series-rights obligation.
 * Coverage counts discharged, executed-but-unattributed, and still-live pending
 * attempts. OUTCOME_UNKNOWN stays inside that sum.
 */
export class NetworkLedger {
  readonly assets = new Map<string, AssetRecord>();
  readonly obligations = new Map<string, ObligationAccount>();
  readonly attempts = new Map<string, PaymentAttempt>();
  readonly quotes = new Map<string, QuoteRecord>();
  readonly bonds = new Map<string, BondRecord>();
  readonly rewards = new Map<string, RewardRecord>();
  readonly budgets = new Map<string, { cap: bigint; allocated: bigint }>();
  private readonly rewardKeys = new Set<string>();
  private readonly locks = new Map<string, { amount: bigint; used: boolean }>();
  private readonly bridgeMessages = new Set<string>();
  cap = 0n;
  circulating = 0n;

  registerAsset(asset: AssetRecord): void {
    const key = asset.assetId;
    const prev = this.assets.get(key);
    if (prev && (prev.contractAddress.toLowerCase() !== asset.contractAddress.toLowerCase() || prev.decimals !== asset.decimals || prev.chainId !== asset.chainId)) {
      throw new ProtocolError("ASSET_MISMATCH", "asset id is already bound to a different contract, chain, or decimals");
    }
    this.assets.set(key, asset);
  }

  openObligation(account: ObligationAccount): void {
    if (this.obligations.has(account.obligationId)) throw new ProtocolError("STATE_CONFLICT", "obligation exists");
    this.obligations.set(account.obligationId, account);
  }

  coverage(obligationId: string): bigint {
    let sum = 0n;
    for (const attempt of this.attempts.values()) {
      if (attempt.obligationId === obligationId && attempt.outcome !== "FAILED_CONFIRMED") sum += attempt.amount;
    }
    return sum;
  }

  private obligation(id: string): ObligationAccount {
    const found = this.obligations.get(id);
    if (!found) throw new ProtocolError("NOT_FOUND", id);
    return found;
  }

  private assertNoUnknown(obligationId: string): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.obligationId === obligationId && attempt.outcome === "OUTCOME_UNKNOWN") {
        throw new ProtocolError("OUTCOME_UNKNOWN", "an unknown payment still occupies coverage; refusing a new asset or a new attempt");
      }
    }
  }

  reserve(input: { obligationId: string; paymentAttemptId: string; assetId: string; amount: string | bigint; quoteId?: string }): PaymentAttempt {
    const account = this.obligation(input.obligationId);
    if (account.kind === "RIGHTS_DISTRIBUTION") {
      throw new ProtocolError("FEE_RIGHT_MISMATCH", "fee and service settlement cannot draw on a rights-distribution obligation");
    }
    this.assertNoUnknown(account.obligationId);
    if (account.assetId !== input.assetId) throw new ProtocolError("ASSET_MISMATCH", "payment asset does not match the obligation");
    if (this.attempts.has(input.paymentAttemptId)) throw new ProtocolError("DUPLICATE_ATTEMPT", input.paymentAttemptId);
    const amount = parseAmount(input.amount);
    if (this.coverage(account.obligationId) + amount > account.approved) {
      throw new ProtocolError("OVERSPEND", "confirmed plus still-live payments would exceed the approved amount");
    }
    const attempt: PaymentAttempt = {
      paymentAttemptId: input.paymentAttemptId,
      obligationId: account.obligationId,
      assetId: input.assetId,
      amount,
      instructionState: "RESERVED",
      fundsReceiptState: "NONE",
      dischargeState: "NONE",
      outcome: "NONE",
      ...(input.quoteId ? { quoteId: input.quoteId } : {}),
    };
    this.attempts.set(attempt.paymentAttemptId, attempt);
    return attempt;
  }

  markUnknown(paymentAttemptId: string): PaymentAttempt {
    const attempt = this.mustAttempt(paymentAttemptId);
    if (attempt.outcome === "FAILED_CONFIRMED" || attempt.dischargeState === "DISCHARGED") {
      throw new ProtocolError("STATE_CONFLICT", "attempt can no longer become unknown");
    }
    attempt.outcome = "OUTCOME_UNKNOWN";
    attempt.instructionState = "OUTCOME_UNKNOWN";
    attempt.fundsReceiptState = "PENDING";
    return attempt;
  }

  confirmExecution(paymentAttemptId: string): PaymentAttempt {
    const attempt = this.mustAttempt(paymentAttemptId);
    if (attempt.outcome === "OUTCOME_UNKNOWN") {
      attempt.outcome = "CONFIRMED_EXECUTION";
      attempt.instructionState = "SUBMITTED";
      attempt.fundsReceiptState = "PENDING";
      return attempt;
    }
    if (attempt.outcome === "FAILED_CONFIRMED") throw new ProtocolError("STATE_CONFLICT", "failed attempt");
    attempt.outcome = "CONFIRMED_EXECUTION";
    attempt.instructionState = "SUBMITTED";
    attempt.fundsReceiptState = "PENDING";
    return attempt;
  }

  confirmFailed(paymentAttemptId: string): PaymentAttempt {
    const attempt = this.mustAttempt(paymentAttemptId);
    if (attempt.outcome === "OUTCOME_UNKNOWN") {
      throw new ProtocolError("OUTCOME_UNKNOWN", "unknown outcome is not a confirmed failure and does not release coverage");
    }
    if (attempt.dischargeState === "DISCHARGED" || attempt.fundsReceiptState === "ATTRIBUTED") {
      throw new ProtocolError("STATE_CONFLICT", "attributed funds are not deleted");
    }
    attempt.outcome = "FAILED_CONFIRMED";
    attempt.instructionState = "FAILED_CONFIRMED";
    return attempt;
  }

  attribute(paymentAttemptId: string): PaymentAttempt {
    const attempt = this.mustAttempt(paymentAttemptId);
    if (attempt.outcome !== "CONFIRMED_EXECUTION") throw new ProtocolError("STATE_CONFLICT", "funds attribution requires confirmed execution");
    attempt.fundsReceiptState = "ATTRIBUTED";
    return attempt;
  }

  discharge(paymentAttemptId: string): PaymentAttempt {
    const attempt = this.mustAttempt(paymentAttemptId);
    if (attempt.fundsReceiptState !== "ATTRIBUTED") throw new ProtocolError("STATE_CONFLICT", "discharge follows funds attribution");
    attempt.dischargeState = "DISCHARGED";
    return attempt;
  }

  acceptQuote(quote: Omit<QuoteRecord, "consumed" | "accepted">, now: string): QuoteRecord {
    const asset = this.assets.get(quote.assetId);
    if (!asset) throw new ProtocolError("ASSET_MISMATCH", "fee asset is not registered");
    if (asset.chainId !== quote.chainId || asset.contractAddress.toLowerCase() !== quote.contractAddress.toLowerCase()) {
      throw new ProtocolError("ASSET_MISMATCH", "quote contract or chain does not match the registry");
    }
    if (asset.decimals !== quote.decimals) throw new ProtocolError("DECIMALS_MISMATCH", "quote decimals do not match the registry");
    const account = this.obligation(quote.obligationId);
    if (account.kind === "RIGHTS_DISTRIBUTION" || account.kind !== quote.obligationKind) {
      throw new ProtocolError("FEE_RIGHT_MISMATCH", "quote obligation kind does not match the registered obligation");
    }
    if (account.assetId !== quote.assetId) throw new ProtocolError("ASSET_MISMATCH", "quote asset does not match the obligation");
    if (now > quote.expiry) throw new ProtocolError("QUOTE_EXPIRED", "quote expired before acceptance");
    if (quote.settledAmount > quote.maxDebit) throw new ProtocolError("PRICE_DEVIATION", "settled amount exceeds max debit");
    if (this.quotes.has(quote.quoteId)) throw new ProtocolError("STATE_CONFLICT", "quote exists");
    const stored: QuoteRecord = { ...quote, consumed: 0n, accepted: true };
    this.quotes.set(quote.quoteId, stored);
    return stored;
  }

  reserveQuote(quoteId: string, paymentAttemptId: string, executionDebit: bigint, now: string): { quote: QuoteRecord; attempt: PaymentAttempt } {
    const quote = this.mustQuote(quoteId);
    if (!quote.accepted) throw new ProtocolError("STATE_CONFLICT", "quote is not accepted");
    if (now > quote.expiry) throw new ProtocolError("QUOTE_EXPIRED", "quote expired");
    if (executionDebit > quote.maxDebit) {
      throw new ProtocolError("PRICE_DEVIATION", "execution debit exceeds the accepted max debit; historical consumption is unchanged");
    }
    const attempt = this.reserve({
      obligationId: quote.obligationId,
      paymentAttemptId,
      assetId: quote.assetId,
      amount: quote.settledAmount,
      quoteId,
    });
    quote.consumed += quote.settledAmount;
    return { quote, attempt };
  }

  /** Price moves must not rewrite an amount that was already consumed. */
  rewriteConsumed(): never {
    throw new ProtocolError("PRICE_DEVIATION", "historical consumed amount is not released or recomputed when the price moves");
  }

  lockBond(record: BondRecord): BondRecord {
    if (this.bonds.has(record.bondId)) throw new ProtocolError("STATE_CONFLICT", "bond exists");
    const stored = { ...record, state: "LOCKED" as const };
    this.bonds.set(record.bondId, stored);
    return stored;
  }

  releaseBond(bondId: string, role: string): BondRecord {
    if (role !== "BOND_RELEASE") throw new ProtocolError("UNAUTHORIZED", "release requires BOND_RELEASE");
    const bond = this.mustBond(bondId);
    if (bond.state !== "LOCKED" && bond.state !== "DISPUTED") throw new ProtocolError("STATE_CONFLICT", bond.state);
    bond.state = "RELEASED";
    return bond;
  }

  slashBond(bondId: string, role: string): BondRecord {
    if (role !== "SLASHER") throw new ProtocolError("UNAUTHORIZED_SLASH", "slash requires the SLASHER role, which is separate from lock and release");
    const bond = this.mustBond(bondId);
    if (bond.state !== "LOCKED" && bond.state !== "DISPUTED") throw new ProtocolError("STATE_CONFLICT", bond.state);
    bond.state = "SLASHED";
    return bond;
  }

  setBudget(period: string, cap: bigint): void {
    const current = this.budgets.get(period);
    if (current && cap < current.allocated) throw new ProtocolError("OVERSPEND", "budget cap below already allocated amount");
    this.budgets.set(period, { cap, allocated: current?.allocated ?? 0n });
  }

  submitReward(record: Omit<RewardRecord, "state">): RewardRecord {
    const key = `${record.serviceId}|${record.provider}|${record.budgetPeriod}`;
    if (this.rewardKeys.has(key)) throw new ProtocolError("DUPLICATE_REWARD", "service, provider, and period already have a claim");
    const budget = this.budgets.get(record.budgetPeriod);
    if (!budget) throw new ProtocolError("NOT_FOUND", "reward budget");
    if (budget.allocated + record.amount > budget.cap) throw new ProtocolError("OVERSPEND", "reward budget");
    budget.allocated += record.amount;
    this.rewardKeys.add(key);
    const stored: RewardRecord = { ...record, state: "APPROVED" };
    this.rewards.set(record.claimId, stored);
    return stored;
  }

  claimReward(claimId: string): RewardRecord {
    const reward = this.rewards.get(claimId);
    if (!reward) throw new ProtocolError("NOT_FOUND", claimId);
    if (reward.state === "CLAIMED") throw new ProtocolError("DUPLICATE_REWARD", "already claimed");
    if (reward.state !== "APPROVED" && reward.state !== "CLAIMABLE") throw new ProtocolError("STATE_CONFLICT", reward.state);
    reward.state = "CLAIMED";
    return reward;
  }

  setSupplyCap(cap: bigint): void {
    if (cap < this.circulating + this.lockedOutstanding()) throw new ProtocolError("BRIDGE_DOUBLE_SUPPLY", "cap below outstanding supply");
    this.cap = cap;
  }

  mintNative(amount: bigint): void {
    if (this.circulating + this.lockedOutstanding() + amount > this.cap) {
      throw new ProtocolError("BRIDGE_DOUBLE_SUPPLY", "mint would increase economic supply above the cap");
    }
    this.circulating += amount;
  }

  lockForBridge(lockId: string, amount: bigint): void {
    if (this.locks.has(lockId)) throw new ProtocolError("REPLAY", "lock id already used");
    if (amount > this.circulating) throw new ProtocolError("OVERSPEND", "lock exceeds circulating balance");
    this.circulating -= amount;
    this.locks.set(lockId, { amount, used: false });
  }

  bridgeMint(messageId: string, lockId: string, amount: bigint): void {
    if (this.bridgeMessages.has(messageId)) throw new ProtocolError("BRIDGE_DOUBLE_SUPPLY", "bridge message replay would double supply");
    const lock = this.locks.get(lockId);
    if (!lock || lock.used || lock.amount !== amount) {
      throw new ProtocolError("BRIDGE_DOUBLE_SUPPLY", "bridge mint requires an unused source lock of the same amount");
    }
    if (this.circulating + amount > this.cap) throw new ProtocolError("BRIDGE_DOUBLE_SUPPLY", "destination mint exceeds the cap");
    lock.used = true;
    this.bridgeMessages.add(messageId);
    this.circulating += amount;
  }

  economicOutstanding(): bigint {
    return this.circulating + this.lockedOutstanding();
  }

  private lockedOutstanding(): bigint {
    let sum = 0n;
    for (const lock of this.locks.values()) if (!lock.used) sum += lock.amount;
    return sum;
  }

  private mustAttempt(id: string): PaymentAttempt {
    const found = this.attempts.get(id);
    if (!found) throw new ProtocolError("NOT_FOUND", id);
    return found;
  }

  private mustQuote(id: string): QuoteRecord {
    const found = this.quotes.get(id);
    if (!found) throw new ProtocolError("NOT_FOUND", id);
    return found;
  }

  private mustBond(id: string): BondRecord {
    const found = this.bonds.get(id);
    if (!found) throw new ProtocolError("NOT_FOUND", id);
    return found;
  }

  toJSON() {
    return {
      ...this.exportNetwork(),
      locks: [...this.locks].map(([id, lock]) => ({ id, amount: lock.amount.toString(), used: lock.used })),
      bridgeMessages: [...this.bridgeMessages],
      rewardKeys: [...this.rewardKeys],
      budgets: [...this.budgets].map(([key, budget]) => ({ key, cap: budget.cap.toString(), allocated: budget.allocated.toString() })),
    };
  }

  loadJSON(raw: ReturnType<NetworkLedger["toJSON"]>): void {
    this.assets.clear();
    this.obligations.clear();
    this.attempts.clear();
    this.quotes.clear();
    this.bonds.clear();
    this.rewards.clear();
    this.budgets.clear();
    this.rewardKeys.clear();
    this.locks.clear();
    this.bridgeMessages.clear();
    for (const asset of raw.assets) this.assets.set(asset.assetId, asset);
    for (const item of raw.obligations) this.obligations.set(item.obligationId, { ...item, approved: BigInt(item.approved) });
    for (const item of raw.attempts) this.attempts.set(item.paymentAttemptId, { ...item, amount: BigInt(item.amount) });
    for (const item of raw.quotes) {
      this.quotes.set(item.quoteId, { ...item, maxDebit: BigInt(item.maxDebit), settledAmount: BigInt(item.settledAmount), consumed: BigInt(item.consumed) });
    }
    for (const item of raw.bonds) this.bonds.set(item.bondId, { ...item, lockedAmount: BigInt(item.lockedAmount) });
    for (const item of raw.rewards) this.rewards.set(item.claimId, { ...item, amount: BigInt(item.amount) });
    for (const item of raw.locks) this.locks.set(item.id, { amount: BigInt(item.amount), used: item.used });
    for (const id of raw.bridgeMessages) this.bridgeMessages.add(id);
    for (const id of raw.rewardKeys) this.rewardKeys.add(id);
    for (const item of raw.budgets) this.budgets.set(item.key, { cap: BigInt(item.cap), allocated: BigInt(item.allocated) });
    this.cap = BigInt(raw.supply.cap);
    this.circulating = BigInt(raw.supply.circulating);
  }

  exportNetwork() {
    return {
      assets: [...this.assets.values()],
      obligations: [...this.obligations.values()].map((item) => ({ ...item, approved: item.approved.toString() })),
      attempts: [...this.attempts.values()].map((item) => ({ ...item, amount: item.amount.toString() })),
      quotes: [...this.quotes.values()].map((item) => ({
        ...item,
        maxDebit: item.maxDebit.toString(),
        settledAmount: item.settledAmount.toString(),
        consumed: item.consumed.toString(),
      })),
      bonds: [...this.bonds.values()].map((item) => ({ ...item, lockedAmount: item.lockedAmount.toString() })),
      rewards: [...this.rewards.values()].map((item) => ({ ...item, amount: item.amount.toString() })),
      supply: { cap: this.cap.toString(), circulating: this.circulating.toString(), outstanding: this.economicOutstanding().toString() },
    };
  }
}

export interface RightsBindingRecord {
  seriesId: string;
  spvRef: string;
  rightsDocumentDigest: string;
  objectId: string;
  bindingVersion: string;
  testOnly: true;
  securitiesIssuance: false;
}

/** Facility-rights ledger. It records document bindings only. It does not move cash or network-fee balances. */
export class RightsLedger {
  readonly bindings = new Map<string, RightsBindingRecord>();
  bind(record: RightsBindingRecord): void {
    if (record.testOnly !== true || record.securitiesIssuance !== false) {
      throw new ProtocolError("FEE_RIGHT_MISMATCH", "this reference binding cannot issue a security");
    }
    if (this.bindings.has(record.seriesId)) throw new ProtocolError("STATE_CONFLICT", "series already bound");
    this.bindings.set(record.seriesId, record);
  }
  exportRights() {
    return [...this.bindings.values()];
  }

  loadJSON(rows: RightsBindingRecord[]): void {
    this.bindings.clear();
    for (const row of rows) this.bindings.set(row.seriesId, row);
  }
}
