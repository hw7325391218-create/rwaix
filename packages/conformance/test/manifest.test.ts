import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBySchemaId } from "@rwaix/protocol";
import { buildManifest, refuseMustWaiver } from "../src/execute.js";

test("conformance manifest marks unfinished modules 未评测 and validates", async () => {
  const manifest = await buildManifest({ includeForge: false });
  validateBySchemaId("rwaix.conformance.v1", manifest);
  assert.equal(manifest.results.every((item) => item.strength !== "MUST" || item.result === "pass"), true);
  const unfinished = manifest.modules.filter((item) => item.status === "未评测").map((item) => item.moduleId);
  for (const id of ["production-bridge", "mainnet-deployment", "standards-certification", "solidity-dual-token", "zk-soundness"]) {
    assert.ok(unfinished.includes(id), id);
  }
  assert.equal(unfinished.includes("w3c-bitstring-status-list"), false);
  assert.equal(manifest.conformanceClaim.passed, true);
  assert.match(manifest.conformanceClaim.statement, /not certification/);
  assert.throws(() => refuseMustWaiver(), /cannot be waived/);
});
