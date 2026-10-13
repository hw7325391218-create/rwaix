const state = { lang: "zh" };
const view = { id: "", body: null };

function icon(path) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

const ICONS = {
  nft: icon(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>`),
  identity: icon(`<circle cx="12" cy="8" r="3"/><path d="M5 19c1.4-3 3.6-4.5 7-4.5S17.6 16 19 19"/>`),
  content: icon(`<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>`),
  data: icon(`<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>`),
  supply: icon(`<path d="M3 7h12v8H3z"/><path d="M15 10h3l2 2.5V15h-5"/><circle cx="7" cy="18" r="1.4"/><circle cx="17" cy="18" r="1.4"/>`),
  agent: icon(`<rect x="7" y="8" width="10" height="8" rx="2"/><path d="M12 8V5M9 12h.01M15 12h.01"/>`),
  compute: icon(`<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z"/>`),
  device: icon(`<rect x="8" y="2" width="8" height="20" rx="2"/><path d="M11 18h2"/>`),
  cross: icon(`<path d="M8 8h8v8H8z"/><path d="M4 4l4 4M20 4l-4 4M4 20l4-4M20 20l-4-4"/>`),
};

function text(node) {
  const value = node.dataset[state.lang];
  if (value) node.textContent = value;
}

function themeName() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function paintThemeButton() {
  const button = document.querySelector("#theme");
  if (!button) return;
  const dark = themeName() === "dark";
  button.textContent = state.lang === "zh" ? (dark ? "浅色" : "深色") : (dark ? "Light" : "Dark");
  button.setAttribute("aria-pressed", dark ? "true" : "false");
}

function applyLanguage() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-zh]").forEach(text);
  const button = document.querySelector("#lang");
  button.textContent = state.lang === "zh" ? "English" : "中文";
  paintThemeButton();
  paint();
  if (document.querySelector("#network-banner")?.textContent) showNetwork();
}

try {
  if (localStorage.getItem("rwaix-theme") === "light") document.documentElement.dataset.theme = "light";
} catch {
  /* storage unavailable */
}

document.querySelector("#theme").addEventListener("click", () => {
  const next = themeName() === "dark" ? "light" : "dark";
  if (next === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem("rwaix-theme", next);
  } catch {
    /* storage unavailable */
  }
  paintThemeButton();
});

document.querySelector("#lang").addEventListener("click", () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  applyLanguage();
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
}

function statusKind(value) {
  const text = String(value ?? "").toUpperCase();
  if (["ALLOW", "PASS", "OK", "DISCHARGED", "ATTRIBUTED", "ACTIVE", "CONFIRMED_EXECUTION"].includes(text)) return "ok";
  if (["DENY", "FAIL", "ERROR", "FAILED_CONFIRMED", "REVOKED", "OVERSPEND"].includes(text)) return "bad";
  if (["OPEN", "PENDING", "SUBMITTED", "RESERVED", "OUTCOME_UNKNOWN"].includes(text)) return "warn";
  return "muted";
}

function badge(value) {
  const raw = String(value ?? "");
  if (!raw) return "";
  return `<span class="badge badge-${statusKind(raw)}">${escapeHtml(raw)}</span>`;
}

