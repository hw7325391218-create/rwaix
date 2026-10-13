import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS, NotEvaluated } from "./checks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(dirname(fileURLToPath(import.meta.url)), "../out");

interface ItemReport {
  id: string;
  name: string;
  clause: string;
  status: "PASS" | "FAIL" | "NOT_EVALUATED";
  detail: string;
  durationMs: number;
}

function git(command: string): string {
  try {
    return execSync(command, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function toolVersion(command: string): string {
  try {
    const home = process.env.HOME ?? "";
    return execSync(command, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${home}/.foundry/bin:${process.env.PATH ?? ""}` },
    }).trim().split("\n")[0] ?? "";
  } catch {
    return "absent";
  }
}

const commit = git("git rev-parse HEAD");
const dirty = git("git status --porcelain").length > 0;
const timestamp = new Date().toISOString();
const environment = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  pnpm: toolVersion("pnpm --version"),
  forge: toolVersion("forge --version"),
  python: toolVersion("python3 --version"),
  dirty,
};

const items: ItemReport[] = [];
for (const check of CHECKS) {
  const started = Date.now();
  let status: ItemReport["status"] = "PASS";
  let detail = "";
  try {
    detail = await check.run();
  } catch (error) {
    if (error instanceof NotEvaluated) {
      status = "NOT_EVALUATED";
      detail = error.message;
    } else {
      status = "FAIL";
      detail = error instanceof Error ? error.message : String(error);
    }
  }
  items.push({
    id: check.id,
    name: check.name,
    clause: check.clause,
    status,
    detail,
    durationMs: Date.now() - started,
  });
  console.log(`${check.id} ${status}`);
}

const passed = items.filter((item) => item.status === "PASS").length;
const failed = items.filter((item) => item.status === "FAIL").length;
const notEvaluated = items.filter((item) => item.status === "NOT_EVALUATED").length;
const total = items.length;
if (total !== 50) {
  console.error(`suite defined ${total} items, expected 50`);
  process.exit(1);
}
const headline = `${passed}/${total} passed (${failed} failed, ${notEvaluated} not evaluated)`;
const report = {
  suite: "acceptance-50",
  spec: "whitepaper-2026-10-12",
  headline,
  passed,
  failed,
  notEvaluated,
  total,
  commit,
  timestamp,
  environment,
  archivedRecord: "not reused",
  items,
};

mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, "acceptance-report.json");
const mdPath = join(outDir, "acceptance-report.md");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  `# Acceptance ${headline}`,
  "",
  "This run executes `docs/acceptance/ACCEPTANCE-50.md`. It does not reuse or claim the archived 2026-10-12 50/50 record.",
  "",
  `- Spec: whitepaper-2026-10-12`,
  `- Commit: \`${commit || "unknown"}\`${dirty ? " (working tree dirty)" : ""}`,
  `- Timestamp: ${timestamp}`,
  `- Node: ${environment.node}`,
  `- Platform: ${environment.platform}`,
  `- pnpm: ${environment.pnpm}`,
  `- forge: ${environment.forge}`,
  `- Python: ${environment.python}`,
  "",
  "| Id | Result | Name | Detail |",
  "| --- | --- | --- | --- |",
  ...items.map((item) => `| ${item.id} | ${item.status} | ${item.name} | ${item.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
  "",
];
writeFileSync(mdPath, `${lines.join("\n")}\n`);
console.log(headline);
console.log(`wrote ${jsonPath}`);
console.log(`wrote ${mdPath}`);
if (failed > 0) process.exit(1);
