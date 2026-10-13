import { adapterFor } from "@rwaix/adapter-profiles";
import { ManualClock, digestPrefixed, keyFromSeed, schemaDigest, signRequest, type ActionName, type P256Key, type Result } from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";

const clock = new ManualClock("2026-10-11T00:00:00Z");
const verifier = keyFromSeed("demo-verifier");
const customer = keyFromSeed("demo-customer");
const provider = keyFromSeed("demo-provider");
const issuer = keyFromSeed("demo-issuer");
const executor = keyFromSeed("demo-executor");
const treasury = keyFromSeed("demo-treasury");
const admin = keyFromSeed("demo-admin");
const stranger = keyFromSeed("demo-stranger");
const nft = adapterFor("nft", issuer.publicRef);
const service = new ReferenceService({
  clock,
  verifier,
  grants: [
    { signer: executor.publicRef, role: "EXECUTOR" },
    { signer: treasury.publicRef, role: "TREASURY" },
    { signer: admin.publicRef, role: "STATUS_ADMIN" },
  ],
});

let n = 0;
function call(key: P256Key, action: ActionName, request: Record<string, unknown>) {
  n += 1;
  return signRequest(key, action, request, { nonce: `demo-${n.toString().padStart(8, "0")}`, deadline: "2026-12-01T00:00:00Z" });
}
function body(schemaId: string, idempotencyKey: string, extra: Record<string, unknown>) {
  return { schemaId, protocolVersion: "rwaix-0.1.0", idempotencyKey, ...extra };
}
function must<T>(label: string, result: Result<T>): T {
  if (!result.ok) {
    console.error(`FAILED ${label}: ${result.error} ${result.message}`);
    process.exit(1);
  }
  return result.value;
}
function step(index: string, zh: string, en: string) {
  console.log(`\n[${index}] ${zh}`);
  console.log(`    ${en}`);
}

const meta = digestPrefixed({ demo: "nft", work: "synthetic-artwork" });
const terms = {
  network: "31337",
  contract: "0x00000000000000000000000000000000000000aa",
  tokenId: "1",
  workDigest: meta,
  licenceVersion: "licence-v1",
  licenceScope: "display-private",
  sellerControl: "seller-holds",
  recipient: "buyer-wallet",
  copyrightTransfer: "false",
};
const policy = nft.buildPolicy();

step("0", "访问路径：调用方不持有 DCNFT，也不持有 RWAIX_TEST。", "Access path: the caller holds neither DCNFT nor RWAIX_TEST.");
const access = service.accessPath(stranger.publicRef);
console.log(`    allowed=${access.allowed} holdsDcnft=${access.holdsDcnft} holdsRwaix=${access.holdsRwaix}`);
if (!access.allowed || access.holdsDcnft || access.holdsRwaix) process.exit(1);

step("1 bind", "登记一件普通 NFT 作品对象并发布版本。不铸造链上代币。", "Register one ordinary NFT artwork object and publish version 1. No on-chain token is minted.");
must("register", service.registerObject(call(provider, "registerObject", body("rwaix.request.registerObject.v1", "demo-reg", {
  objectId: "nft-work", objectType: "ASSET", controller: provider.publicRef, subjectRef: "subject-work",
  lifecyclePolicy: "TRANSFERABLE", metadataDigest: meta,
}))));
must("publish", service.publishVersion(call(provider, "publishVersion", body("rwaix.request.publishVersion.v1", "demo-ver", {
  objectId: "nft-work", bindingVersion: "1", contentDigest: meta, metadataDigest: meta, subjectBinding: "subject-work",
}))));
must("status", service.setStatus(call(admin, "setStatus", body("rwaix.request.setStatus.v1", "demo-status", {
  subjectRef: "subject-work", status: "ACTIVE",
}))));

