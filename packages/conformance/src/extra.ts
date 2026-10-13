import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger } from "@rwaix/agent";
import { issueSelectiveDisclosure, presentSelectiveDisclosure, verifySelectiveDisclosure } from "@rwaix/disclosure";
import { AccountRecovery } from "@rwaix/identity";
import { ChainIndexer, FakeChain } from "@rwaix/indexer";
import { journalLength, loadDocument, openPglite, saveDocument } from "@rwaix/persistence";
import { ManualClock, ProtocolError, digestPrefixed, keyFromSeed, signRequest } from "@rwaix/protocol";
import { PROFILE_IDS, runCrossScenario, runProfile } from "@rwaix/scenarios";
import { ReferenceService } from "@rwaix/sdk";
import { decodeBitstring, emptyBitstring, encodeBitstring, getBit, issueStatusList, verifyStatusList, writeStatus } from "@rwaix/status-list";
import { proveRange, shutdownProver, verifyRange } from "@rwaix/zk";
import type { VectorResult } from "./execute.js";

const root = join(import.meta.dirname, "../../..");

async function pass(vectorId: string, rule: string, run: () => Promise<void> | void): Promise<VectorResult> {
  try {
    await run();
    return { vectorId, rule, strength: "MUST", result: "pass" };
  } catch (error) {
    return { vectorId, rule, strength: "MUST", result: "fail", notes: error instanceof Error ? error.message : String(error) };
  }
}

