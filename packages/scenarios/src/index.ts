import { PROFILE_IDS, adapterFor, type ProfileId } from "@rwaix/adapter-profiles";
import type { EvidenceGraph } from "@rwaix/policy-engine";
import { ManualClock, digestPrefixed, keyFromSeed, schemaDigest, signRequest, type ActionName, type P256Key } from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";

export interface ScenarioReport {
  id: string;
  titleZh: string;
  titleEn: string;
  steps: Array<{ zh: string; en: string; ok: boolean; detail?: string }>;
  decision: string;
  reasonCodes: string[];
  policyDigest: string;
  graph: EvidenceGraph;
  feeSplit: Array<{ obligationId: string; assetId: string; amount: string; kind: string; state: string }>;
  ledgers: ReturnType<ReferenceService["exportLedgers"]>;
  reconciliation: { fundsReceiptState?: string; dischargeState?: string; disputesResolvedBySilence: number };
  outOfScope: { decision: string; reasonCodes: string[] };
  copyrightDecision: string;
  dispute: "OPEN" | "NONE";
  disclosure: {
    scopeZh: string;
    scopeEn: string;
    testsZh: string;
    testsEn: string;
    unfinishedZh: string;
    unfinishedEn: string;
  };
}

const TITLES: Record<ProfileId, { zh: string; en: string }> = {
  nft: { zh: "NFT 交易", en: "NFT trade" },
  identity: { zh: "身份资质", en: "Identity and qualification" },
  content: { zh: "内容许可", en: "Content licensing" },
  data: { zh: "数据授权", en: "Data authorization" },
  supply: { zh: "供应链批次", en: "Supply chain" },
  agent: { zh: "Agent 工作流", en: "AI agent workflow" },
  compute: { zh: "算力交付", en: "Compute delivery" },
  device: { zh: "设备服务", en: "Devices and robots" },
};

const TERMS: Record<ProfileId, Record<string, string>> = {
  nft: {
    network: "31337",
    contract: "0x00000000000000000000000000000000000000aa",
    tokenId: "1",
    workDigest: "sha256:" + "ab".repeat(32),
    licenceVersion: "licence-v1",
    licenceScope: "display-private",
    sellerControl: "seller-holds",
    recipient: "buyer-wallet",
    copyrightTransfer: "false",
  },
  identity: { qualificationId: "qual-architect", recipientOrg: "org-design" },
  content: { workVersion: "work-v3", territory: "CN", sublicense: "no" },
  data: { purpose: "design-review", recipient: "org-design", queryType: "aggregate" },
  supply: { batchId: "batch-77", inspection: "pass" },
  agent: { tool: "render", payee: "provider", redelegate: "no" },
  compute: { challengeId: "chal-demo", outputFormat: "sha256" },
  device: { taskId: "inspect-1", localSafetyPermit: "granted" },
};

const COMMERCIAL: Record<ProfileId, {
  service: string;
  fee: string;
  unit: string;
  objectType: "ASSET" | "SERVICE_COMMITMENT";
  lifecycle: "TRANSFERABLE" | "NON_TRANSFERABLE";
  pay: boolean;
}> = {
  nft: { service: "12000", fee: "0", unit: "nft", objectType: "ASSET", lifecycle: "TRANSFERABLE", pay: true },
  identity: { service: "0", fee: "0", unit: "job", objectType: "SERVICE_COMMITMENT", lifecycle: "NON_TRANSFERABLE", pay: false },
  content: { service: "100", fee: "10", unit: "job", objectType: "SERVICE_COMMITMENT", lifecycle: "NON_TRANSFERABLE", pay: true },
  data: { service: "100", fee: "10", unit: "job", objectType: "SERVICE_COMMITMENT", lifecycle: "NON_TRANSFERABLE", pay: true },
  supply: { service: "100", fee: "10", unit: "job", objectType: "SERVICE_COMMITMENT", lifecycle: "NON_TRANSFERABLE", pay: true },
  agent: { service: "100", fee: "10", unit: "job", objectType: "SERVICE_COMMITMENT", lifecycle: "NON_TRANSFERABLE", pay: true },
  compute: { service: "100", fee: "10", unit: "job", objectType: "SERVICE_COMMITMENT", lifecycle: "NON_TRANSFERABLE", pay: true },
  device: { service: "100", fee: "10", unit: "job", objectType: "SERVICE_COMMITMENT", lifecycle: "NON_TRANSFERABLE", pay: true },
};

