import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startVcApi } from "./http.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const work = process.env.VC_SUITE_DIR ?? "/tmp/rwaix-vc-suites";
const reportRoot = join(root, "reports/vc-interop");

const suites = [
  {
    id: "vc-data-model-2.0",
    repo: "https://github.com/w3c/vc-data-model-2.0-test-suite.git",
    commit: "62836458636bd1b8309214626ec8fc85de43f8bd",
  },
  {
    id: "vc-di-eddsa",
    repo: "https://github.com/w3c/vc-di-eddsa-test-suite.git",
    commit: "1e86cc4ca16d77eb76cd15e3905a624bc16c0879",
  },
  {
    id: "vc-di-ecdsa",
    repo: "https://github.com/w3c/vc-di-ecdsa-test-suite.git",
    commit: "94dca21d8c1c7ad3dc31f21144d4d957567726b5",
  },
] as const;

function localConfig(base: string, eddsaDid: string, ecdsaDid: string): string {
  return `module.exports = {
  settings: { enableInteropTests: false, testAllImplementations: false },
  implementations: [{
    name: "RWAIX",
    implementation: "rwaix-reference",
    issuers: [{
      id: ${JSON.stringify(eddsaDid)},
      endpoint: ${JSON.stringify(`${base}/credentials/issue`)},
      method: "POST",
      supports: { vc: ["1.1", "2.0"] },
      tags: ["eddsa-rdfc-2022", "vc2.0"]
    }, {
      id: ${JSON.stringify(ecdsaDid)},
      endpoint: ${JSON.stringify(`${base}/ecdsa/credentials/issue`)},
      method: "POST",
      supportedEcdsaKeyTypes: ["P-256"],
      supports: { vc: ["1.1", "2.0"] },
      tags: ["ecdsa-rdfc-2019"]
    }],
    verifiers: [{
      id: ${JSON.stringify(eddsaDid)},
      endpoint: ${JSON.stringify(`${base}/credentials/verify`)},
      method: "POST",
      supportedEcdsaKeyTypes: ["P-256"],
      supports: { vc: ["1.1", "2.0"] },
      tags: ["eddsa-rdfc-2022", "ecdsa-rdfc-2019", "vc2.0"]
    }],
    vpVerifiers: [{
      id: ${JSON.stringify(eddsaDid)},
      endpoint: ${JSON.stringify(`${base}/presentations/verify`)},
      method: "POST",
      tags: ["vc2.0"]
    }]
  }]
};
`;
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function ensureSuite(suite: (typeof suites)[number]): Promise<string> {
  const dir = join(work, suite.id);
  await mkdir(work, { recursive: true });
  const head = await run("git", ["-C", dir, "rev-parse", "HEAD"], work).catch(() => ({ code: 1, output: "" }));
  if (head.code !== 0 || !head.output.includes(suite.commit)) {
    await rm(dir, { recursive: true, force: true });
    await run("git", ["init", dir], work);
    await run("git", ["-C", dir, "remote", "add", "origin", suite.repo], work);
    const fetched = await run("git", ["-C", dir, "fetch", "--depth", "1", "origin", suite.commit], work);
    if (fetched.code !== 0) throw new Error(`failed to fetch ${suite.repo}`);
    const checked = await run("git", ["-C", dir, "checkout", "--detach", "FETCH_HEAD"], work);
    if (checked.code !== 0) throw new Error(`failed to checkout ${suite.id}`);
  }
  if (process.env.VC_SUITE_SKIP_INSTALL !== "1") {
    const installed = await run("npm", ["install", "--no-audit", "--no-fund"], dir);
    if (installed.code !== 0) throw new Error(`npm install failed for ${suite.id}`);
  }
  return dir;
}

function tallyTests(node: unknown, tally = { passing: 0, failing: 0, pending: 0 }): { passing: number; failing: number; pending: number } {
  if (Array.isArray(node)) {
    for (const item of node) tallyTests(item, tally);
    return tally;
  }
  if (typeof node !== "object" || node === null) return tally;
  const record = node as { type?: unknown; state?: unknown };
  if (record.type === "test" && typeof record.state === "string") {
    if (record.state === "passed") tally.passing += 1;
    else if (record.state === "failed") tally.failing += 1;
    else if (record.state === "pending") tally.pending += 1;
  }
  for (const value of Object.values(record)) tallyTests(value, tally);
  return tally;
}

async function counts(dir: string, output: string): Promise<{ passing: number; failing: number; pending: number }> {
  try {
    const report = JSON.parse(await readFile(join(dir, "reports/index.json"), "utf8")) as unknown;
    return tallyTests(report);
  } catch {
    return {
      passing: Number(output.match(/(\d+)\s+passing/)?.[1] ?? (output.match(/✓/g) ?? []).length),
      failing: Number(output.match(/(\d+)\s+failing/)?.[1] ?? (output.match(/❌/g) ?? []).length),
      pending: Number(output.match(/(\d+)\s+pending/)?.[1] ?? 0),
    };
  }
}

async function copyReport(dir: string, id: string): Promise<void> {
  const source = join(dir, "reports");
  const target = join(reportRoot, id);
  await rm(target, { recursive: true, force: true });
  try {
    await cp(source, target, { recursive: true });
  } catch {
    await mkdir(target, { recursive: true });
  }
}

const started = await startVcApi({ host: "127.0.0.1", port: 0 });
const base = `http://${started.host}:${started.port}`;
console.log(`VC-API ${base}`);
console.log(`eddsa ${started.eddsaDid}`);
console.log(`ecdsa ${started.ecdsaDid}`);
const summary: Array<Record<string, unknown>> = [];
let failed = false;
try {
  await mkdir(reportRoot, { recursive: true });
  for (const suite of suites) {
    const dir = await ensureSuite(suite);
    await writeFile(join(dir, "localConfig.cjs"), localConfig(base, started.eddsaDid, started.ecdsaDid));
    const result = await run("npm", ["test"], dir);
    await copyReport(dir, suite.id);
    await writeFile(join(reportRoot, suite.id, "mocha.log"), result.output);
    const tally = await counts(dir, result.output);
    summary.push({ suite: suite.id, commit: suite.commit, exitCode: result.code, ...tally });
    if (result.code !== 0) failed = true;
  }
  await writeFile(join(reportRoot, "summary.json"), `${JSON.stringify({ base, eddsaDid: started.eddsaDid, ecdsaDid: started.ecdsaDid, suites: summary }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  started.server.close();
}
if (failed) process.exit(1);
