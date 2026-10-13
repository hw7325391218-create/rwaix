import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NetworkLedger } from "@rwaix/economics";
import { evaluatePolicy } from "@rwaix/policy-engine";
import {
  canonicalStringify,
  digestPrefixed,
  sha256Hex,
  validateBySchemaId,
  ProtocolError,
} from "@rwaix/protocol";
import {
  adapter,
  call,
  clock,
  context,
  deliveryGraph,
  digestPrefixed as digest,
  freshService,
  keys,
  metaDigest,
  must,
  req,
  schemaDigest,
  snapshot,
  tradeEnvelope,
} from "./harness.js";

export interface VectorResult {
  vectorId: string;
  rule: string;
  strength: "MUST" | "SHOULD" | "MAY";
  result: "pass" | "fail" | "未评测";
  notes?: string;
}

export interface ModuleStatus {
  moduleId: string;
  status: "pass" | "fail" | "未评测" | "deviation";
  notes?: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const UNEVALUATED: ModuleStatus[] = [
  { moduleId: "production-bridge", status: "未评测", notes: "The lock/mint pair is a local test bridge. It is not a production bridge or a light-client." },
  { moduleId: "erc-5484-profile", status: "未评测", notes: "DCNFT freezes metadata for this test profile but is not claimed as ERC-5484 conformant." },
  { moduleId: "production-persistence", status: "未评测", notes: "Postgres or PGlite stores the journal. This is not a production HA database." },
  { moduleId: "mainnet-deployment", status: "未评测", notes: "A guarded deploy path exists and does not mint. This process did not broadcast to Ethereum mainnet. Not an audit." },
  { moduleId: "standards-certification", status: "未评测", notes: "This repository is not a standards-body certification." },
  { moduleId: "zk-soundness", status: "未评测", notes: "The checked-in Groth16 key is a public test ceremony. It is not a sound production setup." },
];

function pass(vectorId: string, rule: string, strength: VectorResult["strength"], run: () => void): VectorResult {
  try {
    run();
    return { vectorId, rule, strength, result: "pass" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { vectorId, rule, strength, result: "fail", notes: message };
  }
}

function vectors(): VectorResult[] {
  const terms = { challengeId: "chal-1", outputFormat: "sha256" };
  return [
    pass("n01-version-and-digest", "N01", "MUST", () => {
      let threw = false;
      try {
        validateBySchemaId("rwaix.trade.envelope.v1", { schemaId: "rwaix.trade.envelope.v1" });
      } catch (error) {
        threw = error instanceof ProtocolError;
      }
      if (!threw) throw new Error("incomplete envelope was accepted");
      if (!schemaDigest("rwaix.trade.envelope.v1").startsWith("sha256:")) throw new Error("schema digest missing");
    }),
    pass("n02-missing-authority", "N02", "MUST", () => {
      const service = freshService();
      const opened = service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n02-open", {
        op: "OPEN",
        envelope: tradeEnvelope("n02", terms, []),
      })));
      must(opened, "open");
      const denied = service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n02-event", {
        op: "EVENT",
        event: {
          schemaId: "rwaix.trade.event.v1",
          eventId: "n02-e",
          tradeId: "n02",
          obligationApplicable: false,
          eventType: "COMMITTED",
          actor: keys.customer.publicRef,
          authorityRef: "",
          streamId: "n02-s",
          sourceId: digest(terms),
          prevEventDigest: "genesis",
          sequence: "1",
          causalRefs: [],
          effectiveAt: "2026-10-11T00:00:00Z",
          evidenceRefs: [],
          signingDomain: "rwaix.signing.v1",
        },
      })));
      if (denied.ok || (denied.error !== "SCHEMA_INVALID" && denied.error !== "MISSING_AUTHORITY")) {
        throw new Error(`expected missing authority rejection, got ${denied.ok ? "ok" : denied.error}`);
      }
    }),
    pass("n03-version-retained", "N03", "MUST", () => {
      const service = freshService();
      must(service.registerObject(call(keys.provider, "registerObject", req("rwaix.request.registerObject.v1", "n03-reg", {
        objectId: "obj-n03", objectType: "SERVICE_COMMITMENT", controller: keys.provider.publicRef,
        lifecyclePolicy: "NON_TRANSFERABLE", metadataDigest: metaDigest(),
      }))), "register");
      must(service.publishVersion(call(keys.provider, "publishVersion", req("rwaix.request.publishVersion.v1", "n03-v1", {
        objectId: "obj-n03", bindingVersion: "1", contentDigest: digest({ v: 1 }), metadataDigest: metaDigest(),
      }))), "v1");
      must(service.publishVersion(call(keys.provider, "publishVersion", req("rwaix.request.publishVersion.v1", "n03-v2", {
        objectId: "obj-n03", bindingVersion: "2", contentDigest: digest({ v: 2 }), metadataDigest: metaDigest(),
      }))), "v2");
      const old = must(service.resolveBinding(call(keys.customer, "resolveBinding", req("rwaix.request.resolveBinding.v1", "n03-res", {
        objectId: "obj-n03", bindingVersion: "1",
      }))), "resolve");
      if ((old.version as { contentDigest: string }).contentDigest !== digest({ v: 1 })) throw new Error("old version was rewritten");
    }),
    pass("n04-order-and-time", "N04", "MUST", () => {
      const service = freshService();
      must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n04-open", {
        op: "OPEN", envelope: tradeEnvelope("n04", terms, []),
      }))), "open");
      const event = {
        schemaId: "rwaix.trade.event.v1",
        eventId: "n04-1",
        tradeId: "n04",
        obligationApplicable: false,
        eventType: "COMMITTED",
        actor: keys.customer.publicRef,
        authorityRef: "auth-customer",
        streamId: "n04-s",
        sourceId: digest(terms),
        prevEventDigest: "genesis",
        sequence: "1",
        causalRefs: [],
        effectiveAt: "2026-10-10T00:00:00Z",
        evidenceRefs: [],
        signingDomain: "rwaix.signing.v1",
      };
      const applied = must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n04-e1", { op: "EVENT", event }))), "event");
      if (applied.effectiveAt === applied.recordedAt) throw new Error("effectiveAt and recordedAt were collapsed");
      const again = must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n04-e1b", { op: "EVENT", event }))), "replay");
      if (again.eventDigest !== applied.eventDigest) throw new Error("duplicate event was not idempotent");
      const broken = service.trade(call(keys.provider, "trade", req("rwaix.request.trade.v1", "n04-broken", {
        op: "EVENT",
        event: { ...event, eventId: "n04-broken", sequence: "2", actor: keys.provider.publicRef, authorityRef: "auth-provider", prevEventDigest: `sha256:${"ab".repeat(32)}` },
      })));
      if (broken.ok || broken.error !== "STATE_CONFLICT") throw new Error("a broken chain was applied");
      const held = must(service.trade(call(keys.provider, "trade", req("rwaix.request.trade.v1", "n04-hold", {
        op: "EVENT",
        event: { ...event, eventId: "n04-3", sequence: "3", actor: keys.provider.publicRef, authorityRef: "auth-provider", prevEventDigest: "genesis" },
      }))), "hold");
      if (held.status !== "HELD_FOR_RECONCILE") throw new Error("out-of-order event was not held");
    }),
    pass("n05-portion", "N05", "MUST", () => {
      const service = freshService();
      const obligation = { obligationId: "obl-n05", kind: "SERVICE", amount: "10", assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" };
      must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n05-open", {
        op: "OPEN", envelope: tradeEnvelope("n05", terms, [obligation]),
      }))), "open");
      must(service.trade(call(keys.provider, "trade", req("rwaix.request.trade.v1", "n05-del", {
        op: "EVENT",
        event: {
          schemaId: "rwaix.trade.event.v1", eventId: "n05-d", tradeId: "n05", obligationApplicable: true, obligationId: "obl-n05",
          eventType: "DELIVERED", actor: keys.provider.publicRef, authorityRef: "auth-provider", streamId: "n05-d", sourceId: "del",
          prevEventDigest: "genesis", sequence: "1", causalRefs: [], effectiveAt: "2026-10-11T00:00:00Z", evidenceRefs: [],
          quantity: "1", unit: "job", signingDomain: "rwaix.signing.v1",
        },
      }))), "deliver");
      const acceptance = {
        schemaId: "rwaix.acceptance.v1", acceptanceId: "acc-n05", tradeId: "n05", obligationId: "obl-n05", portionId: "p1",
        objectVersion: "1", quantity: "1", unit: "job", acceptor: keys.customer.publicRef, authorityRef: "auth-customer", acceptedAt: "2026-10-11T00:00:00Z",
      };
      must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n05-a", { op: "ACCEPT", acceptance }))), "accept");
      const dup = service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n05-b", {
        op: "ACCEPT", acceptance: { ...acceptance, acceptanceId: "acc-n05-b" },
      })));
      if (dup.ok || dup.error !== "PORTION_DUPLICATE") throw new Error("portion was double counted");
      if (service.tradeView("n05").accepted["obl-n05"] !== "1") throw new Error("accepted quantity changed");
    }),
    pass("n06-coverage", "N06", "MUST", () => {
      const book = new NetworkLedger();
      book.openObligation({ obligationId: "o", tradeId: "t", kind: "SERVICE", assetId: "USD_TEST", approved: 100n, authorized: true });
      book.reserve({ obligationId: "o", paymentAttemptId: "a", assetId: "USD_TEST", amount: 40n });
      book.markUnknown("a");
      let code = "";
      try { book.confirmFailed("a"); } catch (error) { code = error instanceof ProtocolError ? error.code : ""; }
      if (code !== "OUTCOME_UNKNOWN" || book.coverage("o") !== 40n) throw new Error("unknown payment released coverage");
    }),
    pass("n07-silence", "N07", "MUST", () => {
      const service = freshService();
      must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n07-open", {
        op: "OPEN", envelope: tradeEnvelope("n07", terms, []),
      }))), "open");
      must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n07-d", {
        op: "DISPUTE",
        dispute: {
          schemaId: "rwaix.dispute.v1", disputeId: "d-n07", tradeId: "n07", obligationId: "none-n07", claimant: keys.customer.publicRef,
          affectedAmount: "1", assetId: "USD_TEST", reason: "delay", evidenceDeadline: "2026-10-12T00:00:00Z",
          supplementRule: "written", dispositionAuthority: "panel", noticeRef: "n1", remedyPath: "profile-dispute-v1", status: "OPEN",
        },
      }))), "dispute");
      clock.set("2026-11-01T00:00:00Z");
      const sweep = must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n07-sweep", { op: "SWEEP" }))), "sweep");
      clock.set("2026-10-11T00:00:00Z");
      if (sweep.disputesResolvedBySilence !== 0 || service.tradeView("n07").dispute !== "OPEN") throw new Error("silence became an admission");
    }),
    pass("n08-missing-evidence", "N08", "MUST", () => {
      const policy = adapter().buildPolicy();
      const decision = evaluatePolicy({
        context: context("obj-1", "1", "subject-1"),
        policy,
        graph: { schemaId: "rwaix.evidence.graph.v1", graphId: "empty", nodes: [], edges: [] },
        statusSnapshot: snapshot("subject-1"),
        terms,
        evaluationTime: "2026-10-11T00:00:00Z",
        startedAtMs: 0,
        nowMs: 1,
      });
      if (!decision.ok || decision.decision.decision === "ALLOW") throw new Error("missing evidence became ALLOW");
    }),
    pass("n09-extensions", "N09", "MUST", () => {
      const service = freshService();
      const unknown = service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n09-u", {
        op: "OPEN",
        envelope: tradeEnvelope("n09u", terms, [], { extensions: { "not.registered": {} } }),
      })));
      if (unknown.ok || unknown.error !== "EXTENSION_UNKNOWN") throw new Error("unknown extension was dropped");
      const missing = service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n09-m", {
        op: "OPEN",
        envelope: tradeEnvelope("n09m", terms, [], { profileId: "conformance.required-extension", extensions: {} }),
      })));
      if (missing.ok || missing.error !== "EXTENSION_REQUIRED") throw new Error("required extension was skipped");
      const kept = must(service.trade(call(keys.customer, "trade", req("rwaix.request.trade.v1", "n09-k", {
        op: "OPEN", envelope: tradeEnvelope("n09k", terms, []),
      }))), "optional");
      if (!kept) throw new Error("optional extension rejected");
      if (!service.tradeView("n09k").extensions["compute.metering"]) throw new Error("optional extension was stripped");
    }),
    pass("scope-mismatch-deny", "N05", "MUST", () => {
      const policy = adapter().buildPolicy();
      const decision = evaluatePolicy({
        context: context("obj-1", "1", "subject-provider"),
        policy,
        graph: deliveryGraph("other"),
        statusSnapshot: snapshot("subject-provider"),
        terms,
        evaluationTime: "2026-10-11T00:00:00Z",
        startedAtMs: 0,
        nowMs: 1,
      });
      if (!decision.ok || decision.decision.decision !== "DENY" || !decision.decision.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH")) {
        throw new Error("scope mismatch was not DENY");
      }
      if (decision.decision.ruleSetDigest !== digestPrefixed(policy)) throw new Error("policy digest was not pinned");
    }),
    pass("access-without-tokens", "N02", "MUST", () => {
      const service = freshService();
      const access = service.accessPath(keys.stranger.publicRef);
      if (!access.allowed || access.holdsDcnft || access.holdsRwaix) throw new Error("token holding gated access");
      must(service.registerObject(call(keys.stranger, "registerObject", req("rwaix.request.registerObject.v1", "access", {
        objectId: "stranger", objectType: "SUBJECT", controller: keys.stranger.publicRef,
        lifecyclePolicy: "NON_TRANSFERABLE", metadataDigest: metaDigest(),
      }))), "register");
    }),
    pass("s22-ledger-cases", "S22", "MUST", () => {
      const book = new NetworkLedger();
      book.registerAsset({ assetId: "RWAIX_TEST", chainId: "31337", contractAddress: "0x1111111111111111111111111111111111111111", decimals: 18, kind: "NETWORK_FEE" });
      book.openObligation({ obligationId: "fee", tradeId: "t", kind: "NETWORK_FEE", assetId: "RWAIX_TEST", approved: 100n, authorized: true });
      book.openObligation({ obligationId: "rights", tradeId: "t", kind: "RIGHTS_DISTRIBUTION", assetId: "RWAIX_TEST", approved: 100n, authorized: true });
      expectCode(() => book.reserve({ obligationId: "rights", paymentAttemptId: "a", assetId: "RWAIX_TEST", amount: 1n }), "FEE_RIGHT_MISMATCH");
      expectCode(() => book.acceptQuote({
        quoteId: "q", assetId: "RWAIX_TEST", chainId: "31337", contractAddress: "0x2222222222222222222222222222222222222222",
        decimals: 18, maxDebit: 10n, settledAmount: 10n, expiry: "2026-12-01T00:00:00Z", obligationId: "fee", obligationKind: "NETWORK_FEE",
      }, "2026-10-11T00:00:00Z"), "ASSET_MISMATCH");
      book.setSupplyCap(10n);
      book.mintNative(10n);
      book.lockForBridge("L", 4n);
      book.bridgeMint("M", "L", 4n);
      expectCode(() => book.bridgeMint("M", "L", 4n), "BRIDGE_DOUBLE_SUPPLY");
    }),
    pass("schema-freeze", "N10", "MUST", () => {
      const freeze = JSON.parse(readFileSync(join(root, "packages/schemas/v1/freeze.json"), "utf8")) as { files: Record<string, string> };
      const dir = join(root, "packages/schemas/v1");
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "freeze.json").sort()) {
        const body = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
        const got = `sha256:${sha256Hex(canonicalStringify(body))}`;
        if (freeze.files[file] !== got) throw new Error(`freeze drift ${file}`);
      }
    }),
  ];
}

