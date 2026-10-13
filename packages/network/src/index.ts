export type NetworkName = "local" | "sepolia" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  chainId: number;
  rpcUrl?: string;
  rwaixAddress?: string;
  dcnftAddress?: string;
  mainnet: boolean;
  finalityDepth: number;
}

export const NETWORK_CHAIN_IDS: Record<NetworkName, number> = {
  local: 31337,
  sepolia: 11155111,
  mainnet: 1,
};

export const ISSUANCE_ENABLED_SELECTOR = "0xa8590135";
export const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export class NetworkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkConfigError";
  }
}

function optionalAddress(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  if (!ADDRESS.test(value)) throw new NetworkConfigError(`${label} is not a 20-byte hex address`);
  return value;
}

export function finalityDepthFor(name: NetworkName, raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    if (name === "mainnet") return 64;
    if (name === "sepolia") return 12;
    return 2;
  }
  if (!/^[0-9]+$/.test(raw)) throw new NetworkConfigError("RWAIX_FINALITY_DEPTH must be a positive integer");
  const depth = Number(raw);
  if (depth < 1) throw new NetworkConfigError("RWAIX_FINALITY_DEPTH must be a positive integer");
  return depth;
}

/**
 * Resolves the process network. The default is local chain id 31337.
 * Mainnet requires RWAIX_MAINNET_OPT_IN=1 and the typed confirmation MAINNET.
 */
export function resolveNetwork(env: NodeJS.ProcessEnv, typedConfirmation?: string): NetworkConfig {
  const name = (env.RWAIX_NETWORK ?? "local") as NetworkName;
  if (!(name in NETWORK_CHAIN_IDS)) throw new NetworkConfigError(`unknown RWAIX_NETWORK ${name}`);
  const expected = NETWORK_CHAIN_IDS[name];
  const rawChain = env.RWAIX_CHAIN_ID ?? env.CHAIN_A_ID;
  const chainId = rawChain === undefined || rawChain === "" ? expected : Number(rawChain);
  if (!Number.isInteger(chainId) || chainId !== expected) {
    throw new NetworkConfigError(`chain id ${rawChain} does not match ${name} (${expected})`);
  }
  if (name === "mainnet") {
    if (env.RWAIX_MAINNET_OPT_IN !== "1") {
      throw new NetworkConfigError("mainnet requires RWAIX_MAINNET_OPT_IN=1");
    }
    const typed = typedConfirmation ?? env.RWAIX_MAINNET_CONFIRMATION;
    if (typed !== "MAINNET") {
      throw new NetworkConfigError("mainnet requires the typed confirmation MAINNET");
    }
  }
  return {
    name,
    chainId,
    rpcUrl: env.RWAIX_RPC_URL || env.CHAIN_A_RPC || undefined,
    rwaixAddress: optionalAddress(env.RWAIX_TOKEN_ADDRESS, "RWAIX_TOKEN_ADDRESS"),
    dcnftAddress: optionalAddress(env.RWAIX_DCNFT_ADDRESS, "RWAIX_DCNFT_ADDRESS"),
    mainnet: name === "mainnet",
    finalityDepth: finalityDepthFor(name, env.RWAIX_FINALITY_DEPTH),
  };
}

/** Host only. Query strings and userinfo can carry API keys and are dropped. */
export function redactRpc(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "configured";
  }
}

export function creationCode(bytecode: string, admin: string): string {
  const code = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const address = admin.toLowerCase().replace(/^0x/, "");
  if (!/^[\da-fA-F]+$/.test(code) || code.length < 2 || code.length % 2 !== 0) {
    throw new NetworkConfigError("bytecode is not hex");
  }
  if (!/^[\da-fA-F]{40}$/.test(address)) throw new NetworkConfigError("admin is not an address");
  return `0x${code}${address.padStart(64, "0")}`;
}

export interface ChainProbe {
  chainId(): Promise<number>;
  getCode(address: string): Promise<string>;
  call(to: string, data: string): Promise<string>;
}

export interface DeploymentCheck {
  label: string;
  address?: string;
  status: "not-configured" | "no-code" | "issuance-disabled" | "issuance-enabled" | "call-failed";
  totalSupply?: string;
}

export async function verifyDeployment(chain: ChainProbe, config: NetworkConfig): Promise<{
  ok: boolean;
  reason?: string;
  remoteChainId?: number;
  checks: DeploymentCheck[];
}> {
  let remoteChainId: number;
  try {
    remoteChainId = await chain.chainId();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "rpc-failed", checks: [] };
  }
  if (remoteChainId !== config.chainId) {
    return { ok: false, reason: "chain-id-mismatch", remoteChainId, checks: [] };
  }
  const checks: DeploymentCheck[] = [];
  for (const [label, address] of [
    ["rwaix", config.rwaixAddress],
    ["dcnft", config.dcnftAddress],
  ] as const) {
    if (!address) {
      checks.push({ label, status: "not-configured" });
      continue;
    }
    const code = await chain.getCode(address);
    if (!code || code === "0x" || code === "0x0") {
      checks.push({ label, address, status: "no-code" });
      continue;
    }
    try {
      const enabled = await chain.call(address, ISSUANCE_ENABLED_SELECTOR);
      const supply = await chain.call(address, TOTAL_SUPPLY_SELECTOR);
      const issuanceOn = BigInt(enabled) !== 0n;
      checks.push({
        label,
        address,
        status: issuanceOn ? "issuance-enabled" : "issuance-disabled",
        totalSupply: BigInt(supply).toString(),
      });
    } catch {
      checks.push({ label, address, status: "call-failed" });
    }
  }
  const bad = checks.some((item) => item.status === "no-code" || item.status === "issuance-enabled" || item.status === "call-failed");
  return { ok: !bad, remoteChainId, checks };
}