function evidenceFor(id: ProfileId, terms: Record<string, string>, issuer: string, provider: string, meta: string): EvidenceGraph {
  const payload = { ...terms };
  if (id === "compute") {
    Object.assign(payload, {
      reservationId: "res-1",
      deviceId: "gpu-1",
      workloadDigest: meta,
      outputDigest: meta,
      quantity: "1",
      unit: "job",
    });
  }
  if (id === "supply") Object.assign(payload, { quantity: "1", unit: "lot" });
  return {
    schemaId: "rwaix.evidence.graph.v1",
    graphId: `graph-${id}`,
    nodes: [
      {
        nodeId: "cred",
        nodeType: "CREDENTIAL",
        sourceId: "issuer",
        controllerId: issuer,
        contentDigest: meta,
        issuer,
        capturedAt: "2026-10-11T00:00:00Z",
      },
      {
        nodeId: "obs",
        nodeType: "OBSERVATION",
        sourceId: "source",
        controllerId: provider,
        contentDigest: meta,
        capturedAt: "2026-10-11T00:00:00Z",
        payload,
      },
    ],
    edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
  };
}

export function runProfile(id: ProfileId): ScenarioReport {
  const clock = new ManualClock("2026-10-11T00:00:00Z");
  const verifier = keyFromSeed(`scenario-${id}-verifier`);
  const customer = keyFromSeed(`scenario-${id}-customer`);
  const provider = keyFromSeed(`scenario-${id}-provider`);
  const issuer = keyFromSeed(`scenario-${id}-issuer`);
  const executor = keyFromSeed(`scenario-${id}-executor`);
  const treasury = keyFromSeed(`scenario-${id}-treasury`);
  const admin = keyFromSeed(`scenario-${id}-admin`);
  const service = new ReferenceService({
    clock,
    verifier,
    grants: [
      { signer: executor.publicRef, role: "EXECUTOR" },
      { signer: treasury.publicRef, role: "TREASURY" },
      { signer: admin.publicRef, role: "STATUS_ADMIN" },
    ],
  });
  const adapter = adapterFor(id, issuer.publicRef);
  const price = COMMERCIAL[id];
  const terms = { ...TERMS[id] };
  if (id === "agent") terms.payee = provider.publicRef;
  const meta = digestPrefixed({ profile: id });
  let n = 0;
  const call = (key: P256Key, action: ActionName, request: Record<string, unknown>) => {
    n += 1;
    return signRequest(key, action, request, { nonce: `${id}-${n.toString().padStart(8, "0")}`, deadline: "2027-01-01T00:00:00Z" });
  };
  const body = (schemaId: string, idem: string, extra: Record<string, unknown>) => ({ schemaId, protocolVersion: "rwaix-0.1.0", idempotencyKey: idem, ...extra });
  const steps: ScenarioReport["steps"] = [];
  const note = (zh: string, en: string, ok: boolean, detail?: string) => steps.push({ zh, en, ok, ...(detail ? { detail } : {}) });

  service.registerObject(call(provider, "registerObject", body("rwaix.request.registerObject.v1", `${id}-reg`, {
    objectId: `${id}-obj`, objectType: price.objectType, controller: provider.publicRef, subjectRef: `${id}-subject`,
    lifecyclePolicy: price.lifecycle, metadataDigest: meta,
  })));
  service.publishVersion(call(provider, "publishVersion", body("rwaix.request.publishVersion.v1", `${id}-ver`, {
    objectId: `${id}-obj`, bindingVersion: "1", contentDigest: meta, metadataDigest: meta, subjectBinding: `${id}-subject`,
  })));
  service.setStatus(call(admin, "setStatus", body("rwaix.request.setStatus.v1", `${id}-st`, { subjectRef: `${id}-subject`, status: "ACTIVE" })));
  note("bind 绑定：登记对象并发布版本。调用方不需要持有测试代币。", "bind: register the object and publish version 1. Token holdings are not required.", true);

  const envelope = {
    schemaId: "rwaix.trade.envelope.v1",
    protocolVersion: "rwaix-0.1.0",
    profileId: adapter.profileId,
    profileVersion: "1.0.0",
    schemaDigest: schemaDigest("rwaix.trade.envelope.v1"),
    tradeId: `${id}-trade`,
    termsDigest: digestPrefixed(terms),
    parties: [
      { partyId: customer.publicRef, role: "CUSTOMER", authorityRef: "auth-customer" },
      { partyId: provider.publicRef, role: "PROVIDER", authorityRef: "auth-provider" },
    ],
    objects: [{ objectId: `${id}-obj`, quantity: "1", unit: price.unit }],
    obligations: [
      { obligationId: `${id}-service`, kind: "SERVICE", amount: price.service, assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" },
      { obligationId: `${id}-fee`, kind: "NETWORK_FEE", amount: price.fee, assetId: "RWAIX_TEST", decimals: 18, rounding: "EXACT_INTEGER" },
    ],
    acceptanceRule: "CUSTOMER_SIGNATURE",
    timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" },
    paymentTerms: { trigger: "ACCEPTANCE" },
    applicableDocuments: [meta],
    disputePath: "profile-dispute-v1",
    terms,
    extensions: {},
  };
  const opened = service.trade(call(customer, "trade", body("rwaix.request.trade.v1", `${id}-open`, { op: "OPEN", envelope })));
  note(
    "commit 承诺：双方签署同一条款摘要。价款与网络费分成两笔义务。验收后付款是本演示选定的顺序，不代表真实合同不能使用预付款或分期款。",
    "commit: both parties sign one terms digest. Price and network fee are separate obligations. Acceptance-then-payment is the selected demo order, not a limit on a real prepay or installment.",
    opened.ok,
    opened.ok ? envelope.termsDigest : opened.error,
  );

  const graph = evidenceFor(id, terms, issuer.publicRef, provider.publicRef, meta);
  const context = {
    schemaId: "rwaix.context.v1",
    protocolVersion: "rwaix-0.1.0",
    audience: adapter.buildPolicy().rules.find((rule) => rule.predicate === "audienceEquals")?.params.audience,
    purpose: adapter.buildPolicy().rules.find((rule) => rule.predicate === "purposeEquals")?.params.purpose,
    objectRef: { objectId: `${id}-obj`, bindingVersion: "1" },
    requestedAction: adapter.buildPolicy().rules.find((rule) => rule.predicate === "actionAllowlist")?.params.actions,
    domain: id,
    subjectRef: `${id}-subject`,
    challengeNonce: `${id}-nonce-01`,
    deadline: "2026-12-01T00:00:00Z",
    policyVersion: "1.0.0",
  };
  const actionList = context.requestedAction as string[] | undefined;
  const fixedContext = { ...context, requestedAction: actionList?.[0] ?? "compute.deliver" };
  const policy = adapter.buildPolicy();
  const evaluate = (g: EvidenceGraph, idem: string) => service.evaluatePolicy(call(customer, "evaluatePolicy", body("rwaix.request.evaluatePolicy.v1", idem, {
    context: fixedContext, policy, graph: g, statusSnapshot: {
      schemaId: "rwaix.status.snapshot.v1", snapshotId: `${id}-snap`, asOf: "2026-10-11T00:00:00Z",
      entries: [{ subjectRef: `${id}-subject`, status: "ACTIVE" }],
    },
    terms, evaluationTime: "2026-10-11T00:00:00Z", startedAtMs: 0, nowMs: 1,
  })));
  const allow = evaluate(graph, `${id}-allow`);
  const mismatch = evidenceFor(id, { ...terms, [Object.keys(terms)[0] ?? "x"]: "out-of-scope" }, issuer.publicRef, provider.publicRef, meta);
  mismatch.graphId = `${id}-mismatch`;
  const denied = evaluate(mismatch, `${id}-deny`);
  note(
    "verify 核验：范围内证据得到 ALLOW，并固定 policyDigest。越范围证据得到 DENY。回执不能代替验收。",
    "verify: in-scope evidence is ALLOW and pins policyDigest. Out-of-scope evidence is DENY. The receipt does not replace acceptance.",
    allow.ok && allow.value.decision.decision === "ALLOW" && denied.ok && denied.value.decision.decision === "DENY",
    denied.ok ? denied.value.decision.reasonCodes.join(",") : denied.error,
  );
  let copyrightDecision = "n/a";
  if (id === "nft") {
    const copied = evidenceFor(id, { ...terms, copyrightTransfer: "true" }, issuer.publicRef, provider.publicRef, meta);
    copied.graphId = `${id}-copyright`;
    const deniedCopy = evaluate(copied, `${id}-copy`);
    copyrightDecision = deniedCopy.ok ? deniedCopy.value.decision.decision : "ERROR";
    note(
      "verify 核验：已签条款保持 copyrightTransfer=false。把交付证据改成 true 得到 DENY。权源核验不保证原创，也不排除第三方权利请求。",
      "verify: signed terms keep copyrightTransfer false. Evidence that sets it to true is DENY. The rights check does not guarantee originality or rule out a third-party claim.",
      copyrightDecision === "DENY" && deniedCopy.ok && deniedCopy.value.decision.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH"),
      deniedCopy.ok ? deniedCopy.value.decision.reasonCodes.join(",") : deniedCopy.error,
    );
  }

  if (allow.ok) {
    const delivered = service.trade(call(provider, "trade", body("rwaix.request.trade.v1", `${id}-del`, {
      op: "EVENT",
      event: {
        schemaId: "rwaix.trade.event.v1", eventId: `${id}-d1`, tradeId: `${id}-trade`, obligationApplicable: true, obligationId: `${id}-service`,
        eventType: "DELIVERED", actor: provider.publicRef, authorityRef: "auth-provider", streamId: `${id}-del`, sourceId: "delivery",
        prevEventDigest: "genesis", sequence: "1", causalRefs: [], effectiveAt: "2026-10-11T00:00:00Z", evidenceRefs: [],
        quantity: "1", unit: price.unit, signingDomain: "rwaix.signing.v1",
      },
    })));
    note("deliver 交付：提供方记录数量 1。卖方签名不是客户已取得全部权利。", "deliver: the provider records quantity 1. A seller signature is not receipt of every agreed right.", delivered.ok, delivered.ok ? "" : delivered.error);
    if (id === "nft") {
      const partial = service.trade(call(customer, "trade", body("rwaix.request.trade.v1", `${id}-partial`, {
        op: "ACCEPT",
        acceptance: {
          schemaId: "rwaix.acceptance.v1", acceptanceId: `${id}-partial`, tradeId: `${id}-trade`, obligationId: `${id}-service`, portionId: "p-partial",
          objectVersion: "1", quantity: "0", unit: price.unit, acceptor: customer.publicRef, authorityRef: "auth-customer", acceptedAt: "2026-10-11T00:00:00Z",
        },
      })));
      note(
        "accept 验收：不可分割 NFT 拒绝部分验收，不以部分验收虚构部分转移。",
        "accept: an indivisible NFT rejects a partial acceptance and does not invent a partial transfer.",
        !partial.ok && partial.error === "STATE_CONFLICT",
        partial.ok ? "accepted" : partial.error,
      );
    }
    const accepted = service.trade(call(customer, "trade", body("rwaix.request.trade.v1", `${id}-acc`, {
      op: "ACCEPT",
      acceptance: {
        schemaId: "rwaix.acceptance.v1", acceptanceId: `${id}-acc`, tradeId: `${id}-trade`, obligationId: `${id}-service`, portionId: "p1",
        objectVersion: "1", quantity: "1", unit: price.unit, acceptor: customer.publicRef, authorityRef: "auth-customer", acceptedAt: "2026-10-11T00:00:00Z",
      },
    })));
    note("accept 验收：客户另行签署一个完整 portion。验收独立于 TrustReceipt。", "accept: the customer separately signs one full portion. Acceptance is independent of the TrustReceipt.", accepted.ok, accepted.ok ? "" : accepted.error);
    if (!price.pay) {
      note(
        "apply 分账：身份场景的价款与网络费均为零，验收后结束，不执行无意义付款。两笔义务仍然分开。",
        "apply: identity price and network fee are both zero. The scenario ends after acceptance and does not execute a payment. The two obligations stay separate.",
        delivered.ok && accepted.ok,
      );
    } else {
      const authorized = service.trade(call(treasury, "trade", body("rwaix.request.trade.v1", `${id}-auth`, { op: "AUTHORIZE", obligationId: `${id}-service` })));
      note("authorize 授权：资金角色单独授权价款。回执不是付款授权。", "authorize: a treasury role authorizes the price. The receipt is not that authorization.", authorized.ok, authorized.ok ? "" : authorized.error);
      service.network.registerAsset({ assetId: "USD_TEST", chainId: "0", contractAddress: "0x0000000000000000000000000000000000000001", decimals: 2, kind: "FIAT_TEST" });
      const preparedSigned = call(executor, "prepareIntent", body("rwaix.request.prepareIntent.v1", `${id}-prep`, {
        intentId: `${id}-intent`, receiptId: allow.value.receipt.receiptId, action: "pay", payer: customer.publicRef, payee: provider.publicRef,
        assetId: "USD_TEST", amount: price.service, obligationId: `${id}-service`, intentNonce: `${id}-intent-01`, intentDeadline: "2026-12-01T00:00:00Z", maxStalenessSeconds: "86400",
      }));
      const prepared = service.prepareIntent(preparedSigned);
      const replay = service.prepareIntent(preparedSigned);
      const replaySame = prepared.ok && replay.ok && replay.value.paymentAttemptId === prepared.value.paymentAttemptId;
      const executed = prepared.ok ? service.executeIntent(call(executor, "executeIntent", body("rwaix.request.executeIntent.v1", `${id}-exec`, {
        intentId: prepared.value.intentId, mode: "CONFIRM", inclusion: "FINAL",
      }))) : prepared;
      const covered = executed.ok && service.network.coverage(`${id}-service`) === BigInt(price.service);
      const second = executed.ok ? service.prepareIntent(call(executor, "prepareIntent", body("rwaix.request.prepareIntent.v1", `${id}-prep-2`, {
        intentId: `${id}-intent-2`, receiptId: allow.value.receipt.receiptId, action: "pay", payer: customer.publicRef, payee: provider.publicRef,
        assetId: "USD_TEST", amount: price.service, obligationId: `${id}-service`, intentNonce: `${id}-intent-02`, intentDeadline: "2026-12-01T00:00:00Z", maxStalenessSeconds: "86400",
      }))) : executed;
      note(
        "submit 提交：终局后执行。重复提交复用同一 paymentAttemptId。执行确认不提前释放覆盖额度。",
        "submit: execute after finality. A repeated submit reuses the same paymentAttemptId. Execution confirmation does not release coverage early.",
        replaySame && covered && !second.ok && second.error === "OVERSPEND",
        second.ok ? "second payment was accepted" : second.error,
      );
      const reconciled = executed.ok ? service.trade(call(treasury, "trade", body("rwaix.request.trade.v1", `${id}-rec`, {
        op: "RECONCILE", paymentAttemptId: executed.value.paymentAttemptId,
      }))) : executed;
      note("reconcile 对账：到账归属与执行确认分开记录。", "reconcile: funds attribution is recorded separately from execution.", reconciled.ok, reconciled.ok ? String(reconciled.value.fundsReceiptState) : reconciled.error);
      const applied = executed.ok ? service.trade(call(treasury, "trade", body("rwaix.request.trade.v1", `${id}-apply`, {
        op: "APPLY", paymentAttemptId: executed.value.paymentAttemptId,
      }))) : executed;
      note("apply 分账清偿：清偿服务价款，保留执行记录，网络费义务仍然分开。", "apply: discharge the service price, keep the execution record, and leave the network fee as its own obligation.", applied.ok && applied.value.dischargeState === "DISCHARGED", applied.ok ? String(applied.value.dischargeState) : applied.error);
    }
  }

  let dispute: ScenarioReport["dispute"] = "NONE";
  if (id === "nft") {
    const openedDispute = service.trade(call(customer, "trade", body("rwaix.request.trade.v1", `${id}-dispute`, {
      op: "DISPUTE",
      dispute: {
        schemaId: "rwaix.dispute.v1", disputeId: `${id}-dispute`, tradeId: `${id}-trade`, obligationId: `${id}-service`, claimant: customer.publicRef,
        affectedAmount: "12000", assetId: "USD_TEST", reason: "delivery-acceptance", evidenceDeadline: "2026-10-20T00:00:00Z", supplementRule: "written",
        dispositionAuthority: "named-panel", noticeRef: "notice-nft", remedyPath: "profile-dispute-v1", status: "OPEN",
      },
    })));
    dispute = openedDispute.ok ? "OPEN" : "NONE";
    note(
      "dispute 争议：交付争议保持 OPEN。沉默不退款、不重铸、不冲正已清偿记录。",
      "dispute: the delivery dispute stays OPEN. Silence does not refund, remint, or reverse the discharged record.",
      dispute === "OPEN",
    );
  }

  const sweep = service.trade(call(customer, "trade", body("rwaix.request.trade.v1", `${id}-sweep`, { op: "SWEEP" })));
  const ledgers = service.exportLedgers();
  const serviceAttempt = ledgers.network.attempts.find((item) => item.obligationId === `${id}-service`);
  return {
    id,
    titleZh: TITLES[id].zh,
    titleEn: TITLES[id].en,
    steps,
    decision: allow.ok ? allow.value.decision.decision : "ERROR",
    reasonCodes: allow.ok ? allow.value.decision.reasonCodes : [allow.error],
    policyDigest: allow.ok ? allow.value.receipt.policyDigest : "",
    graph,
    feeSplit: [
      { obligationId: `${id}-service`, assetId: "USD_TEST", amount: price.service, kind: "SERVICE", state: serviceAttempt?.dischargeState ?? "NONE" },
      { obligationId: `${id}-fee`, assetId: "RWAIX_TEST", amount: price.fee, kind: "NETWORK_FEE", state: "OPEN" },
    ],
    ledgers,
    reconciliation: {
      ...(serviceAttempt ? { fundsReceiptState: serviceAttempt.fundsReceiptState, dischargeState: serviceAttempt.dischargeState } : {}),
      disputesResolvedBySilence: sweep.ok ? Number(sweep.value.disputesResolvedBySilence) : -1,
    },
    outOfScope: {
      decision: denied.ok ? denied.value.decision.decision : "ERROR",
      reasonCodes: denied.ok ? denied.value.decision.reasonCodes : [denied.error],
    },
    copyrightDecision,
    dispute,
    disclosure: disclosureFor(id, steps),
  };
}

const SCOPE: Record<ProfileId, { zh: string; en: string }> = {
  nft: {
    zh: "合成 nft.trade：一件普通作品对象，数量 1，一个 portion，USD_TEST 12000，RWAIX_TEST 网络费 0。许可留在条款里。不铸造设施 DCNFT，不连接公司平台。单个不可分对象和零网络费不是公司现有全部 NFT 产品的结构、收费或法律分类。",
    en: "Synthetic nft.trade: one ordinary artwork, quantity 1, one portion, USD_TEST 12000, RWAIX_TEST network fee 0. The licence stays in the terms. No facility DCNFT and no company platform. The indivisible object and zero fee do not describe every existing company NFT product.",
  },
  identity: {
    zh: "合成身份资质。价款与网络费均为 0，验收后结束。密钥控制不证明自然人唯一，资质不能随资产 NFT 出售。",
    en: "Synthetic qualification. Price and network fee are both 0, and the flow ends after acceptance. Key control does not prove a unique person, and a qualification is not sold with an asset NFT.",
  },
  content: {
    zh: "合成内容许可。作品版本、地域和转授权写入已签条款。时间戳不证明著作权。作品 NFT 不是设施 DCNFT。",
    en: "Synthetic content licence. Work version, territory, and sublicense are signed terms. A timestamp does not prove copyright. A work NFT is not a facility DCNFT.",
  },
  data: {
    zh: "合成数据授权。用途、接收方和查询类型写入已签条款。链上承诺不保证载荷保密，持有测试代币不购买训练权。",
    en: "Synthetic data authorization. Purpose, recipient, and query type are signed terms. An on-chain commitment does not keep the payload confidential.",
  },
  supply: {
    zh: "合成供应链批次。批次和检验写入已签条款。签名标识声明人，不证明箱内实物。货款与核验费分开。",
    en: "Synthetic supply batch. Batch and inspection are signed terms. A signature names the declarant and does not prove the contents of a box.",
  },
  agent: {
    zh: "合成 Agent 工作流。工具、收款方和再委派写入已签条款。不可信文本不能扩大授权。服务编排不是购买或转让 DCNFT 的许可。",
    en: "Synthetic agent workflow. Tool, payee, and redelegation are signed terms. Untrusted text cannot widen a grant. Orchestration is not permission to buy or transfer a DCNFT.",
  },
  compute: {
    zh: "合成算力交付，属于第 18.6 节后续扩展，不是首个计划应用。挑战和输出格式写入已签条款。DCNFT 系列引用不支付账单，也不在此铸造。",
    en: "Synthetic compute delivery, a section 18.6 extension, not the first planned application. Challenge and output format are signed terms. A DCNFT series reference does not pay the invoice and is not minted here.",
  },
  device: {
    zh: "合成设备服务。任务和本地安全许可写入已签条款。链上终局不代替本地急停。低余额不得阻断安全动作。",
    en: "Synthetic device service. Task and local safety permit are signed terms. Chain finality does not replace a local emergency stop. A low balance must not block a safety action.",
  },
};

function disclosureFor(id: ProfileId, steps: ScenarioReport["steps"]): ScenarioReport["disclosure"] {
  const passed = steps.filter((step) => step.ok).length;
  return {
    scopeZh: SCOPE[id].zh,
    scopeEn: SCOPE[id].en,
    testsZh: `本进程本次运行记录 ${passed}/${steps.length} 个可见步骤。范围内 ALLOW、越范围 DENY、价款与网络费分账均在上述步骤中。这不是白皮书归档的 50/50，也不是 N01–N10 认证。`,
    testsEn: `This process recorded ${passed}/${steps.length} visible steps, including in-scope ALLOW, out-of-scope DENY, and the price versus network-fee split. This is not the archived 50/50 count and not an N01–N10 certification.`,
    unfinishedZh: "未完成的生产条件：不连接公司平台、真实链、真实资金、真实 NFT 铸造或转移、真实设备或 GPU，也不连接主网。第 21 节的下一阶段工程（获准测试网、两个独立实现交换证据包、生产持久化）不在本声明内。本地 PGlite 或 Postgres 日志不是生产高可用。2026-10-12 是白皮书的整理复核日，不表示本进程重跑了该日归档的 50/50 记录。",
    unfinishedEn: "Unfinished production conditions: no company platform, real chain, real funds, real NFT mint or transfer, real device or GPU, and no mainnet. Section 21's later engineering stage is outside this claim. Local PGlite or Postgres is not production HA. 2026-10-12 is the whitepaper's collation date, not a re-run of the archived 50/50 record.",
  };
}

export function runAllProfiles(): ScenarioReport[] {
  return PROFILE_IDS.map((id) => runProfile(id));
}

export { PROFILE_IDS };
export { runCrossScenario } from "./cross.js";
