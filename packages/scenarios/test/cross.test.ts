import assert from "node:assert/strict";
import { test } from "node:test";
import { runCrossScenario } from "../src/cross.js";

test("section 19 chain keeps separate trades, a parent budget, and an open dispute", () => {
  const result = runCrossScenario();
  assert.equal(result.ok, true, result.ok ? "" : result.detail);
});
