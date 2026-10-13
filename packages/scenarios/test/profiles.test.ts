import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILE_IDS, runProfile } from "../src/index.js";

test("eight application demos allow in-scope evidence and keep the fee split", () => {
  assert.deepEqual([...PROFILE_IDS], ["nft", "identity", "content", "data", "supply", "agent", "compute", "device"]);
  for (const id of PROFILE_IDS) {
    const report = runProfile(id);
    assert.equal(report.decision, "ALLOW", `${id} ${report.steps.map((step) => step.detail).join(";")}`);
    assert.equal(report.outOfScope.decision, "DENY", id);
    assert.ok(report.outOfScope.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH"), id);
    assert.equal(report.feeSplit[0]?.assetId, "USD_TEST");
    assert.equal(report.feeSplit[1]?.assetId, "RWAIX_TEST");
    assert.equal(report.reconciliation.disputesResolvedBySilence, 0, id);
    assert.ok(report.steps.every((step) => step.ok), `${id} ${report.steps.filter((step) => !step.ok).map((step) => `${step.zh}:${step.detail ?? ""}`).join(";")}`);
    assert.ok(report.steps.some((step) => step.zh.startsWith("commit ") && step.ok), id);
    assert.ok(report.steps.some((step) => step.zh.startsWith("verify ") && step.ok), id);
    assert.ok(report.steps.some((step) => step.zh.startsWith("accept ") && step.ok), id);
    assert.ok(report.steps.some((step) => step.zh.startsWith("apply ") && step.ok), id);
    assert.ok(report.disclosure.scopeZh.length > 20, id);
    assert.match(report.disclosure.testsZh, /本进程/);
    assert.match(report.disclosure.unfinishedZh, /未完成的生产条件/);
    if (id === "nft") {
      assert.equal(report.feeSplit[0]?.amount, "12000");
      assert.equal(report.feeSplit[1]?.amount, "0");
      assert.equal(report.feeSplit[1]?.state, "OPEN");
      assert.equal(report.reconciliation.dischargeState, "DISCHARGED");
      assert.equal(report.copyrightDecision, "DENY");
      assert.equal(report.dispute, "OPEN");
      assert.equal(report.ledgers.rights.length, 0);
    } else if (id === "identity") {
      assert.equal(report.feeSplit[0]?.amount, "0");
      assert.equal(report.feeSplit[1]?.amount, "0");
      assert.equal(report.dispute, "NONE");
      assert.notEqual(report.reconciliation.dischargeState, "DISCHARGED");
    } else {
      assert.equal(report.feeSplit[0]?.amount, "100");
      assert.equal(report.feeSplit[1]?.amount, "10");
      assert.equal(report.reconciliation.dischargeState, "DISCHARGED", id);
      assert.equal(report.dispute, "NONE");
    }
  }
});