function table(target, headers, rows) {
  target.innerHTML = `<thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
}

function labels(zh, en) {
  return state.lang === "zh" ? zh : en;
}

function showDisclosure(disclosure) {
  const box = document.querySelector("#scope");
  if (!disclosure) {
    box.textContent = "";
    return;
  }
  const pick = (zh, en) => escapeHtml(state.lang === "zh" ? zh : en);
  const names = labels(
    ["实现范围", "记录测试", "未完成的生产条件"],
    ["Scope", "Recorded tests", "Unfinished production conditions"],
  );
  box.className = "disclosure";
  box.innerHTML = [
    [names[0], pick(disclosure.scopeZh, disclosure.scopeEn)],
    [names[1], pick(disclosure.testsZh, disclosure.testsEn)],
    [names[2], pick(disclosure.unfinishedZh, disclosure.unfinishedEn)],
  ].map(([label, text]) => `<p><strong>${label}</strong> ${text}</p>`).join("");
}

function renderSteps(title, steps, decision) {
  const pass = labels("通过", "Pass");
  const fail = labels("未通过", "Check");
  const items = steps.map((step, index) => `<li class="step ${step.ok ? "is-ok" : "is-bad"}" style="--i:${index}">
      <span class="step-index">${String(index + 1).padStart(2, "0")}</span>
      <div>
        <p class="step-title">${escapeHtml(state.lang === "zh" ? step.zh : step.en)}</p>
        ${step.detail ? `<p class="step-detail">${escapeHtml(step.detail)}</p>` : ""}
      </div>
      <span class="badge ${step.ok ? "badge-ok" : "badge-bad"}">${step.ok ? pass : fail}</span>
    </li>`).join("");
  return `<div class="card-head"><h2>${escapeHtml(title)}</h2>${decision ? badge(decision) : ""}</div><ol class="stepper">${items}</ol>`;
}

function renderGraph(target, graph, caption) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (!nodes.length) {
    target.innerHTML = `<p class="empty">${escapeHtml(labels("没有证据节点。", "No evidence nodes."))}</p>${caption || ""}`;
    return;
  }
  const width = Math.max(640, 160 + nodes.length * 220);
  const height = 220;
  const pos = new Map();
  nodes.forEach((node, index) => {
    const x = nodes.length === 1 ? width / 2 : 120 + index * ((width - 240) / (nodes.length - 1));
    pos.set(node.nodeId, { x, y: 110 });
  });
  const edgeSvg = edges.map((edge) => {
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (!from || !to) return "";
    const forward = from.x <= to.x;
    const x1 = from.x + (forward ? 92 : -92);
    const x2 = to.x + (forward ? -92 : 92);
    const mx = (from.x + to.x) / 2;
    const my = Math.min(from.y, to.y) - 28;
    return `<line class="edge" x1="${x1}" y1="${from.y}" x2="${x2}" y2="${to.y}" marker-end="url(#arrow)" /><text class="edge-label" x="${mx}" y="${my}">${escapeHtml(edge.edgeType)}</text>`;
  }).join("");
  const nodeSvg = nodes.map((node) => {
    const point = pos.get(node.nodeId);
    const digest = String(node.contentDigest || "").replace(/^sha256:/, "").slice(0, 10);
    return `<g><rect x="${point.x - 88}" y="${point.y - 34}" width="176" height="68" rx="16" /><text class="node-type" x="${point.x}" y="${point.y - 6}">${escapeHtml(node.nodeType || node.nodeId)}</text><text class="node-id" x="${point.x}" y="${point.y + 16}">${escapeHtml(node.nodeId)}${digest ? ` · ${escapeHtml(digest)}` : ""}</text></g>`;
  }).join("");
  target.innerHTML = `<div class="graph-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(labels("证据图", "Evidence graph"))}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path class="arrow-head" d="M0 0 L6 3 L0 6 Z" /></marker></defs>${edgeSvg}${nodeSvg}</svg></div>${caption || ""}`;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${badge(value) || escapeHtml(value)}</strong></div>`;
}

function renderReceipt(target, fields, digest) {
  target.innerHTML = `<div class="metrics">${fields.map(([label, value]) => metric(label, value)).join("")}</div>${digest ? `<p class="digest">${escapeHtml(digest)}</p>` : ""}`;
}

function feeHeaders() {
  return labels(["义务", "资产", "金额", "类型", "状态"], ["Obligation", "Asset", "Amount", "Kind", "State"]);
}

function renderFees(rows) {
  table(
    document.querySelector("#fees"),
    feeHeaders(),
    rows.map((item) => [
      escapeHtml(item.obligationId),
      escapeHtml(item.assetId),
      escapeHtml(item.amount),
      escapeHtml(item.kind),
      item.state ? badge(item.state) : escapeHtml("—"),
    ]),
  );
}