step("2 commit", "买方与卖方签署同一 termsDigest。价款 12000 USD_TEST，网络费 0 RWAIX_TEST。许可留在条款里，不写入设施权益账。", "Buyer and seller commit the same termsDigest. Consideration is 12000 USD_TEST and the network fee is 0 RWAIX_TEST. The licence stays in the terms, not on the facility rights ledger.");
const envelope = {
  schemaId: "rwaix.trade.envelope.v1",
  protocolVersion: "rwaix-0.1.0",
  profileId: "nft.trade",
  profileVersion: "1.0.0",
  schemaDigest: schemaDigest("rwaix.trade.envelope.v1"),
  tradeId: "demo-trade",
  termsDigest: digestPrefixed(terms),
  parties: [
    { partyId: customer.publicRef, role: "CUSTOMER", authorityRef: "auth-customer" },
    { partyId: provider.publicRef, role: "PROVIDER", authorityRef: "auth-provider" },
  ],
  objects: [{ objectId: "nft-work", quantity: "1", unit: "nft" }],
  obligations: [
    { obligationId: "obl-service", kind: "SERVICE", amount: "12000", assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" },
    { obligationId: "obl-network", kind: "NETWORK_FEE", amount: "0", assetId: "RWAIX_TEST", decimals: 18, rounding: "EXACT_INTEGER" },
  ],
  acceptanceRule: "CUSTOMER_SIGNATURE",
  timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" },
  paymentTerms: { trigger: "ACCEPTANCE" },
  applicableDocuments: [meta],
  disputePath: "profile-dispute-v1",
  terms,
  extensions: {},
};
must("open", service.trade(call(customer, "trade", body("rwaix.request.trade.v1", "demo-open", { op: "OPEN", envelope }))));
const commitEvent = (who: P256Key, id: string, sequence: string, prev: string) => ({
  schemaId: "rwaix.trade.event.v1",
  eventId: id,
  tradeId: "demo-trade",
  obligationApplicable: false,
  eventType: "COMMITTED",
  actor: who.publicRef,
  authorityRef: "auth",
  streamId: "demo-commit",
  sourceId: digestPrefixed(terms),
  prevEventDigest: prev,
  sequence,
  causalRefs: [],
  effectiveAt: "2026-10-10T12:00:00Z",
  evidenceRefs: [],
  signingDomain: "rwaix.signing.v1",
});
const first = must("commit-1", service.trade(call(customer, "trade", body("rwaix.request.trade.v1", "demo-c1", { op: "EVENT", event: commitEvent(customer, "demo-c1", "1", "genesis") }))));
const second = must("commit-2", service.trade(call(provider, "trade", body("rwaix.request.trade.v1", "demo-c2", {
  op: "EVENT", event: commitEvent(provider, "demo-c2", "2", String(first.eventDigest)),
}))));
console.log(`    commitment=${second.commitment} effectiveAt=${first.effectiveAt} recordedAt=${first.recordedAt}`);

step("3 deliver", "卖方提交这一枚不可分割 NFT 的交付。TrustReceipt 还不能代替验收。", "Seller records delivery of this one indivisible NFT. A TrustReceipt does not replace acceptance.");
must("deliver", service.trade(call(provider, "trade", body("rwaix.request.trade.v1", "demo-del", {
  op: "EVENT",
  event: {
    schemaId: "rwaix.trade.event.v1", eventId: "demo-d1", tradeId: "demo-trade", obligationApplicable: true, obligationId: "obl-service",
    eventType: "DELIVERED", actor: provider.publicRef, authorityRef: "auth-provider", streamId: "demo-del", sourceId: "delivery",
    prevEventDigest: "genesis", sequence: "1", causalRefs: [], effectiveAt: "2026-10-11T00:00:00Z", evidenceRefs: [],
    quantity: "1", unit: "nft", signingDomain: "rwaix.signing.v1",
  },
}))));

function graph(evidence: Record<string, string>, graphId: string) {
  return {
    schemaId: "rwaix.evidence.graph.v1",
    graphId,
    nodes: [
      {
        nodeId: "cred", nodeType: "CREDENTIAL", sourceId: "issuer", controllerId: issuer.publicRef, contentDigest: meta,
        issuer: issuer.publicRef, capturedAt: "2026-10-11T00:00:00Z",
      },
      {
        nodeId: "obs", nodeType: "OBSERVATION", sourceId: "listing", controllerId: provider.publicRef, contentDigest: meta,
        capturedAt: "2026-10-11T00:00:00Z",
        payload: evidence,
      },
    ],
    edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
  };
}
const evalBody = (evidence: Record<string, string>, idem: string, graphId: string) => body("rwaix.request.evaluatePolicy.v1", idem, {
  context: {
    schemaId: "rwaix.context.v1", protocolVersion: "rwaix-0.1.0", audience: "rwaix:nft-buyer",
    purpose: "nft.trade.verify", objectRef: { objectId: "nft-work", bindingVersion: "1" },
    requestedAction: "nft.accept", domain: "nft", subjectRef: "subject-work",
    challengeNonce: "demo-nonce-01", deadline: "2026-12-01T00:00:00Z", policyVersion: "1.0.0",
  },
  policy,
  graph: graph(evidence, graphId),
  statusSnapshot: { schemaId: "rwaix.status.snapshot.v1", snapshotId: "snap-demo", asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: "subject-work", status: "ACTIVE" }] },
  terms,
  evaluationTime: "2026-10-11T00:00:00Z",
  startedAtMs: 0,
  nowMs: 1,
});

