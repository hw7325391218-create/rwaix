import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "@rwaix/conformance";
import { didDocument, didKeyFromSigner, didWeb } from "@rwaix/identity";
import { ChainIndexer, JsonRpcChain } from "@rwaix/indexer";
import { creationCode, redactRpc, resolveNetwork, verifyDeployment, type NetworkConfig } from "@rwaix/network";
import { openDatabase, saveDocument, type Sql } from "@rwaix/persistence";
import { keyFromSeed } from "@rwaix/protocol";
import { PROFILE_IDS, runCrossScenario, runProfile } from "@rwaix/scenarios";
import { handleVcApi } from "@rwaix/vc-api";

const root = join(dirname(fileURLToPath(import.meta.url)), "../web");
const issuer = keyFromSeed("server-issuer");
const issuerDid = didWeb(process.env.DID_AUTHORITY ?? "127.0.0.1:8787");
const document = didDocument(issuerDid, issuer.publicKey);
let sql: Sql | undefined;
let conformance: unknown;
let journal = 0;
let chainHead = "not-configured";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8", mode = "paper-test-only"): void {
  const payload =
    typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array
      ? body
      : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-rwaix-mode": mode,
  });
  response.end(payload);
}

function networkView(network: NetworkConfig) {
  return {
    name: network.name,
    chainId: network.chainId,
    mainnet: network.mainnet,
    finalityDepth: network.finalityDepth,
    rpcConfigured: Boolean(network.rpcUrl),
    rpcHost: redactRpc(network.rpcUrl),
    rwaixAddress: network.rwaixAddress ?? null,
    dcnftAddress: network.dcnftAddress ?? null,
    issuance: "disabled-until-legal-and-compliance-sign-off",
    signsOnBehalf: false,
    optIn: process.env.RWAIX_MAINNET_OPT_IN === "1",
  };
}

