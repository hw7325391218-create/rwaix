import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalStringify, sha256Hex } from "@rwaix/protocol";

const dir = join(process.cwd(), "packages/schemas/v1");
const files: Record<string, string> = {};
for (const name of readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "freeze.json").sort()) {
  const body = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
  files[name] = `sha256:${sha256Hex(canonicalStringify(body))}`;
}
writeFileSync(join(dir, "freeze.json"), `${JSON.stringify({ schemaRelease: "1.0.0", frozen: true, files }, null, 2)}\n`);
console.log(`froze ${Object.keys(files).length} schema files`);
