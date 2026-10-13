import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { creationCode, redactRpc, resolveNetwork, verifyDeployment } from "../src/index.js";

const admin = "0x1111111111111111111111111111111111111111";

test("default network is local and mainnet needs an opt-in plus typed MAINNET", () => {
  const local = resolveNetwork({});
  assert.equal(local.name, "local");
  assert.equal(local.chainId, 31337);
  assert.equal(local.mainnet, false);
  assert.equal(local.finalityDepth, 2);
  assert.throws(() => resolveNetwork({ RWAIX_NETWORK: "mainnet" }), /RWAIX_MAINNET_OPT_IN/);
  assert.throws(() => resolveNetwork({ RWAIX_NETWORK: "mainnet", RWAIX_MAINNET_OPT_IN: "1" }), /MAINNET/);
  const mainnet = resolveNetwork({
    RWAIX_NETWORK: "mainnet",
    RWAIX_MAINNET_OPT_IN: "1",
    RWAIX_MAINNET_CONFIRMATION: "MAINNET",
    RWAIX_RPC_URL: "https://user:secret@example.invalid/v1/KEY",
    RWAIX_TOKEN_ADDRESS: admin,
  });
  assert.equal(mainnet.chainId, 1);
  assert.equal(mainnet.finalityDepth, 64);
  assert.equal(redactRpc(mainnet.rpcUrl), "https://example.invalid");
  const sepolia = resolveNetwork({ RWAIX_NETWORK: "sepolia", RWAIX_CHAIN_ID: "11155111" });
  assert.equal(sepolia.chainId, 11155111);
  assert.equal(sepolia.finalityDepth, 12);
  assert.throws(() => resolveNetwork({ RWAIX_NETWORK: "sepolia", RWAIX_CHAIN_ID: "1" }), /does not match/);
});

test("creation code appends the admin argument and does not contain a key", () => {
  const code = creationCode("0x6001", admin);
  assert.equal(code, `0x6001${admin.slice(2).padStart(64, "0")}`);
  assert.throws(() => creationCode("0x6001", "0x1234"), /admin/);
});

test("deployment verifier accepts a matching chain with issuance disabled", async () => {
  const config = resolveNetwork({ RWAIX_NETWORK: "sepolia", RWAIX_TOKEN_ADDRESS: admin, RWAIX_DCNFT_ADDRESS: admin });
  const report = await verifyDeployment({
    async chainId() {
      return 11155111;
    },
    async getCode() {
      return "0x6001";
    },
    async call(_to, data) {
      if (data === "0xa8590135") return `0x${"0".repeat(64)}`;
      return `0x${"0".repeat(64)}`;
    },
  }, config);
  assert.equal(report.ok, true);
  assert.equal(report.checks.every((item) => item.status === "issuance-disabled"), true);
  const mismatch = await verifyDeployment({
    async chainId() {
      return 1;
    },
    async getCode() {
      return "0x6001";
    },
    async call() {
      return "0x";
    },
  }, config);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "chain-id-mismatch");
});

test("issuance deploy script refuses private keys and forge's interactive key prompt", () => {
  const script = "contracts/script/deploy-issuance.sh";
  const source = readFileSync("contracts/script/DeployIssuance.s.sol", "utf8");
  assert.doesNotMatch(source, /enableIssuance\(/);
  assert.doesNotMatch(source, /PRIVATE_KEY/);
  assert.match(source, /totalSupply\(\) == 0/);
  const env: NodeJS.ProcessEnv = { ...process.env, PRIVATE_KEY: "not-a-key" };
  const refused = spawnSync("bash", [script, "--ledger"], { encoding: "utf8", env });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stderr}`, /private key/);
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["PRIVATE_KEY", "FOUNDRY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "MNEMONIC", "FOUNDRY_MNEMONIC"]) {
    delete clean[key];
  }
  const interactive = spawnSync("bash", [script, "--interactive"], { encoding: "utf8", env: clean });
  assert.notEqual(interactive.status, 0);
  assert.match(`${interactive.stderr}`, /private-key prompt/);
});