function initCode(contractName: string, admin: string): string {
  const files: Record<string, string> = {
    RwaixToken: "RwaixToken.sol/RwaixToken.json",
    RwaixDcnft: "RwaixDcnft.sol/RwaixDcnft.json",
  };
  const relative = files[contractName];
  if (!relative) throw new Error("unknown contract");
  const file = join(root, "../../../contracts/out", relative);
  const artifact = JSON.parse(readFileSync(file, "utf8")) as { bytecode?: { object?: string } };
  const bytecode = artifact.bytecode?.object;
  if (!bytecode) throw new Error("missing bytecode");
  return creationCode(bytecode, admin);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function start(options?: { host?: string; port?: number; databaseUrl?: string; dataDir?: string }) {
  const host = options?.host ?? process.env.BIND_HOST ?? "127.0.0.1";
  const port = options?.port ?? Number(process.env.PORT ?? 8787);
  const network = resolveNetwork(process.env);
  const mode = network.mainnet ? "mainnet-opt-in" : "paper-test-only";
  sql = await openDatabase({ databaseUrl: options?.databaseUrl ?? process.env.DATABASE_URL, dataDir: options?.dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), "data/pglite") });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/health") {
        send(response, 200, {
          ok: true,
          paperTestOnly: !network.mainnet,
          issuerDid,
          network: network.name,
          chainId: network.chainId,
          storage: process.env.DATABASE_URL ? "postgres" : "pglite",
          journal,
          chainHead,
        }, "application/json; charset=utf-8", mode);
        return;
      }
      if (url.pathname === "/api/network" && request.method === "GET") {
        send(response, 200, networkView(network), "application/json; charset=utf-8", mode);
        return;
      }
      if (url.pathname === "/api/network/confirm" && request.method === "POST") {
        const raw = await readBody(request);
        let confirmation = "";
        try {
          confirmation = String((JSON.parse(raw) as { confirmation?: unknown }).confirmation ?? "");
        } catch {
          confirmation = "";
        }
        if (process.env.RWAIX_MAINNET_OPT_IN !== "1" || confirmation !== "MAINNET") {
          send(response, 403, {
            ok: false,
            error: "MAINNET_CONFIRMATION_REQUIRED",
            message: "Mainnet requires RWAIX_MAINNET_OPT_IN=1 on the server and the typed confirmation MAINNET. This server does not sign.",
          }, "application/json; charset=utf-8", mode);
          return;
        }
        send(response, 200, { ok: true, signsOnBehalf: false }, "application/json; charset=utf-8", mode);
        return;
      }
      if (url.pathname === "/api/network/verify" && request.method === "GET") {
        if (!network.rpcUrl) {
          send(response, 200, { ok: false, reason: "rpc-not-configured", checks: [] }, "application/json; charset=utf-8", mode);
          return;
        }
        const report = await verifyDeployment(new JsonRpcChain(network.rpcUrl), network);
        send(response, 200, report, "application/json; charset=utf-8", mode);
        return;
      }
      if (url.pathname === "/api/deploy/initcode" && request.method === "GET") {
        const contractName = url.searchParams.get("contract") ?? "";
        const admin = url.searchParams.get("admin") ?? "";
        try {
          send(response, 200, { contract: contractName, initCode: initCode(contractName, admin), signsOnBehalf: false }, "application/json; charset=utf-8", mode);
        } catch (error) {
          send(response, 503, { error: "BYTECODE_UNAVAILABLE", message: error instanceof Error ? error.message : "bytecode unavailable" }, "application/json; charset=utf-8", mode);
        }
        return;
      }
      if (url.pathname === "/metrics") {
        send(response, 200, `rwaix_up 1\nrwaix_journal_entries ${journal}\nrwaix_paper_test_only ${network.mainnet ? 0 : 1}\nrwaix_chain_id ${network.chainId}\n`, "text/plain; charset=utf-8", mode);
        return;
      }
      if (url.pathname === "/vc-api" || url.pathname.startsWith("/vc-api/")) {
        await handleVcApi(request, response);
        return;
      }
      if (url.pathname === "/.well-known/did.json" || url.pathname === "/identity/did.json" || url.pathname === "/did.json") {
        send(response, 200, document, "application/json; charset=utf-8", mode);
        return;
      }
      if (url.pathname === "/api/scenarios" && request.method === "GET") {
        send(response, 200, { scenarios: PROFILE_IDS, cross: "section-19", issuerDid, issuerKey: didKeyFromSigner(issuer) }, "application/json; charset=utf-8", mode);
        return;
      }
      if (url.pathname === "/api/conformance" && request.method === "GET") {
        conformance ??= await buildManifest({ includeForge: false });
        send(response, 200, conformance, "application/json; charset=utf-8", mode);
        return;
      }
      const run = url.pathname.match(/^\/api\/scenarios\/([a-z0-9-]+)\/run$/);
      if (run && request.method === "POST") {
        await readBody(request);
        const id = run[1];
        if (id === "cross") {
          const result = runCrossScenario();
          if (sql) {
            journal += 1;
            await saveDocument(sql, "scenario", "cross", result, new Date().toISOString().slice(0, 19) + "Z", "scenario");
          }
          send(response, result.ok ? 200 : 422, result, "application/json; charset=utf-8", mode);
          return;
        }
        if (!PROFILE_IDS.includes(id as (typeof PROFILE_IDS)[number])) {
          send(response, 404, { error: "NOT_FOUND" }, "application/json; charset=utf-8", mode);
          return;
        }
        const report = runProfile(id as (typeof PROFILE_IDS)[number]);
        if (sql) {
          journal += 1;
          await saveDocument(sql, "scenario", id, report, new Date().toISOString().slice(0, 19) + "Z", "scenario");
        }
        send(response, 200, report, "application/json; charset=utf-8", mode);
        return;
      }
      const relative = (url.pathname === "/" ? "index.html" : url.pathname).replace(/^\/+/, "");
      const file = resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${sep}`)) {
        send(response, 404, { error: "NOT_FOUND" }, "application/json; charset=utf-8", mode);
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        send(response, 404, { error: "NOT_FOUND" }, "application/json; charset=utf-8", mode);
        return;
      }
      const ext = file.slice(file.lastIndexOf("."));
      send(response, 200, body, types[ext] ?? "application/octet-stream", mode);
    } catch (error) {
      send(response, 500, { error: "SERVER", message: error instanceof Error ? error.message : String(error) }, "application/json; charset=utf-8", mode);
    }
  });
  const chainRpc = network.rpcUrl;
  if (sql && chainRpc) {
    const chain = new JsonRpcChain(chainRpc);
    const indexer = new ChainIndexer(sql, chain, String(network.chainId), network.finalityDepth);
    const follow = async () => {
      try {
        const remoteId = await chain.chainId();
        if (remoteId !== network.chainId) {
          chainHead = `chain-id-mismatch:${remoteId}`;
          return;
        }
        await indexer.poll();
        const latest = await chain.latest();
        chainHead = latest ? `${latest.number}:${latest.hash}` : "empty";
      } catch (error) {
        chainHead = error instanceof Error ? error.message : "chain-error";
      }
    };
    void follow();
    setInterval(() => void follow(), 4000).unref();
  }
  await new Promise<void>((resolveListen) => server.listen(port, host, () => resolveListen()));
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return { server, host, port: bound, issuerDid };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = await start();
  console.log(`RWAIX paper/test UI http://${started.host}:${started.port} (${started.issuerDid})`);
}
