const state = { lang: "zh", network: "local", account: "", init: null, gas: null, confirmed: false };

const NETWORKS = {
  local: { chainId: 31337, hex: "0x7a69" },
  sepolia: { chainId: 11155111, hex: "0xaa36a7" },
  mainnet: { chainId: 1, hex: "0x1" },
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

function paintFlow() {
  const wallet = document.querySelector('#flow [data-step="wallet"]');
  const gas = document.querySelector('#flow [data-step="gas"]');
  wallet?.classList.toggle("is-ok", Boolean(state.account));
  gas?.classList.toggle("is-ok", Boolean(state.gas));
}

function applyLanguage() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-zh]").forEach(text);
  document.querySelector("#lang").textContent = state.lang === "zh" ? "English" : "中文";
  paintThemeButton();
  paintBanner();
  paintFlow();
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

function paintBanner() {
  const banner = document.querySelector("#network-banner");
  if (state.network === "mainnet") {
    banner.className = "banner-mainnet";
    banner.textContent = "MAINNET";
    return;
  }
  banner.className = "banner-test";
  banner.textContent = state.lang === "zh"
    ? `当前选择 ${state.network}。默认是本地测试。`
    : `Selected ${state.network}. The default is local/test.`;
}

function provider() {
  const injected = window.ethereum;
  if (!injected || typeof injected.request !== "function") return null;
  return injected;
}

function setResult(message) {
  document.querySelector("#result").textContent = message;
}

async function initCode(name) {
  const response = await fetch(`/api/deploy/initcode?contract=${name}&admin=${state.account}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error || "bytecode");
  return body.initCode;
}

function wei(gas, price) {
  return BigInt(gas) * BigInt(price);
}

document.querySelectorAll("#switch button").forEach((button) => {
  button.addEventListener("click", () => {
    state.network = button.dataset.net;
    state.gas = null;
    state.confirmed = false;
    document.querySelector("#send").disabled = true;
    document.querySelectorAll("#switch button").forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
    paintBanner();
    paintFlow();
    setResult("");
  });
});

document.querySelector("#connect").addEventListener("click", async () => {
  const wallet = provider();
  if (!wallet) {
    setResult(state.lang === "zh"
      ? "没有注入钱包。请使用 MetaMask、Rabby，或先用 WalletConnect 连到一个会注入 window.ethereum 的浏览器钱包。本页不接收私钥。"
      : "No injected wallet. Use MetaMask, Rabby, or a WalletConnect session that injects window.ethereum. This page does not accept a private key.");
    return;
  }
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  state.account = accounts[0];
  const chainId = Number(await wallet.request({ method: "eth_chainId" }));
  document.querySelector("#account").textContent = `${state.account} · wallet chain ${chainId}`;
  paintFlow();
  if (chainId !== NETWORKS[state.network].chainId) {
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NETWORKS[state.network].hex }] });
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }
});

document.querySelector("#estimate").addEventListener("click", async () => {
  const wallet = provider();
  if (state.network === "mainnet") {
    const phrase = document.querySelector("#phrase").value.trim();
    const response = await fetch("/api/network/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: phrase }),
    });
    const body = await response.json();
    state.confirmed = response.ok && body.ok === true && body.signsOnBehalf === false;
    if (!state.confirmed) {
      setResult(body.message || "MAINNET confirmation refused");
      return;
    }
  } else {
    state.confirmed = true;
  }
  if (!wallet || !state.account) {
    setResult(state.lang === "zh" ? "先连接钱包。未连接时不会签名。" : "Connect a wallet first. Nothing is signed before that.");
    return;
  }
  try {
    const token = await initCode("RwaixToken");
    const dcnft = await initCode("RwaixDcnft");
    const price = await wallet.request({ method: "eth_gasPrice" });
    const tokenGas = await wallet.request({ method: "eth_estimateGas", params: [{ from: state.account, data: token }] });
    const dcnftGas = await wallet.request({ method: "eth_estimateGas", params: [{ from: state.account, data: dcnft }] });
    const cost = wei(tokenGas, price) + wei(dcnftGas, price);
    state.init = { token, dcnft };
    state.gas = { tokenGas, dcnftGas, price, cost };
    document.querySelector("#gas").textContent = [
      `RwaixToken gas ${BigInt(tokenGas)}`,
      `RwaixDcnft gas ${BigInt(dcnftGas)}`,
      `gas price wei ${BigInt(price)}`,
      `estimated cost wei ${cost}`,
      "no mint, no premine, no sale",
    ].join("\n");
    document.querySelector("#send").disabled = false;
    paintFlow();
  } catch (error) {
    setResult(error instanceof Error ? error.message : String(error));
  }
});

document.querySelector("#send").addEventListener("click", async () => {
  const wallet = provider();
  if (!wallet || !state.init || !state.gas || !state.confirmed || !document.querySelector("#ack").checked) {
    setResult(state.lang === "zh" ? "需要 gas 估算、确认框，以及主网上的 MAINNET。" : "Gas estimate, the acknowledgement, and MAINNET on mainnet are required.");
    return;
  }
  if (state.network === "mainnet" && document.querySelector("#phrase").value.trim() !== "MAINNET") {
    setResult("MAINNET");
    return;
  }
  const hashes = [];
  for (const data of [state.init.token, state.init.dcnft]) {
    const hash = await wallet.request({ method: "eth_sendTransaction", params: [{ from: state.account, data }] });
    hashes.push(hash);
  }
  setResult(hashes.join("\n"));
});

const server = await fetch("/api/network").then((response) => response.json());
document.querySelector("#server-network").textContent = `server ${server.name} chain ${server.chainId} optIn ${server.optIn} signsOnBehalf ${server.signsOnBehalf}`;
applyLanguage();
