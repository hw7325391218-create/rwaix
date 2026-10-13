import assert from "node:assert/strict";
import { test } from "node:test";
import { NetworkLedger } from "@rwaix/economics";
import { ProtocolError } from "@rwaix/protocol";

const TOKEN = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function ledger(): NetworkLedger {
  const book = new NetworkLedger();
  book.registerAsset({ assetId: "RWAIX_TEST", chainId: "31337", contractAddress: TOKEN, decimals: 18, kind: "NETWORK_FEE" });
  book.registerAsset({ assetId: "USD_TEST", chainId: "0", contractAddress: "0x0000000000000000000000000000000000000001", decimals: 2, kind: "FIAT_TEST" });
  book.openObligation({ obligationId: "fee-1", tradeId: "t1", kind: "NETWORK_FEE", assetId: "RWAIX_TEST", approved: 100n, authorized: true });
  book.openObligation({ obligationId: "rights-1", tradeId: "t1", kind: "RIGHTS_DISTRIBUTION", assetId: "USD_TEST", approved: 100n, authorized: true });
  return book;
}

function quote(over: Partial<{ decimals: number; contractAddress: string; expiry: string; maxDebit: bigint; settledAmount: bigint; obligationId: string; obligationKind: "NETWORK_FEE" | "SERVICE" }> = {}) {
  return {
    quoteId: "q1",
    assetId: "RWAIX_TEST",
    chainId: "31337",
    contractAddress: over.contractAddress ?? TOKEN,
    decimals: over.decimals ?? 18,
    maxDebit: over.maxDebit ?? 100n,
    settledAmount: over.settledAmount ?? 80n,
    expiry: over.expiry ?? "2026-10-12T00:00:00Z",
    obligationId: over.obligationId ?? "fee-1",
    obligationKind: over.obligationKind ?? "NETWORK_FEE",
  };
}

test("section 22 fee/right mismatch, wrong contract, wrong decimals", () => {
  const book = ledger();
  assert.throws(() => book.reserve({ obligationId: "rights-1", paymentAttemptId: "a", assetId: "USD_TEST", amount: 1n }), (error: unknown) => error instanceof ProtocolError && error.code === "FEE_RIGHT_MISMATCH");
  assert.throws(() => book.acceptQuote(quote({ contractAddress: OTHER }), "2026-10-11T00:00:00Z"), (error: unknown) => error instanceof ProtocolError && error.code === "ASSET_MISMATCH");
  assert.throws(() => book.acceptQuote(quote({ decimals: 6 }), "2026-10-11T00:00:00Z"), (error: unknown) => error instanceof ProtocolError && error.code === "DECIMALS_MISMATCH");
});

test("section 22 expired quote, price jump, and no historical rewrite", () => {
  const book = ledger();
  assert.throws(() => book.acceptQuote(quote({ expiry: "2026-10-10T00:00:00Z" }), "2026-10-11T00:00:00Z"), (error: unknown) => error instanceof ProtocolError && error.code === "QUOTE_EXPIRED");
  book.acceptQuote(quote(), "2026-10-11T00:00:00Z");
  assert.throws(() => book.reserveQuote("q1", "a1", 150n, "2026-10-11T00:00:00Z"), (error: unknown) => error instanceof ProtocolError && error.code === "PRICE_DEVIATION");
  assert.equal(book.quotes.get("q1")?.consumed, 0n);
  book.reserveQuote("q1", "a1", 90n, "2026-10-11T00:00:00Z");
  assert.equal(book.quotes.get("q1")?.consumed, 80n);
  assert.throws(() => book.rewriteConsumed(), (error: unknown) => error instanceof ProtocolError && error.code === "PRICE_DEVIATION");
  assert.equal(book.quotes.get("q1")?.consumed, 80n);
});

test("section 22 concurrent overspend and unknown payment", () => {
  const book = ledger();
  book.reserve({ obligationId: "fee-1", paymentAttemptId: "a1", assetId: "RWAIX_TEST", amount: 60n });
  assert.throws(() => book.reserve({ obligationId: "fee-1", paymentAttemptId: "a2", assetId: "RWAIX_TEST", amount: 50n }), (error: unknown) => error instanceof ProtocolError && error.code === "OVERSPEND");
  assert.equal(book.coverage("fee-1"), 60n);
  book.markUnknown("a1");
  assert.throws(() => book.reserve({ obligationId: "fee-1", paymentAttemptId: "a3", assetId: "USD_TEST", amount: 1n }), (error: unknown) => error instanceof ProtocolError && error.code === "OUTCOME_UNKNOWN");
  assert.throws(() => book.confirmFailed("a1"), (error: unknown) => error instanceof ProtocolError && error.code === "OUTCOME_UNKNOWN");
  assert.equal(book.coverage("fee-1"), 60n);
  book.confirmExecution("a1");
  assert.equal(book.coverage("fee-1"), 60n);
});

test("section 22 duplicate reward, unauthorized slash, bridge double supply", () => {
  const book = ledger();
  book.setBudget("2026-10", 100n);
  book.submitReward({
    claimId: "c1",
    serviceId: "job-1",
    provider: "provider-1",
    budgetPeriod: "2026-10",
    amount: 40n,
    assetId: "RWAIX_TEST",
    source: "APPROVED_SUBSIDY",
  });
  assert.throws(() => book.submitReward({
    claimId: "c2",
    serviceId: "job-1",
    provider: "provider-1",
    budgetPeriod: "2026-10",
    amount: 40n,
    assetId: "RWAIX_TEST",
    source: "APPROVED_SUBSIDY",
  }), (error: unknown) => error instanceof ProtocolError && error.code === "DUPLICATE_REWARD");
  book.claimReward("c1");
  assert.throws(() => book.claimReward("c1"), (error: unknown) => error instanceof ProtocolError && error.code === "DUPLICATE_REWARD");
  assert.equal(book.budgets.get("2026-10")?.allocated, 40n);

  book.lockBond({ bondId: "b1", subject: "node-1", assetId: "RWAIX_TEST", lockedAmount: 10n, state: "PROPOSED" });
  assert.throws(() => book.slashBond("b1", "BOND_RELEASE"), (error: unknown) => error instanceof ProtocolError && error.code === "UNAUTHORIZED_SLASH");
  assert.equal(book.bonds.get("b1")?.state, "LOCKED");
  book.slashBond("b1", "SLASHER");
  assert.equal(book.bonds.get("b1")?.state, "SLASHED");

  book.setSupplyCap(1000n);
  book.mintNative(1000n);
  book.lockForBridge("lock-1", 100n);
  book.bridgeMint("msg-1", "lock-1", 100n);
  assert.throws(() => book.bridgeMint("msg-1", "lock-1", 100n), (error: unknown) => error instanceof ProtocolError && error.code === "BRIDGE_DOUBLE_SUPPLY");
  assert.throws(() => book.bridgeMint("msg-2", "lock-1", 100n), (error: unknown) => error instanceof ProtocolError && error.code === "BRIDGE_DOUBLE_SUPPLY");
  assert.equal(book.circulating, 1000n);
  assert.equal(book.economicOutstanding(), 1000n);
});