step("4 verify", "核验器比对已签条款与交付证据。把 copyrightTransfer 改成 true 会被拒绝。", "Verifier compares signed terms with delivery evidence. Setting copyrightTransfer to true is denied.");
const allow = must("allow", service.evaluatePolicy(call(customer, "evaluatePolicy", evalBody(terms, "demo-eval", "demo-graph"))));
console.log(`    decision=${allow.decision.decision} policyDigest=${allow.receipt.policyDigest}`);
const denied = must("deny", service.evaluatePolicy(call(customer, "evaluatePolicy", evalBody({ ...terms, copyrightTransfer: "true" }, "demo-deny", "demo-copyright"))));
console.log(`    copyrightTransfer=true decision=${denied.decision.decision} reasons=${denied.decision.reasonCodes.join(",")}`);
if (allow.decision.decision !== "ALLOW" || denied.decision.decision !== "DENY" || !denied.decision.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH")) process.exit(1);

step("5 accept", "买方按一个 portion 验收。重复同一 portion 不增加数量。", "Buyer accepts one portion. Repeating that portion does not increase quantity.");
const acceptance = {
  schemaId: "rwaix.acceptance.v1", acceptanceId: "demo-acc", tradeId: "demo-trade", obligationId: "obl-service", portionId: "portion-1",
  objectVersion: "1", quantity: "1", unit: "nft", acceptor: customer.publicRef, authorityRef: "auth-customer", acceptedAt: "2026-10-11T00:00:00Z",
};
must("accept", service.trade(call(customer, "trade", body("rwaix.request.trade.v1", "demo-acc", { op: "ACCEPT", acceptance }))));
const repeated = service.trade(call(customer, "trade", body("rwaix.request.trade.v1", "demo-acc-again", { op: "ACCEPT", acceptance: { ...acceptance, acceptanceId: "demo-acc-2" } })));
if (repeated.ok || repeated.error !== "PORTION_DUPLICATE") process.exit(1);
console.log(`    repeat=${repeated.error}`);

step("6 authorize", "资金角色单独授权价款。回执不是付款授权。网络费保持 0，不要求持有 RWAIX_TEST。", "A treasury role authorizes the consideration. The receipt is not that authorization. The network fee stays 0, so holding RWAIX_TEST is not required.");
must("authorize", service.trade(call(treasury, "trade", body("rwaix.request.trade.v1", "demo-auth", { op: "AUTHORIZE", obligationId: "obl-service" }))));
service.network.registerAsset({ assetId: "USD_TEST", chainId: "0", contractAddress: "0x0000000000000000000000000000000000000001", decimals: 2, kind: "FIAT_TEST" });

step("7 submit", "执行器在终局条件满足后提交 12000。未终局的包含结果不能执行。", "Executor submits 12000 only after finality. Inclusion alone cannot execute.");
const prepared = must("prepare", service.prepareIntent(call(executor, "prepareIntent", body("rwaix.request.prepareIntent.v1", "demo-prep", {
  intentId: "demo-intent", receiptId: allow.receipt.receiptId, action: "pay", payer: customer.publicRef, payee: provider.publicRef,
  assetId: "USD_TEST", amount: "12000", obligationId: "obl-service", intentNonce: "demo-intent-01",
  intentDeadline: "2026-12-01T00:00:00Z", maxStalenessSeconds: "86400",
}))));
const early = service.executeIntent(call(executor, "executeIntent", body("rwaix.request.executeIntent.v1", "demo-early", {
  intentId: prepared.intentId, mode: "CONFIRM", inclusion: "INCLUDED",
})));
if (early.ok || early.error !== "FINALITY_NOT_REACHED") process.exit(1);
const executed = must("execute", service.executeIntent(call(executor, "executeIntent", body("rwaix.request.executeIntent.v1", "demo-exec", {
  intentId: prepared.intentId, mode: "CONFIRM", inclusion: "FINAL",
}))));
console.log(`    intent=${executed.state} attempt=${executed.paymentAttemptId}`);

step("8 reconcile", "到账归属与执行确认分开记录。", "Funds attribution is recorded separately from execution.");
const reconciled = must("reconcile", service.trade(call(treasury, "trade", body("rwaix.request.trade.v1", "demo-rec", {
  op: "RECONCILE", paymentAttemptId: executed.paymentAttemptId,
}))));
console.log(`    fundsReceiptState=${reconciled.fundsReceiptState} dischargeState=${reconciled.dischargeState}`);

step("9 apply", "清偿冲销对应应付，不删除执行记录，也不把零网络费并入价款。", "Discharge settles the payable and keeps the execution record. The zero network fee stays a separate obligation.");
const applied = must("apply", service.trade(call(treasury, "trade", body("rwaix.request.trade.v1", "demo-apply", {
  op: "APPLY", paymentAttemptId: executed.paymentAttemptId,
}))));
console.log(`    dischargeState=${applied.dischargeState}`);

step("10 dispute", "交付争议保持 OPEN。沉默不退款、不重铸、不冲正。", "The delivery dispute stays OPEN. Silence does not refund, remint, or reverse the transfer.");
const disputed = must("dispute", service.trade(call(customer, "trade", body("rwaix.request.trade.v1", "demo-dispute", {
  op: "DISPUTE",
  dispute: {
    schemaId: "rwaix.dispute.v1", disputeId: "demo-dispute", tradeId: "demo-trade", obligationId: "obl-service", claimant: customer.publicRef,
    affectedAmount: "12000", assetId: "USD_TEST", reason: "delivery-acceptance", evidenceDeadline: "2026-10-20T00:00:00Z", supplementRule: "written",
    dispositionAuthority: "named-panel", noticeRef: "notice-nft", remedyPath: "profile-dispute-v1", status: "OPEN",
  },
}))));
const sweep = must("sweep", service.trade(call(customer, "trade", body("rwaix.request.trade.v1", "demo-sweep", { op: "SWEEP" }))));
console.log(`    dispute=${disputed.status} disputesResolvedBySilence=${sweep.disputesResolvedBySilence}`);
if (sweep.disputesResolvedBySilence !== 0) process.exit(1);

const ledgers = service.exportLedgers();
const fee = ledgers.network.obligations.find((item) => item.obligationId === "obl-network");
console.log(`\nledgers objects=${ledgers.objects.length} rights=${ledgers.rights.length} networkAttempts=${ledgers.network.attempts.length} networkFee=${fee?.approved ?? "missing"}`);
if (ledgers.rights.length !== 0 || applied.dischargeState !== "DISCHARGED" || fee?.approved !== "0") process.exit(1);
console.log("demo completed: synthetic NFT trade only, no company-platform integration, no real mint, no mainnet, and no real funds");
