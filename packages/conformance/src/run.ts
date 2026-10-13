import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBySchemaId } from "@rwaix/protocol";
import { buildManifest } from "./execute.js";

const manifest = await buildManifest();
validateBySchemaId("rwaix.conformance.v1", manifest);
const outDir = join(dirname(fileURLToPath(import.meta.url)), "../out");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "ConformanceManifest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
const failed = manifest.results.filter((item) => item.result === "fail");
console.log(`conformance claim passed=${manifest.conformanceClaim.passed}`);
console.log(`vectors ${manifest.results.length}, failed ${failed.length}`);
for (const item of manifest.modules) console.log(`module ${item.moduleId}: ${item.status}`);
console.log(`wrote ${out}`);
if (!manifest.conformanceClaim.passed || failed.length > 0) process.exit(1);