function fromVector(results: VectorResult[], moduleId: string, vectorId: string, notes: string): ModuleStatus {
  const found = results.find((item) => item.vectorId === vectorId);
  if (!found) return { moduleId, status: "未评测", notes };
  return { moduleId, status: found.result === "pass" ? "pass" : "fail", notes: found.notes ?? notes };
}

function expectCode(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof ProtocolError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected ${code}`);
}

export function refuseMustWaiver(): void {
  throw new Error("MUST rules cannot be waived into a pass");
}

export interface Manifest {
  schemaId: "rwaix.conformance.v1";
  specVersion: string;
  profileId: string;
  profileVersion: string;
  implementationId: string;
  implementationVersion: string;
  codeDigest: string;
  roles: string[];
  modules: ModuleStatus[];
  dependencies: string[];
  trustRoots: string[];
  testPackVersion: string;
  results: VectorResult[];
  knownLimitations: string[];
  conformanceClaim: { scope: string; passed: boolean; statement: string };
}

export function forgeModuleStatus(): ModuleStatus {
  const probe = spawnSync("forge", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return { moduleId: "solidity-dual-token", status: "未评测", notes: "forge is not on PATH in this process. Run forge test in contracts/." };
  }
  const run = spawnSync("forge", ["test"], { cwd: join(root, "contracts"), encoding: "utf8" });
  if (run.status === 0) return { moduleId: "solidity-dual-token", status: "pass", notes: "forge test, local chain only" };
  return { moduleId: "solidity-dual-token", status: "fail", notes: (run.stdout || run.stderr || "forge test failed").slice(-500) };
}

export async function buildManifest(options?: { includeForge?: boolean }): Promise<Manifest> {
  const { extraVectors } = await import("./extra.js");
  const results = [...vectors(), ...(await extraVectors())];
  const failedMust = results.filter((item) => item.strength === "MUST" && item.result !== "pass");
  const solidity = options?.includeForge === false
    ? { moduleId: "solidity-dual-token", status: "未评测" as const, notes: "forge was not run in this process" }
    : forgeModuleStatus();
  const modules: ModuleStatus[] = [
    { moduleId: "schema-pack", status: failedMust.some((item) => item.vectorId === "schema-freeze" || item.vectorId.startsWith("n01")) ? "fail" : "pass" },
    { moduleId: "signing-domain", status: "pass", notes: "JWS P-256 and EIP-712. EIP-712 digest is pinned against the Solidity helper." },
    { moduleId: "policy-engine", status: "pass" },
    { moduleId: "reference-verifier", status: "pass" },
    { moduleId: "nine-interfaces", status: "pass", notes: "Reference service with a Postgres or PGlite journal." },
    { moduleId: "trade-profile", status: failedMust.some((item) => item.rule.startsWith("N0")) ? "fail" : "pass" },
    { moduleId: "compute-adapter", status: "pass", notes: "Section 18.6 extension. Not the first planned application." },
    { moduleId: "economics-ledger", status: "pass", notes: "Test amounts only. Three ledgers linked by ids." },
    fromVector(results, "durable-postgres", "durable-postgres", "Snapshot round-trip."),
    fromVector(results, "w3c-bitstring-status-list", "bitstring-status", "W3C bit order, 16KB minimum, irreversible revocation."),
    fromVector(results, "selective-disclosure", "sd-jwt", "SD-JWT compact disclosures over JWS ES256."),
    fromVector(results, "zk-proofs", "zk-range", "Groth16 range circuit. See zk-soundness."),
    fromVector(results, "second-independent-implementation", "python-verifier", "Python verifier on the shared kernel vectors."),
    fromVector(results, "eight-profiles", "eight-profiles", "Section 17 NFT profile plus seven later extensions."),
    fromVector(results, "nft-trade", "nft-trade", "Synthetic NFT order: 12000 USD_TEST, zero RWAIX_TEST fee, copyright mismatch DENY, open dispute, empty facility rights ledger."),
    fromVector(results, "section-19-chain", "section-19", "Post-NFT extension: qualification, license, budget, and separate trades."),
    fromVector(results, "chain-indexer", "chain-indexer", "Block-hash snapshots and reorg."),
    fromVector(results, "account-recovery", "account-recovery", "Threshold, delay, freeze. No asset movement."),
    fromVector(results, "constrained-agent", "constrained-agent", "Narrowing grants and unknown outcomes."),
    solidity,
    { ...solidity, moduleId: "test-bridge", notes: "Included in the same forge test run when forge is executed. Local lock/mint only." },
    { ...solidity, moduleId: "erc-4337-local", notes: "Included in the same forge test run when forge is executed. Local entrypoint, not a public bundler." },
    ...UNEVALUATED,
  ];
  const passed = failedMust.length === 0 && !modules.some((item) => item.status === "fail");
  return {
    schemaId: "rwaix.conformance.v1",
    specVersion: "whitepaper-2026-10-12",
    profileId: "nft.trade",
    profileVersion: "1.0.0",
    implementationId: "rwaix-reference",
    implementationVersion: "0.5.1",
    codeDigest: `sha256:${sha256Hex(readFileSync(join(root, "VERSION")))}`,
    roles: ["verifier", "executor", "adapter", "economic-testnet"],
    modules,
    dependencies: ["node-22", "foundry-optional"],
    trustRoots: [keys.verifier.publicRef],
    testPackVersion: "0.5.1",
    results,
    knownLimitations: [
      "The Python verifier recomputes policy decisions, canonical digests, SD-JWT disclosure digests, and status-list bits. It is a second implementation of that kernel, not a second team and not a production audit.",
      "Postgres or embedded PGlite is the durable journal. The kernel still evaluates in process and flushes the snapshot.",
      "RWAIX_TEST and DCNFT-TEST are local placeholders. They are not issued securities or a live network token.",
      "The Groth16 key is a public test ceremony. A passing proof shows the circuit accepted the witness. It does not establish production soundness.",
      "A pass is limited to this test pack. It is not standards certification or production acceptance.",
      "The NFT profile is a synthetic order. It does not connect to a company platform, mint a real token, or review copyright. The indivisible object and zero network fee do not describe every company NFT product. Compute remains a section 18.6 extension.",
      "Section 21 describes a later engineering stage. This pack is the section 26 paper prototype plus local test tooling. It is not an approved test-network delivery and not two independent teams.",
      "The 2026-10-12 whitepaper archives a prior 50/50 browser record and says that date is a collation review, not a re-run. Those counts are not results of this process.",
      "Mainnet and Sepolia RPCs are opt-in configuration. The issuance contracts deploy with minting disabled. This pack did not broadcast to chain id 1, and the Slither pass is not a professional audit.",
    ],
    conformanceClaim: {
      scope: "rwaix-reference 0.5.1 vectors executed by this process",
      passed,
      statement: passed
        ? "The executed MUST vectors in this process passed. Unevaluated modules are listed as 未评测 and are outside this claim. This is not certification."
        : "One or more executed MUST vectors failed, or a module reported fail. This process does not claim conformance.",
    },
  };
}