export async function extraVectors(): Promise<VectorResult[]> {
  const results = await Promise.all([
    pass("durable-postgres", "N12", async () => {
      const dir = await mkdtemp(join(tmpdir(), "rwaix-extra-"));
      const clock = new ManualClock("2026-10-11T00:00:00Z");
      const verifier = keyFromSeed("extra-verifier");
      const owner = keyFromSeed("extra-owner");
      const first = new ReferenceService({ clock, verifier });
      const created = first.registerObject(signRequest(owner, "registerObject", {
        schemaId: "rwaix.request.registerObject.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "extra-reg",
        objectId: "extra-obj", objectType: "SUBJECT", controller: owner.publicRef, lifecyclePolicy: "NON_TRANSFERABLE", metadataDigest: digestPrefixed({ extra: true }),
      }, { nonce: "extra-nonce-01", deadline: "2027-01-01T00:00:00Z" }));
      if (!created.ok) throw new Error(created.error);
      const published = first.publishVersion(signRequest(owner, "publishVersion", {
        schemaId: "rwaix.request.publishVersion.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "extra-ver",
        objectId: "extra-obj", bindingVersion: "1", contentDigest: digestPrefixed({ extra: true }), metadataDigest: digestPrefixed({ extra: true }),
      }, { nonce: "extra-nonce-v1", deadline: "2027-01-01T00:00:00Z" }));
      if (!published.ok) throw new Error(published.error);
      const sql = await openPglite(dir);
      await saveDocument(sql, "service", "kernel", first.toJSON(), clock.now(), "snapshot");
      if (await journalLength(sql) < 1) throw new Error("journal was not written");
      await sql.close();
      const again = await openPglite(dir);
      const body = await loadDocument<Parameters<ReferenceService["loadJSON"]>[0]>(again, "service", "kernel");
      if (!body) throw new Error("snapshot missing");
      const second = new ReferenceService({ clock, verifier });
      second.loadJSON(body);
      const resolved = second.resolveBinding(signRequest(owner, "resolveBinding", {
        schemaId: "rwaix.request.resolveBinding.v1", protocolVersion: "rwaix-0.1.0", idempotencyKey: "extra-res", objectId: "extra-obj", bindingVersion: "1",
      }, { nonce: "extra-nonce-02", deadline: "2027-01-01T00:00:00Z" }));
      await again.close();
      await rm(dir, { recursive: true, force: true });
      if (!resolved.ok) throw new Error(resolved.error);
    }),
    pass("bitstring-status", "S3", () => {
      const key = keyFromSeed("extra-status");
      const spec = decodeBitstring("uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA");
      if (spec.length !== 16384 || getBit(spec, 94567) !== 0) throw new Error("spec bitstring");
      const encoded = writeStatus(encodeBitstring(emptyBitstring()), 94567, "revocation", true);
      const issued = issueStatusList(key, { id: "https://rwaix.example/status/extra", statusPurpose: "revocation", encodedList: encoded, validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-12-01T00:00:00Z" });
      const checked = verifyStatusList({ credential: issued.credential, proof: issued.proof, index: 94567, purpose: "revocation", atTime: "2026-10-11T00:00:00Z", trustedIssuers: [key.publicRef] });
      if (checked.status !== "REVOKED") throw new Error("bit was not revoked");
      try {
        writeStatus(encoded, 94567, "revocation", false);
        throw new Error("revocation bit was cleared");
      } catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== "LIFECYCLE_TERMINAL") throw error;
      }
    }),
    pass("sd-jwt", "S2", () => {
      const key = keyFromSeed("extra-sd");
      const issued = issueSelectiveDisclosure(key, { shown: "yes", hidden: "no" }, { shown: "salt-shown-00000001", hidden: "salt-hidden-0000001" });
      const verified = verifySelectiveDisclosure(presentSelectiveDisclosure(issued.issuerJws, [issued.disclosures.shown]));
      if (verified.claims.shown !== "yes" || "hidden" in verified.claims) throw new Error("disclosure set");
    }),
    pass("zk-range", "S2", async () => {
      const proof = await proveRange(21n, 18n, 65n);
      if (!(await verifyRange(proof))) throw new Error("range proof");
      try {
        await proveRange(10n, 18n, 65n);
        throw new Error("out of range proof was produced");
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
      }
    }),
    pass("python-verifier", "N21", () => {
      const run = spawnSync("python3", ["verifiers/python/test_verifier.py"], { cwd: root, encoding: "utf8" });
      if (run.status !== 0) throw new Error((run.stdout || "") + (run.stderr || "python verifier failed"));
    }),
    pass("eight-profiles", "S18", () => {
      if (PROFILE_IDS.length !== 8 || PROFILE_IDS[0] !== "nft") throw new Error("nft is not the first profile");
      for (const id of PROFILE_IDS) {
        const report = runProfile(id);
        if (report.decision !== "ALLOW" || report.outOfScope.decision !== "DENY") throw new Error(id);
        if (id === "identity" && (report.feeSplit[0]?.amount !== "0" || report.feeSplit[1]?.amount !== "0")) throw new Error("identity fees");
      }
    }),
    pass("nft-trade", "S17", () => {
      const report = runProfile("nft");
      if (report.decision !== "ALLOW" || report.outOfScope.decision !== "DENY") throw new Error("nft decision");
      if (report.feeSplit[0]?.assetId !== "USD_TEST" || report.feeSplit[0]?.amount !== "12000") throw new Error("consideration");
      if (report.feeSplit[1]?.assetId !== "RWAIX_TEST" || report.feeSplit[1]?.amount !== "0" || report.feeSplit[1]?.state !== "OPEN") throw new Error("network fee");
      if (report.reconciliation.dischargeState !== "DISCHARGED") throw new Error("service not discharged");
      if (report.copyrightDecision !== "DENY") throw new Error("copyright transfer was not denied");
      if (report.dispute !== "OPEN" || report.reconciliation.disputesResolvedBySilence !== 0) throw new Error("dispute path");
      if (report.ledgers.rights.length !== 0) throw new Error("facility rights ledger was used");
    }),
    pass("section-19", "S19", () => {
      const result = runCrossScenario();
      if (!result.ok) throw new Error(result.detail);
    }),
    pass("chain-indexer", "N12", async () => {
      const sql = await openPglite();
      const chain = new FakeChain();
      const indexer = new ChainIndexer(sql, chain, "31337", 2);
      chain.push("0xaaa");
      await indexer.submit("op");
      await indexer.include("op", 1);
      await indexer.poll();
      chain.push("0xbbb");
      await indexer.poll();
      if (await indexer.state("op") !== "FINAL") throw new Error("not final");
      chain.reorg(1, ["0xccc", "0xddd"]);
      await indexer.poll();
      if (await indexer.state("op") !== "REORGED") throw new Error("not reorged");
      await sql.close();
    }),
    pass("account-recovery", "N12", () => {
      const clock = new ManualClock("2026-10-11T00:00:00Z");
      const recovery = new AccountRecovery(clock);
      recovery.register({ accountId: "a", controller: "old", guardians: ["g1", "g2"], threshold: 2, delaySeconds: 60 });
      recovery.revokeCredential("cred");
      recovery.propose("r", "a", "new", "g1");
      recovery.approve("r", "g2");
      clock.set("2026-10-11T00:01:00Z");
      const executed = recovery.execute("r");
      if (executed.assetsMoved || executed.credentialsRestored || !recovery.isRevoked("cred") || executed.controller !== "new") {
        throw new Error("recovery changed more than the controller");
      }
    }),
    pass("constrained-agent", "N14", () => {
      const book = new BudgetLedger();
      book.open({ grantId: "p", controller: "org", agent: "a", tools: ["render"], payees: ["provider"], assets: ["USD_TEST"], cap: 10n, expiry: "2026-12-01T00:00:00Z", allowRedelegate: true });
      book.delegate("p", { grantId: "c", agent: "b", tools: ["render"], payees: ["provider"], assets: ["USD_TEST"], cap: 4n, expiry: "2026-11-01T00:00:00Z", allowRedelegate: false });
      book.reserve({ grantId: "c", opId: "op", tool: "render", payee: "provider", asset: "USD_TEST", amount: 4n, now: "2026-10-11T00:00:00Z", note: "pay someone else" });
      book.markUnknown("op");
      try {
        book.release("op");
        throw new Error("unknown reservation was released");
      } catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== "OUTCOME_UNKNOWN") throw error;
      }
    }),
  ]);
  await shutdownProver();
  return results;
}