function renderLedgers(target, ledgers, reconciliation) {
  const attempts = ledgers?.network?.attempts ?? [];
  const rights = ledgers?.rights ?? [];
  const objects = ledgers?.objects ?? [];
  const recon = reconciliation ?? {};
  const chips = [
    recon.dischargeState ? metric(labels("清偿", "Discharge"), recon.dischargeState) : "",
    recon.fundsReceiptState ? metric(labels("资金回执", "Funds receipt"), recon.fundsReceiptState) : "",
    metric(labels("沉默结案", "Closed by silence"), String(recon.disputesResolvedBySilence ?? 0)),
  ].join("");
  const attemptRows = attempts.map((item) => [
    escapeHtml(item.obligationId),
    escapeHtml(item.assetId),
    escapeHtml(item.amount),
    badge(item.fundsReceiptState),
    badge(item.dischargeState),
    badge(item.outcome),
  ]).join("");
  const objectRows = objects.map((item) => [
    escapeHtml(item.objectId),
    escapeHtml(item.objectType),
    badge(item.lifecycleState),
  ]).join("");
  const rightsBody = rights.length
    ? `<div class="table-wrap"><table><thead><tr><th>${escapeHtml(labels("系列", "Series"))}</th><th>${escapeHtml(labels("对象", "Object"))}</th></tr></thead><tbody>${rights.map((item) => `<tr><td>${escapeHtml(item.seriesId)}</td><td>${escapeHtml(item.objectId)}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="empty">${escapeHtml(labels("权利账本没有绑定记录。", "The rights ledger has no bindings."))}</p>`;
  target.innerHTML = `<div class="stack">
    <div class="metrics">${chips}</div>
    <div>
      <p class="subhead">${escapeHtml(labels("支付尝试", "Payment attempts"))}</p>
      <div class="table-wrap"><table><thead><tr>${labels(["义务", "资产", "金额", "资金", "清偿", "结果"], ["Obligation", "Asset", "Amount", "Funds", "Discharge", "Outcome"]).map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${attemptRows}</tbody></table></div>
    </div>
    <div>
      <p class="subhead">${escapeHtml(labels("对象", "Objects"))}</p>
      <div class="table-wrap"><table><thead><tr>${labels(["对象", "类型", "生命周期"], ["Object", "Type", "Lifecycle"]).map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${objectRows}</tbody></table></div>
    </div>
    <div>
      <p class="subhead">${escapeHtml(labels("权利账本", "Rights ledger"))}</p>
      ${rightsBody}
    </div>
  </div>`;
}

function showReport(report) {
  const title = state.lang === "zh" ? report.titleZh : report.titleEn;
  document.querySelector("#steps").innerHTML = renderSteps(title, report.steps, report.decision);
  renderGraph(document.querySelector("#graph"), report.graph);
  const names = labels(
    ["决定", "著作权", "争议", "越范围"],
    ["Decision", "Copyright", "Dispute", "Out of scope"],
  );
  renderReceipt(document.querySelector("#receipt"), [
    [names[0], report.decision],
    [names[1], report.copyrightDecision],
    [names[2], report.dispute],
    [names[3], report.outOfScope?.decision],
  ], report.policyDigest);
  renderFees(report.feeSplit);
  renderLedgers(document.querySelector("#ledgers"), report.ledgers, report.reconciliation);
  showDisclosure(report.disclosure);
}

async function run(id) {
  document.querySelectorAll("#scenarios button").forEach((button) => button.setAttribute("aria-pressed", button.dataset.id === id ? "true" : "false"));
  const response = await fetch(`/api/scenarios/${id}/run`, { method: "POST" });
  view.id = id;
  view.body = await response.json();
  paint();
}

function paint() {
  const body = view.body;
  if (!body) return;
  if (view.id === "cross") {
    const title = state.lang === "zh" ? (body.titleZh ?? "跨场景链路") : (body.titleEn ?? "Cross-scenario chain");
    if (!body.ok) {
      document.querySelector("#steps").innerHTML = `<div class="card-head"><h2>${escapeHtml(title)}</h2>${badge("ERROR")}</div><p class="empty">${escapeHtml(body.detail)}</p>`;
      return;
    }
    const trades = body.trades ?? [];
    document.querySelector("#steps").innerHTML = renderSteps(title, [
      ...trades.map((trade) => ({ zh: trade, en: trade, ok: true })),
      { zh: `争议 ${body.dispute}`, en: `Dispute ${body.dispute}`, ok: body.dispute === "OPEN" },
    ], body.ok ? "ALLOW" : "ERROR");
    const budget = body.budget ?? {};
    renderGraph(
      document.querySelector("#graph"),
      {
        nodes: trades.map((trade) => ({ nodeId: trade, nodeType: "TRADE", contentDigest: "" })),
        edges: trades.slice(1).map((trade, index) => ({ from: trades[index], to: trade, edgeType: "THEN" })),
      },
      `<p class="caption">${escapeHtml(labels("父预算", "Parent budget"))} ${escapeHtml(budget.parentCap ?? "")} · ${escapeHtml((budget.children ?? []).join(" + "))} · ${escapeHtml(budget.rejected ?? "")}</p>`,
    );
    renderReceipt(document.querySelector("#receipt"), [
      [labels("争议", "Dispute"), body.dispute],
      [labels("沉默结案", "Closed by silence"), String(body.reconciliation?.disputesResolvedBySilence ?? 0)],
    ]);
    renderFees(body.feeSplit ?? []);
    renderLedgers(document.querySelector("#ledgers"), body.ledgers, body.reconciliation);
    showDisclosure({
      scopeZh: "第 19 节是 NFT 首期之后的跨场景扩展。资格、许可和算力使用各自的 tradeId 与 obligationId。",
      scopeEn: "Section 19 is the cross-scenario extension after the NFT profile. Qualification, licence, and compute keep separate trade and obligation ids.",
      testsZh: "本进程记录三笔分开的交易、父预算约束，以及一笔保持 OPEN 的争议。沉默不关闭争议。",
      testsEn: "This process records three separate trades, a parent budget constraint, and one dispute that stays OPEN. Silence does not close it.",
      unfinishedZh: "这不是公司平台接入，也不是第 21 节的下一阶段工程交付。",
      unfinishedEn: "This is not a company-platform integration and not the section 21 later engineering delivery.",
    });
    return;
  }
  showReport(body);
}

async function conformance() {
  const response = await fetch("/api/conformance");
  const body = await response.json();
  document.querySelector("#claim").textContent = body.conformanceClaim?.statement ?? "";
  table(
    document.querySelector("#modules"),
    labels(["模块", "状态"], ["Module", "Status"]),
    (body.modules ?? []).map((item) => [escapeHtml(item.moduleId), badge(item.status)]),
  );
}

const TITLES = {
  nft: { zh: "NFT 交易", en: "NFT trade" },
  identity: { zh: "身份资质", en: "Identity and qualification" },
  content: { zh: "内容许可", en: "Content licensing" },
  data: { zh: "数据授权", en: "Data authorization" },
  supply: { zh: "供应链批次", en: "Supply chain" },
  agent: { zh: "Agent 工作流", en: "AI agent workflow" },
  compute: { zh: "算力交付", en: "Compute delivery" },
  device: { zh: "设备服务", en: "Devices and robots" },
  cross: { zh: "跨场景扩展", en: "Cross-scenario extension" },
};

document.querySelector("#fresh").addEventListener("click", () => run(view.id || "nft"));
document.querySelector("#export").addEventListener("click", () => {
  if (!view.body) return;
  const blob = new Blob([JSON.stringify(view.body, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `rwaix-${view.id || "scenario"}-review.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
});

const nav = document.querySelector("#scenarios");
const response = await fetch("/api/scenarios");
const catalog = await response.json();
for (const id of [...catalog.scenarios, "cross"]) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.id = id;
  const title = TITLES[id] ?? { zh: id, en: id };
  button.innerHTML = `${ICONS[id] ?? ""}<span data-zh="${escapeHtml(title.zh)}" data-en="${escapeHtml(title.en)}"></span>`;
  button.addEventListener("click", () => run(id));
  nav.append(button);
}

async function showNetwork() {
  const response = await fetch("/api/network");
  const body = await response.json();
  const banner = document.querySelector("#network-banner");
  if (body.mainnet) {
    banner.className = "banner-mainnet";
    banner.textContent = state.lang === "zh"
      ? "MAINNET 主网。索引器跟随已确认的主网 RPC。此页面不代签、不铸造、不预挖、不出售。发行需要法律与合规签署。这不是专业审计。"
      : "MAINNET. The indexer follows the confirmed mainnet RPC. This page does not sign, mint, premine, or sell. Issuance requires legal and compliance sign-off. This is not a professional audit.";
    return;
  }
  banner.className = "banner-test";
  banner.textContent = state.lang === "zh"
    ? `网络 ${body.name} · chain id ${body.chainId} · 默认本地测试`
    : `Network ${body.name} · chain id ${body.chainId} · local/test by default`;
}

applyLanguage();
conformance();
showNetwork();
run("nft");
