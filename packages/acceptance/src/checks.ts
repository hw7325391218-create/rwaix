import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetLedger } from "@rwaix/agent";
import { buildManifest, refuseMustWaiver } from "@rwaix/conformance";
import { NetworkLedger, RightsLedger } from "@rwaix/economics";
import { evaluatePolicy, type EvaluationInput } from "@rwaix/policy-engine";
import { digestPrefixed, schemaDigest, signRequest } from "@rwaix/protocol";
import { PROFILE_IDS, runCrossScenario, runProfile } from "@rwaix/scenarios";
import { start } from "@rwaix/server";
import { computeGraph, evaluateRequest, fail, objectRequest, readyAllow, simplePolicy, world } from "./harness.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export class NotEvaluated extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotEvaluated";
  }
}

export interface Check {
  id: string;
  name: string;
  clause: string;
  run: () => Promise<string> | string;
}

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
}

function expectThrow(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    if (codeOf(error) === code) return;
    throw new Error(`expected ${code}, got ${error instanceof Error ? `${codeOf(error) || error.name}: ${error.message}` : String(error)}`);
  }
  throw new Error(`expected ${code} but the call returned`);
}

function toolEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? "";
  return { ...process.env, PATH: `${home}/.foundry/bin:${process.env.PATH ?? ""}` };
}

function command(name: string): string | undefined {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8", env: toolEnv() });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  if (probe.status !== 0 && probe.error) return undefined;
  return (probe.stdout || probe.stderr || name).trim().split("\n")[0];
}

function forgeTest(match: string): string {
  const forge = command("forge");
  if (!forge) throw new NotEvaluated("forge is not on PATH, so this contract check was not executed.");
  const run = spawnSync("forge", ["test", "--match-test", match, "-vv"], {
    cwd: join(root, "contracts"),
    encoding: "utf8",
    env: toolEnv(),
    timeout: 180_000,
  });
  const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (run.error) throw new Error(run.error.message);
  if (run.status !== 0 || !text.includes(`[PASS] ${match}()`)) {
    throw new Error(text.trim().slice(-1200) || `forge exited ${run.status}`);
  }
  return text.trim().split("\n").filter((line) => line.includes(match) || line.includes("Suite result")).slice(-4).join(" | ");
}

function waitPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`nothing listened on 127.0.0.1:${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function policyInput(over: Partial<EvaluationInput> = {}): EvaluationInput {
  const digest = digestPrefixed({ v: 1 });
  return {
    context: {
      schemaId: "rwaix.context.v1",
      audience: "aud",
      purpose: "purpose",
      objectRef: { objectId: "obj-1", bindingVersion: "1" },
      requestedAction: "read",
      domain: "acceptance",
      subjectRef: "subject-1",
      challengeNonce: "nonce-1234",
      deadline: "2026-10-12T00:00:00Z",
      policyVersion: "1.0.0",
    },
    policy: simplePolicy(),
    graph: {
      schemaId: "rwaix.evidence.graph.v1",
      graphId: "g1",
      nodes: [
        {
          nodeId: "n1",
          nodeType: "OBSERVATION",
          sourceId: "s1",
          controllerId: "c1",
          contentDigest: digest,
          capturedAt: "2026-10-11T00:00:00Z",
          payload: { challengeId: "c" },
        },
      ],
      edges: [],
    },
    statusSnapshot: {
      schemaId: "rwaix.status.snapshot.v1",
      snapshotId: "snap-1",
      asOf: "2026-10-11T00:00:00Z",
      entries: [{ subjectRef: "subject-1", status: "ACTIVE" }],
    },
    terms: { challengeId: "c" },
    evaluationTime: "2026-10-11T00:00:00Z",
    startedAtMs: 0,
    nowMs: 1,
    ...over,
  };
}

function prepare(w: ReturnType<typeof world>, receiptId: string, idem: string, nonce: string) {
  return w.service.prepareIntent(w.call(w.executor, "prepareIntent", w.req("rwaix.request.prepareIntent.v1", idem, {
    intentId: idem,
    receiptId,
    action: "pay",
    payer: w.customer.publicRef,
    payee: w.provider.publicRef,
    assetId: "USD_TEST",
    amount: "40",
    obligationId: "obl-svc",
    intentNonce: nonce,
    intentDeadline: "2026-10-12T00:00:00Z",
    maxStalenessSeconds: "3600",
  })));
}

export const CHECKS: Check[] = [
  {
    id: "A01",
    name: "Deterministic policy replay",
    clause: "§22 minimum security threshold: deterministic output on the published test set",
    run: () => {
      const input = policyInput();
      const first = evaluatePolicy(input);
      const second = evaluatePolicy(input);
      if (!first.ok || !second.ok) fail(`evaluation failed: ${first.ok ? "" : first.error} ${second.ok ? "" : second.error}`);
      if (first.decision.decisionId !== second.decision.decisionId) fail("decisionId changed across an identical replay");
      if (first.decision.decision !== "ALLOW" || second.decision.decision !== "ALLOW") fail(first.decision.decision);
      return `decisionId ${first.decision.decisionId} repeated`;
    },
  },
  {
    id: "A02",
    name: "Invalid signature produces no authorization",
    clause: "§22 minimum security threshold: invalid signature",
    run: () => {
      const w = world("a02");
      const signed = w.call(w.stranger, "registerObject", objectRequest(w, "obj-bad-sig", w.stranger.publicRef, "idem-bad"));
      signed.proof = `${signed.proof.slice(0, -8)}AAAAAAAA`;
      const result = w.service.registerObject(signed);
      if (result.ok || result.error !== "SIGNATURE_INVALID") fail(result.ok ? "tampered proof was accepted" : `${result.error} ${result.message}`);
      if (w.service.exportLedgers().objects.length !== 0) fail("object was stored after a bad signature");
      return "SIGNATURE_INVALID; object count 0";
    },
  },
  {
    id: "A03",
    name: "Expired deadline produces no authorization",
    clause: "§22 minimum security threshold: expiry",
    run: () => {
      const w = world("a03");
      const signed = w.call(w.stranger, "registerObject", objectRequest(w, "obj-expired", w.stranger.publicRef, "idem-exp"), {
        deadline: "2020-01-01T00:00:00Z",
      });
      const result = w.service.registerObject(signed);
      if (result.ok || result.error !== "EXPIRED") fail(result.ok ? "expired request was accepted" : `${result.error} ${result.message}`);
      if (w.service.exportLedgers().objects.length !== 0) fail("object was stored after expiry");
      return "EXPIRED; object count 0";
    },
  },
  {
    id: "A04",
    name: "Revocation blocks execution",
    clause: "§22 minimum security threshold: revocation; §4 N02 revocation status",
    run: () => {
      const { w, receiptId } = readyAllow("a04");
      const revoked = w.service.setStatus(w.call(w.admin, "setStatus", w.req("rwaix.request.setStatus.v1", "idem-revoke", {
        subjectRef: "subject-provider",
        status: "REVOKED",
      })));
      if (!revoked.ok) fail(`${revoked.error} ${revoked.message}`);
      const blocked = prepare(w, receiptId, "idem-prep", "intent-nonce-revoked");
      if (blocked.ok || blocked.error !== "REVOKED") fail(blocked.ok ? "revoked subject produced an intent" : `${blocked.error} ${blocked.message}`);
      if (w.service.network.coverage("obl-svc") !== 0n) fail(`coverage ${w.service.network.coverage("obl-svc")}`);
      return "REVOKED; coverage 0";
    },
  },
  {
    id: "A05",
    name: "Wrong audience produces no authorization",
    clause: "§22 minimum security threshold: wrong audience",
    run: () => {
      const w = world("a05");
      const signed = w.call(w.stranger, "registerObject", objectRequest(w, "obj-aud", w.stranger.publicRef, "idem-aud"), {
        audience: "not-this-service",
      });
      const result = w.service.registerObject(signed);
      if (result.ok || result.error !== "AUDIENCE_MISMATCH") fail(result.ok ? "wrong audience was accepted" : `${result.error} ${result.message}`);
      if (w.service.exportLedgers().objects.length !== 0) fail("object was stored for the wrong audience");
      return "AUDIENCE_MISMATCH; object count 0";
    },
  },
  {
    id: "A06",
    name: "Nonce replay produces no second authorization",
    clause: "§22 minimum security threshold: replay",
    run: () => {
      const w = world("a06");
      const first = w.service.registerObject(signRequest(w.stranger, "registerObject", objectRequest(w, "obj-replay", w.stranger.publicRef, "idem-1"), {
        nonce: "nonce-reused-once",
        deadline: "2027-01-01T00:00:00Z",
      }));
      if (!first.ok) fail(`${first.error} ${first.message}`);
      const second = w.service.registerObject(signRequest(w.stranger, "registerObject", objectRequest(w, "obj-replay-2", w.stranger.publicRef, "idem-2"), {
        nonce: "nonce-reused-once",
        deadline: "2027-01-01T00:00:00Z",
      }));
      if (second.ok || second.error !== "NONCE_REUSED") fail(second.ok ? "reused nonce created a second object" : `${second.error} ${second.message}`);
      if (w.service.exportLedgers().objects.length !== 1) fail(`objects ${w.service.exportLedgers().objects.length}`);
      return "NONCE_REUSED; object count 1";
    },
  },
  {
    id: "A07",
    name: "Unauthorized role produces no authorization",
    clause: "§22 minimum security threshold: unauthorized action",
    run: () => {
      const w = world("a07");
      const hijack = w.service.registerObject(w.call(w.stranger, "registerObject", objectRequest(w, "obj-hijack", w.provider.publicRef, "idem-hijack")));
      if (hijack.ok || hijack.error !== "UNAUTHORIZED") fail(hijack.ok ? "stranger registered another controller" : `${hijack.error} ${hijack.message}`);
      const status = w.service.setStatus(w.call(w.stranger, "setStatus", w.req("rwaix.request.setStatus.v1", "idem-status", {
        subjectRef: "subject-provider",
        status: "REVOKED",
      })));
      if (status.ok || status.error !== "UNAUTHORIZED") fail(status.ok ? "stranger revoked a subject" : `${status.error} ${status.message}`);
      if (w.service.exportLedgers().objects.length !== 0) fail("unauthorized register stored an object");
      return "UNAUTHORIZED for foreign controller and for setStatus";
    },
  },
  {
    id: "A08",
    name: "DENY does not become an executable authorization",
    clause: "§22 minimum security threshold: failure does not silently become accept",
    run: () => {
      const { w } = readyAllow("a08");
      const denied = w.service.evaluatePolicy(w.call(w.customer, "evaluatePolicy", evaluateRequest(w, computeGraph(w, "other-challenge"), "idem-deny", "chal-1")));
      if (!denied.ok) fail(`${denied.error} ${denied.message}`);
      if (denied.value.decision.decision !== "DENY") fail(denied.value.decision.decision);
      if (!denied.value.decision.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH")) fail(denied.value.decision.reasonCodes.join(","));
      const blocked = prepare(w, denied.value.receipt.receiptId, "idem-deny-prep", "intent-nonce-deny");
      if (blocked.ok || blocked.error !== "STATE_CONFLICT") fail(blocked.ok ? "DENY receipt was executed" : `${blocked.error} ${blocked.message}`);
      if (w.service.network.coverage("obl-svc") !== 0n) fail("DENY created coverage");
      return "DENY DOMAIN_POLICY_SCOPE_MISMATCH; prepareIntent STATE_CONFLICT; coverage 0";
    },
  },
  {
    id: "A09",
    name: "Changing the payment asset does not create a second payment right",
    clause: "§4 N01: the same debt on another asset, chain, or adapter must not create an extra payment right",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.openObligation({ obligationId: "obl-1", tradeId: "t1", kind: "SERVICE", assetId: "USD_TEST", approved: 100n, authorized: true });
      expectThrow(() => ledger.reserve({ obligationId: "obl-1", paymentAttemptId: "p1", assetId: "RWAIX_TEST", amount: 1n }), "ASSET_MISMATCH");
      expectThrow(() => ledger.openObligation({ obligationId: "obl-1", tradeId: "t1", kind: "SERVICE", assetId: "RWAIX_TEST", approved: 100n, authorized: true }), "STATE_CONFLICT");
      if (ledger.obligations.size !== 1 || ledger.coverage("obl-1") !== 0n) fail("a second payment right or coverage was created");
      return "ASSET_MISMATCH; one obligation; coverage 0";
    },
  },
  {
    id: "A10",
    name: "Missing authority is not ALLOW, and holding no token still registers",
    clause: "§4 N02 and §5: missing authority is deny or indeterminate; token holdings are not the access gate",
    run: () => {
      const missing = evaluatePolicy(policyInput({
        policy: simplePolicy({
          rules: [{ id: "issuer", predicate: "issuerAllowlist", params: { issuers: ["issuer-1"] } }],
        }),
      }));
      if (!missing.ok || missing.decision.decision !== "INDETERMINATE" || !missing.decision.reasonCodes.includes("MISSING_AUTHORITY")) {
        fail(missing.ok ? `${missing.decision.decision} ${missing.decision.reasonCodes.join(",")}` : missing.error);
      }
      const w = world("a10");
      const access = w.service.accessPath(w.stranger.publicRef);
      if (!access.allowed || access.holdsDcnft || access.holdsRwaix) fail(JSON.stringify(access));
      const created = w.service.registerObject(w.call(w.stranger, "registerObject", objectRequest(w, "obj-open", w.stranger.publicRef, "idem-open")));
      if (!created.ok || created.value.tokenBalanceChecked !== false) fail(created.ok ? "token balance was a gate" : created.error);
      return "INDETERMINATE MISSING_AUTHORITY; register allowed with both balances false";
    },
  },
  {
    id: "A11",
    name: "A new version keeps the previous version",
    clause: "§4 N03: a change creates a new version and retains the old version",
    run: () => {
      const w = world("a11");
      const meta = digestPrefixed({ objectId: "svc-ver" });
      const v1Digest = digestPrefixed({ version: 1 });
      const v2Digest = digestPrefixed({ version: 2 });
      if (!w.service.registerObject(w.call(w.provider, "registerObject", objectRequest(w, "svc-ver", w.provider.publicRef, "idem-reg"))).ok) fail("register");
      if (!w.service.publishVersion(w.call(w.provider, "publishVersion", w.req("rwaix.request.publishVersion.v1", "idem-v1", {
        objectId: "svc-ver", bindingVersion: "1", contentDigest: v1Digest, metadataDigest: meta,
      }))).ok) fail("v1");
      if (!w.service.publishVersion(w.call(w.provider, "publishVersion", w.req("rwaix.request.publishVersion.v1", "idem-v2", {
        objectId: "svc-ver", bindingVersion: "2", contentDigest: v2Digest, metadataDigest: digestPrefixed({ rev: 2 }),
      }))).ok) fail("v2");
      const old = w.service.resolveBinding(w.call(w.customer, "resolveBinding", w.req("rwaix.request.resolveBinding.v1", "idem-old", {
        objectId: "svc-ver", bindingVersion: "1",
      })));
      if (!old.ok) fail(old.error);
      const stored = (old.value.version as { contentDigest?: string }).contentDigest;
      if (stored !== v1Digest) fail(`old version became ${stored}`);
      return "bindingVersion 1 contentDigest unchanged after version 2";
    },
  },
  {
    id: "A12",
    name: "Payment confirmation does not close acceptance or a dispute",
    clause: "§4 N04: chain success does not infer acceptance or the end of a dispute",
    run: () => {
      const w = world("a12");
      const terms = { challengeId: "chal-1", outputFormat: "sha256" };
      const opened = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-open", {
        op: "OPEN",
        envelope: {
          schemaId: "rwaix.trade.envelope.v1",
          protocolVersion: "rwaix-0.1.0",
          profileId: "compute.delivery",
          profileVersion: "1.0.0",
          schemaDigest: schemaDigest("rwaix.trade.envelope.v1"),
          tradeId: "trade-pay",
          termsDigest: digestPrefixed(terms),
          parties: [
            { partyId: w.customer.publicRef, role: "CUSTOMER", authorityRef: "auth-customer" },
            { partyId: w.provider.publicRef, role: "PROVIDER", authorityRef: "auth-provider" },
          ],
          objects: [{ objectId: "svc-pay", quantity: "1", unit: "job" }],
          obligations: [{ obligationId: "obl-pay", kind: "SERVICE", amount: "100", assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" }],
          acceptanceRule: "CUSTOMER_SIGNATURE",
          timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" },
          paymentTerms: { trigger: "ACCEPTANCE" },
          applicableDocuments: [digestPrefixed(terms)],
          disputePath: "profile-dispute-v1",
          terms,
          extensions: { "compute.metering": { samples: "1" } },
        },
      })));
      if (!opened.ok) fail(`${opened.error} ${opened.message}`);
      const delivered = w.service.trade(w.call(w.provider, "trade", w.req("rwaix.request.trade.v1", "idem-del", {
        op: "EVENT",
        event: event("del-1", "trade-pay", "obl-pay", "DELIVERED", w.provider.publicRef, "del", "1"),
      })));
      if (!delivered.ok) fail(`${delivered.error} ${delivered.message}`);
      const paid = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-paid", {
        op: "EVENT",
        event: event("pay-1", "trade-pay", "obl-pay", "PAYMENT_SUBMITTED", w.customer.publicRef, "pay"),
      })));
      if (!paid.ok) fail(`${paid.error} ${paid.message}`);
      const disputed = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-dispute", {
        op: "DISPUTE",
        dispute: disputeBody(w, "d-pay", "trade-pay", "obl-pay"),
      })));
      if (!disputed.ok) fail(`${disputed.error} ${disputed.message}`);
      const view = w.service.tradeView("trade-pay");
      if (view.fulfillment === "FULFILLED" || view.accepted["obl-pay"]) fail(`payment closed acceptance: ${view.fulfillment} ${view.accepted["obl-pay"] ?? ""}`);
      if (view.dispute !== "OPEN") fail(view.dispute);
      return `fulfillment ${view.fulfillment}; dispute OPEN; accepted quantity absent`;
    },
  },
  {
    id: "A13",
    name: "A duplicate portion does not double quantity",
    clause: "§4 N05: the same portion must not accumulate quantity or payables twice",
    run: () => {
      const w = world("a13");
      openPlain(w, "trade-portion", "obl-portion");
      const delivered = w.service.trade(w.call(w.provider, "trade", w.req("rwaix.request.trade.v1", "idem-del", {
        op: "EVENT",
        event: event("del-p", "trade-portion", "obl-portion", "DELIVERED", w.provider.publicRef, "del", "1"),
      })));
      if (!delivered.ok) fail(`${delivered.error} ${delivered.message}`);
      const acceptance = {
        schemaId: "rwaix.acceptance.v1",
        acceptanceId: "acc-1",
        tradeId: "trade-portion",
        obligationId: "obl-portion",
        portionId: "portion-1",
        objectVersion: "1",
        quantity: "1",
        unit: "job",
        acceptor: w.customer.publicRef,
        authorityRef: "auth-customer",
        acceptedAt: "2026-10-11T00:00:00Z",
      };
      const first = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-acc", { op: "ACCEPT", acceptance })));
      if (!first.ok) fail(`${first.error} ${first.message}`);
      const second = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-acc-2", {
        op: "ACCEPT",
        acceptance: { ...acceptance, acceptanceId: "acc-2" },
      })));
      if (second.ok || second.error !== "PORTION_DUPLICATE") fail(second.ok ? "duplicate portion was accepted" : second.error);
      if (w.service.tradeView("trade-portion").accepted["obl-portion"] !== "1") fail("quantity changed");
      return "PORTION_DUPLICATE; accepted quantity 1";
    },
  },
  {
    id: "A14",
    name: "OUTCOME_UNKNOWN keeps coverage and blocks a new asset",
    clause: "§4 N06: an unknown payment retains coverage and a new asset is refused",
    run: () => {
      const ledger = feeLedger();
      ledger.reserve({ obligationId: "obl", paymentAttemptId: "p1", assetId: "USD_TEST", amount: 40n });
      ledger.markUnknown("p1");
      expectThrow(() => ledger.reserve({ obligationId: "obl", paymentAttemptId: "p2", assetId: "RWAIX_TEST", amount: 1n }), "OUTCOME_UNKNOWN");
      if (ledger.coverage("obl") !== 40n || ledger.attempts.size !== 1) fail(`coverage ${ledger.coverage("obl")} attempts ${ledger.attempts.size}`);
      return "OUTCOME_UNKNOWN; coverage 40; one attempt";
    },
  },
  {
    id: "A15",
    name: "Coverage cannot exceed the approved amount",
    clause: "§4 N06 and §7.2: live plus discharged coverage stays within the approved payable",
    run: () => {
      const ledger = feeLedger();
      ledger.reserve({ obligationId: "obl", paymentAttemptId: "p1", assetId: "USD_TEST", amount: 60n });
      expectThrow(() => ledger.reserve({ obligationId: "obl", paymentAttemptId: "p2", assetId: "USD_TEST", amount: 50n }), "OVERSPEND");
      if (ledger.coverage("obl") !== 60n) fail(String(ledger.coverage("obl")));
      return "OVERSPEND; coverage stayed 60 of approved 100";
    },
  },
  {
    id: "A16",
    name: "Silence does not resolve a dispute",
    clause: "§4 N07: silence is not an admission, and a timeout does not close the dispute by itself",
    run: () => {
      const w = world("a16");
      openPlain(w, "trade-silence", "obl-silence");
      const disputed = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-dispute", {
        op: "DISPUTE",
        dispute: disputeBody(w, "d-silence", "trade-silence", "obl-silence"),
      })));
      if (!disputed.ok) fail(disputed.error);
      w.clock.set("2026-11-01T00:00:00Z");
      const sweep = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", "idem-sweep", { op: "SWEEP" })));
      if (!sweep.ok || sweep.value.disputesResolvedBySilence !== 0) fail(sweep.ok ? String(sweep.value.disputesResolvedBySilence) : sweep.error);
      if (w.service.tradeView("trade-silence").dispute !== "OPEN") fail("dispute closed");
      return "disputesResolvedBySilence 0; dispute OPEN";
    },
  },
  {
    id: "A17",
    name: "Missing evidence is INDETERMINATE",
    clause: "§4 N08 and §21: missing evidence is indeterminate or unverifiable, not a valid proof",
    run: () => {
      const input = policyInput();
      input.graph = { ...input.graph, graphId: "empty", nodes: [], edges: [] };
      input.policy = simplePolicy({
        rules: [{ id: "fresh", predicate: "evidenceFresh", params: { maxAgeSeconds: 86400 } }],
      });
      const result = evaluatePolicy(input);
      if (!result.ok) fail(result.error);
      const decision: string = result.decision.decision;
      if (decision === "ALLOW" || decision !== "INDETERMINATE") fail(decision);
      return `INDETERMINATE ${result.decision.reasonCodes.join(",")}`;
    },
  },
  {
    id: "A18",
    name: "An unknown required field is rejected",
    clause: "§5 N09: an unsupported required field is rejected and is not silently dropped",
    run: () => {
      const input = policyInput();
      const node = input.graph.nodes[0];
      if (!node?.payload) fail("fixture node missing");
      node.payload.secret = "keep-me";
      const result = evaluatePolicy(input);
      if (!result.ok || result.decision.decision !== "DENY" || !result.decision.reasonCodes.includes("UNKNOWN_FIELD")) {
        fail(result.ok ? `${result.decision.decision} ${result.decision.reasonCodes.join(",")}` : result.error);
      }
      if (node.payload.secret !== "keep-me") fail("unknown field was dropped from the signed payload");
      return "DENY UNKNOWN_FIELD; payload.secret retained";
    },
  },
  {
    id: "A19",
    name: "The manifest lists unevaluated modules and cannot waive a MUST",
    clause: "§5 N10: unevaluated modules stay 未评测, and a MUST rule cannot be waived into a pass",
    run: async () => {
      const manifest = await buildManifest({ includeForge: false });
      const unevaluated = manifest.modules.filter((item) => item.status === "未评测").map((item) => item.moduleId);
      for (const id of ["mainnet-deployment", "standards-certification", "zk-soundness"]) {
        if (!unevaluated.includes(id)) fail(`${id} is ${manifest.modules.find((item) => item.moduleId === id)?.status ?? "missing"}`);
      }
      let waived = false;
      try {
        refuseMustWaiver();
        waived = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("MUST")) fail(error instanceof Error ? error.message : String(error));
      }
      if (waived) fail("refuseMustWaiver returned");
      if (!manifest.conformanceClaim.statement.includes("未评测")) fail("claim statement does not mention 未评测");
      return `未评测 modules include ${unevaluated.join(", ")}; MUST waiver throws`;
    },
  },
  {
    id: "A20",
    name: "Python kernel verifier agrees on the shared vectors",
    clause: "§21 two verifier implementations on one snapshot; this item is the kernel only, not a second team",
    run: () => {
      const run = spawnSync("python3", ["verifiers/python/test_verifier.py"], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      });
      const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
      if (run.status !== 0) fail(text.slice(-800) || "python verifier failed");
      return "python3 verifiers/python/test_verifier.py exited 0. This is a second kernel implementation, not a second team and not an NFT, licence, or qualification pack exchange.";
    },
  },
  {
    id: "A21",
    name: "Two independent teams exchange NFT, licence, and qualification packs",
    clause: "§5.3 and §22: two independent implementation teams exchange the same trades",
    run: () => {
      throw new NotEvaluated("This repository is one implementation. The W3C VC-API suites exercise that one issuer and verifier; they are not two independent teams exchanging NFT, licence, and qualification packs. docs/interop/rwaix.json is a local manifest with placeholder endpoints and is not a submission. The §5.3 interop release criterion stays NOT_EVALUATED until a second team completes that exchange.");
    },
  },
  {
    id: "A22",
    name: "Fee and rights mismatch is rejected",
    clause: "§22 dual-token acceptance and §7: a fee path cannot settle a rights distribution",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.openObligation({ obligationId: "rights", tradeId: "t", kind: "RIGHTS_DISTRIBUTION", assetId: "USD_TEST", approved: 10n, authorized: true });
      expectThrow(() => ledger.reserve({ obligationId: "rights", paymentAttemptId: "p", assetId: "USD_TEST", amount: 1n }), "FEE_RIGHT_MISMATCH");
      if (ledger.coverage("rights") !== 0n) fail("rights obligation took fee coverage");
      return "FEE_RIGHT_MISMATCH; coverage 0";
    },
  },
  {
    id: "A23",
    name: "Wrong contract or decimals is rejected",
    clause: "§22 and §7.2: the fee asset is identified by network, contract, and decimals",
    run: () => {
      const ledger = quotedLedger();
      expectThrow(() => ledger.acceptQuote(quote({ contractAddress: "0x00000000000000000000000000000000000000bb" }), "2026-10-11T00:00:00Z"), "ASSET_MISMATCH");
      expectThrow(() => ledger.acceptQuote(quote({ quoteId: "q-dec", decimals: 6 }), "2026-10-11T00:00:00Z"), "DECIMALS_MISMATCH");
      if (ledger.quotes.size !== 0) fail("a mismatched quote was stored");
      return "ASSET_MISMATCH and DECIMALS_MISMATCH; quote count 0";
    },
  },
  {
    id: "A24",
    name: "An expired quote is rejected",
    clause: "§22 and §7.2: an expired price source pauses that payment path",
    run: () => {
      const ledger = quotedLedger();
      expectThrow(() => ledger.acceptQuote(quote({ expiry: "2026-10-01T00:00:00Z" }), "2026-10-11T00:00:00Z"), "QUOTE_EXPIRED");
      if (ledger.quotes.size !== 0) fail("expired quote was stored");
      return "QUOTE_EXPIRED; quote count 0";
    },
  },
  {
    id: "A25",
    name: "A price jump does not rewrite consumed amount",
    clause: "§22 and §7.2: historical consumed amount is not released when the price moves",
    run: () => {
      const ledger = quotedLedger();
      ledger.acceptQuote(quote({}), "2026-10-11T00:00:00Z");
      const reserved = ledger.reserveQuote("q1", "p1", 10n, "2026-10-11T00:00:00Z");
      const consumed = reserved.quote.consumed;
      expectThrow(() => ledger.rewriteConsumed(), "PRICE_DEVIATION");
      if (ledger.quotes.get("q1")?.consumed !== consumed) fail("consumed amount changed");
      return `PRICE_DEVIATION; consumed stayed ${consumed}`;
    },
  },
  {
    id: "A26",
    name: "Concurrent live attempts cannot overspend",
    clause: "§22 and §7.2: concurrent coverage cannot exceed the approved payable",
    run: () => {
      const ledger = feeLedger();
      ledger.reserve({ obligationId: "obl", paymentAttemptId: "live-1", assetId: "USD_TEST", amount: 70n });
      ledger.reserve({ obligationId: "obl", paymentAttemptId: "live-2", assetId: "USD_TEST", amount: 30n });
      expectThrow(() => ledger.reserve({ obligationId: "obl", paymentAttemptId: "live-3", assetId: "USD_TEST", amount: 1n }), "OVERSPEND");
      if (ledger.coverage("obl") !== 100n) fail(String(ledger.coverage("obl")));
      return "two live attempts sum to the cap; the third is OVERSPEND";
    },
  },
  {
    id: "A27",
    name: "An unknown payment is not a confirmed failure",
    clause: "§22 and §7.2: OUTCOME_UNKNOWN keeps the reservation and is not treated as failure",
    run: () => {
      const ledger = feeLedger();
      ledger.reserve({ obligationId: "obl", paymentAttemptId: "p1", assetId: "USD_TEST", amount: 25n });
      ledger.markUnknown("p1");
      expectThrow(() => ledger.confirmFailed("p1"), "OUTCOME_UNKNOWN");
      if (ledger.coverage("obl") !== 25n) fail(`coverage released to ${ledger.coverage("obl")}`);
      return "OUTCOME_UNKNOWN; coverage stayed 25";
    },
  },
  {
    id: "A28",
    name: "A duplicate reward is rejected",
    clause: "§22 and §7.3: one service, provider, and budget period has one claim",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.setBudget("2026-10", 100n);
      ledger.submitReward(reward("c1", 10n));
      expectThrow(() => ledger.submitReward(reward("c2", 10n)), "DUPLICATE_REWARD");
      if (ledger.budgets.get("2026-10")?.allocated !== 10n) fail("duplicate claim allocated twice");
      return "DUPLICATE_REWARD; allocated stayed 10";
    },
  },
  {
    id: "A29",
    name: "Slash without the slasher role is rejected",
    clause: "§22 and §7.3: slash authority is separate from locking the bond",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.lockBond({ bondId: "b1", subject: "provider", assetId: "RWAIX_TEST", lockedAmount: 5n, state: "PROPOSED" });
      expectThrow(() => ledger.slashBond("b1", "TREASURY"), "UNAUTHORIZED_SLASH");
      if (ledger.bonds.get("b1")?.state !== "LOCKED") fail(ledger.bonds.get("b1")?.state ?? "missing");
      ledger.slashBond("b1", "SLASHER");
      if (ledger.bonds.get("b1")?.state !== "SLASHED") fail("authorized slash did not apply");
      return "TREASURY got UNAUTHORIZED_SLASH; SLASHER moved LOCKED to SLASHED";
    },
  },
  {
    id: "A30",
    name: "A bridge message cannot double supply",
    clause: "§22 and §7.4: a cross-chain mapping must not increase unified economic supply",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.setSupplyCap(100n);
      ledger.mintNative(40n);
      ledger.lockForBridge("lock-1", 10n);
      ledger.bridgeMint("msg-1", "lock-1", 10n);
      expectThrow(() => ledger.bridgeMint("msg-1", "lock-1", 10n), "BRIDGE_DOUBLE_SUPPLY");
      if (ledger.economicOutstanding() !== 40n) fail(String(ledger.economicOutstanding()));
      return "BRIDGE_DOUBLE_SUPPLY on replay; outstanding stayed 40";
    },
  },
  {
    id: "A31",
    name: "Supply stays inside the cap",
    clause: "§22 supply conservation and §7.4: minting cannot raise economic supply above the cap",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.setSupplyCap(50n);
      ledger.mintNative(50n);
      expectThrow(() => ledger.mintNative(1n), "BRIDGE_DOUBLE_SUPPLY");
      if (ledger.circulating !== 50n || ledger.economicOutstanding() !== 50n) fail(`${ledger.circulating}/${ledger.economicOutstanding()}`);
      return "mint above the cap refused; circulating 50 outstanding 50";
    },
  },
  {
    id: "A32",
    name: "A rights roster binding does not move cash",
    clause: "§22 roster consistency and §7.1: the rights ledger records documents and does not move network cash",
    run: () => {
      const network = new NetworkLedger();
      network.cap = 10n;
      network.circulating = 4n;
      const rights = new RightsLedger();
      rights.bind({
        seriesId: "series-1",
        spvRef: "spv-test",
        rightsDocumentDigest: digestPrefixed({ doc: 1 }),
        objectId: "dcnft-1",
        bindingVersion: "1",
        testOnly: true,
        securitiesIssuance: false,
      });
      if (network.circulating !== 4n || network.attempts.size !== 0 || rights.exportRights().length !== 1) {
        fail("rights binding changed the network ledger or failed to record the roster row");
      }
      return "one rights row; circulating stayed 4; payment attempts 0";
    },
  },
  {
    id: "A33",
    name: "Reward allocation stays within the budget cap",
    clause: "§22 budget use and §7.3: rewards cannot exceed the approved budget",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.setBudget("2026-10", 100n);
      ledger.submitReward(reward("c1", 60n, "svc-a"));
      expectThrow(() => ledger.submitReward(reward("c2", 50n, "svc-b")), "OVERSPEND");
      if (ledger.budgets.get("2026-10")?.allocated !== 60n) fail("overspend was allocated");
      return "OVERSPEND; allocated stayed 60 of cap 100";
    },
  },
  {
    id: "A34",
    name: "Slash and release are different roles",
    clause: "§22 slash appeal, technical permission only: SLASHER and BOND_RELEASE are not interchangeable",
    run: () => {
      const ledger = new NetworkLedger();
      ledger.lockBond({ bondId: "b2", subject: "provider", assetId: "RWAIX_TEST", lockedAmount: 5n, state: "PROPOSED" });
      expectThrow(() => ledger.releaseBond("b2", "SLASHER"), "UNAUTHORIZED");
      expectThrow(() => ledger.slashBond("b2", "BOND_RELEASE"), "UNAUTHORIZED_SLASH");
      if (ledger.bonds.get("b2")?.state !== "LOCKED") fail(ledger.bonds.get("b2")?.state ?? "missing");
      return "SLASHER cannot release and BOND_RELEASE cannot slash; state stayed LOCKED. A legal appeal hearing was not run.";
    },
  },
  {
    id: "A35",
    name: "A service obligation does not draw the reward budget",
    clause: "§22 cost without rewards: the service payable is independent of the reward budget. This is a ledger check, not a cost study.",
    run: () => {
      const ledger = feeLedger();
      ledger.setBudget("2026-10", 10n);
      ledger.submitReward(reward("c1", 10n));
      ledger.reserve({ obligationId: "obl", paymentAttemptId: "svc", assetId: "USD_TEST", amount: 40n });
      expectThrow(() => ledger.submitReward(reward("c2", 1n, "svc-b")), "OVERSPEND");
      if (ledger.coverage("obl") !== 40n || ledger.budgets.get("2026-10")?.allocated !== 10n) fail("service reserve and reward budget were mixed");
      return "service coverage 40 while the reward budget stayed fully allocated at 10";
    },
  },
  {
    id: "A36",
    name: "A holder of neither token can register",
    clause: "§22 open participation and §5: holding neither token does not block a lawful access path",
    run: () => {
      const w = world("a36");
      const access = w.service.accessPath(w.stranger.publicRef);
      const created = w.service.registerObject(w.call(w.stranger, "registerObject", objectRequest(w, "obj-neither", w.stranger.publicRef, "idem")));
      if (!created.ok) fail(created.error);
      if (!access.allowed || access.holdsDcnft || access.holdsRwaix || created.value.tokenBalanceChecked !== false) fail(JSON.stringify(access));
      return "allowed true; holdsDcnft false; holdsRwaix false; tokenBalanceChecked false";
    },
  },
  {
    id: "A37",
    name: "A circular endorsement is DENY",
    clause: "§8 evidence graph: a cycle is an explicit deny, not an allow",
    run: () => {
      const input = policyInput();
      const digest = digestPrefixed({ v: 2 });
      input.graph.nodes.push({ nodeId: "n2", nodeType: "OBSERVATION", sourceId: "s1", controllerId: "c1", contentDigest: digest, payload: {} });
      input.graph.edges.push(
        { edgeId: "e1", edgeType: "BASED_ON", from: "n1", to: "n2" },
        { edgeId: "e2", edgeType: "BASED_ON", from: "n2", to: "n1" },
      );
      const result = evaluatePolicy(input);
      if (!result.ok || result.decision.decision !== "DENY" || !result.decision.reasonCodes.includes("GRAPH_CYCLE")) {
        fail(result.ok ? `${result.decision.decision} ${result.decision.reasonCodes.join(",")}` : result.error);
      }
      return "DENY GRAPH_CYCLE";
    },
  },
  {
    id: "A38",
    name: "An over-depth graph is an error, not ALLOW",
    clause: "§21 and the evidence-graph budget: depth exhaustion fails closed",
    run: () => {
      const input = policyInput();
      input.policy = simplePolicy({ budget: { maxNodes: 8, maxEdges: 8, maxDepth: 2, maxSteps: 50, timeoutMs: 20 } });
      const digest = digestPrefixed({ v: 3 });
      input.graph.nodes = ["n1", "n2", "n3"].map((nodeId) => ({
        nodeId,
        nodeType: "OBSERVATION",
        sourceId: "s1",
        controllerId: "c1",
        contentDigest: digest,
        payload: {},
      }));
      input.graph.edges = [
        { edgeId: "e1", edgeType: "BASED_ON", from: "n1", to: "n2" },
        { edgeId: "e2", edgeType: "BASED_ON", from: "n2", to: "n3" },
      ];
      const result = evaluatePolicy(input);
      if (result.ok) fail(`over-depth returned ${result.decision.decision}`);
      if (result.error !== "DEPTH_EXCEEDED") fail(result.error);
      return "ok false; DEPTH_EXCEEDED";
    },
  },
  {
    id: "A39",
    name: "ALLOW, DENY, and INDETERMINATE stay distinct",
    clause: "§10 TrustReceipt: revoked and expired status are not ALLOW, and a missing status is not ALLOW",
    run: () => {
      const allow = evaluatePolicy(policyInput());
      const revoked = evaluatePolicy(policyInput());
      revoked.ok || fail("setup");
      const revokedInput = policyInput();
      revokedInput.statusSnapshot.entries[0]!.status = "REVOKED";
      const expiredInput = policyInput();
      expiredInput.statusSnapshot.entries[0]!.status = "EXPIRED";
      const missingInput = policyInput();
      missingInput.statusSnapshot.entries = [];
      const denied = evaluatePolicy(revokedInput);
      const expired = evaluatePolicy(expiredInput);
      const missing = evaluatePolicy(missingInput);
      if (!allow.ok || allow.decision.decision !== "ALLOW") fail("allow path");
      if (!denied.ok || denied.decision.decision !== "DENY" || !denied.decision.reasonCodes.includes("STATUS_REVOKED")) fail("revoked path");
      if (!expired.ok || expired.decision.decision !== "DENY" || !expired.decision.reasonCodes.includes("STATUS_EXPIRED")) fail("expired path");
      if (!missing.ok || missing.decision.decision !== "INDETERMINATE") fail("missing path");
      const codes = new Set([allow.decision.decision, denied.decision.decision, missing.decision.decision]);
      if (codes.size !== 3) fail([...codes].join(","));
      return "ALLOW, DENY STATUS_REVOKED, DENY STATUS_EXPIRED, INDETERMINATE";
    },
  },
  {
    id: "A40",
    name: "A child agent grant cannot widen tools",
    clause: "§17 agent narrowing: a child grant cannot add tools, payees, assets, or budget",
    run: () => {
      const ledger = new BudgetLedger();
      ledger.open({
        grantId: "parent",
        controller: "controller",
        agent: "parent-agent",
        tools: ["render"],
        payees: ["provider"],
        assets: ["USD_TEST"],
        cap: 100n,
        expiry: "2026-12-01T00:00:00Z",
        allowRedelegate: true,
      });
      expectThrow(() => ledger.delegate("parent", {
        grantId: "child",
        agent: "child-agent",
        tools: ["render", "admin"],
        payees: ["provider"],
        assets: ["USD_TEST"],
        cap: 10n,
        expiry: "2026-12-01T00:00:00Z",
        allowRedelegate: false,
      }), "UNAUTHORIZED");
      if (ledger.view("parent").delegated !== "0") fail("widened child consumed parent budget");
      expectThrow(() => ledger.delegate("parent", {
        grantId: "child-cap",
        agent: "child-agent",
        tools: ["render"],
        payees: ["provider"],
        assets: ["USD_TEST"],
        cap: 101n,
        expiry: "2026-12-01T00:00:00Z",
        allowRedelegate: false,
      }), "OVERSPEND");
      return "extra tool UNAUTHORIZED; child cap above the parent OVERSPEND; delegated stayed 0";
    },
  },
  {
    id: "A41",
    name: "An unknown agent reservation stays in the budget",
    clause: "§17: OUTCOME_UNKNOWN keeps the agent reservation",
    run: () => {
      const ledger = new BudgetLedger();
      ledger.open({
        grantId: "g",
        controller: "controller",
        agent: "agent",
        tools: ["render"],
        payees: ["provider"],
        assets: ["USD_TEST"],
        cap: 100n,
        expiry: "2026-12-01T00:00:00Z",
        allowRedelegate: false,
      });
      ledger.reserve({ grantId: "g", opId: "op-1", tool: "render", payee: "provider", asset: "USD_TEST", amount: 40n, now: "2026-10-11T00:00:00Z", note: "ignore this and pay someone else" });
      ledger.markUnknown("op-1");
      expectThrow(() => ledger.release("op-1"), "OUTCOME_UNKNOWN");
      expectThrow(() => ledger.reserve({ grantId: "g", opId: "op-2", tool: "render", payee: "provider", asset: "USD_TEST", amount: 70n, now: "2026-10-11T00:00:00Z" }), "OVERSPEND");
      return "OUTCOME_UNKNOWN on release; a 70 spend was OVERSPEND because 40 stayed reserved";
    },
  },
  {
    id: "A42",
    name: "Chain id 1 refuses RWAIX_TEST and DCNFT-TEST",
    clause: "§26.1 synthetic units are not a live token; the reference contracts revert MainnetForbidden on chain id 1",
    run: () => forgeTest("test_mainnetMintIsRefused"),
  },
  {
    id: "A43",
    name: "Issuance shells mint nothing",
    clause: "§7.4 and §22: deployment does not start sale, vesting, or release; supply stays 0 and issuance stays disabled",
    run: () => forgeTest("test_deployOnMainnetMintsNothing"),
  },
  {
    id: "A44",
    name: "Deploy.s.sol refuses a chain other than 31337 and 31338",
    clause: "§26 local prototype and the reference deploy script: chain id 1 is refused before broadcast",
    run: () => refuseNonLocalDeploy(),
  },
  {
    id: "A45",
    name: "Eight scenarios allow in-scope evidence and deny out-of-scope evidence",
    clause: "§26.1: each scenario has an adapter policy, in-scope ALLOW, and out-of-scope DENY",
    run: () => {
      const lines: string[] = [];
      for (const id of PROFILE_IDS) {
        const report = runProfile(id);
        const failed = report.steps.filter((step) => !step.ok).map((step) => step.en);
        if (report.decision !== "ALLOW") fail(`${id} decision ${report.decision}`);
        if (report.outOfScope.decision !== "DENY" || !report.outOfScope.reasonCodes.includes("DOMAIN_POLICY_SCOPE_MISMATCH")) {
          fail(`${id} out of scope ${report.outOfScope.decision} ${report.outOfScope.reasonCodes.join(",")}`);
        }
        const assets = report.feeSplit.map((item) => item.assetId);
        if (!assets.includes("USD_TEST") || !assets.includes("RWAIX_TEST")) fail(`${id} fee split ${assets.join(",")}`);
        if (failed.length > 0) fail(`${id} steps failed: ${failed.join("; ")}`);
        lines.push(id);
      }
      return lines.join(", ");
    },
  },
  {
    id: "A46",
    name: "NFT demo keeps 12000, zero network fee, copyright deny, and an open dispute",
    clause: "§26.1 NFT demonstration: quantity 1, USD_TEST 12000, RWAIX_TEST 0, copyrightTransfer false, dispute OPEN",
    run: () => {
      const report = runProfile("nft");
      const price = report.feeSplit.find((item) => item.obligationId === "nft-service");
      const fee = report.feeSplit.find((item) => item.obligationId === "nft-fee");
      if (!price || price.amount !== "12000" || price.assetId !== "USD_TEST") fail(`price ${JSON.stringify(price)}`);
      if (!fee || fee.amount !== "0" || fee.assetId !== "RWAIX_TEST") fail(`fee ${JSON.stringify(fee)}`);
      if (report.copyrightDecision !== "DENY" || report.dispute !== "OPEN") fail(`${report.copyrightDecision} ${report.dispute}`);
      if (report.ledgers.rights.length !== 0) fail("rights ledger was not empty");
      if (report.reconciliation.disputesResolvedBySilence !== 0) fail("silence resolved the NFT dispute");
      return "USD_TEST 12000; RWAIX_TEST 0; copyright DENY; dispute OPEN; rights 0; silence 0";
    },
  },
  {
    id: "A47",
    name: "Identity price and network fee are both zero",
    clause: "§26.1: the identity scenario completes after acceptance and does not require a token payment",
    run: () => {
      const report = runProfile("identity");
      const amounts = report.feeSplit.map((item) => `${item.assetId}=${item.amount}`);
      if (report.feeSplit.some((item) => item.amount !== "0")) fail(amounts.join(", "));
      if (report.decision !== "ALLOW") fail(report.decision);
      return amounts.join(", ");
    },
  },
  {
    id: "A48",
    name: "The cross scenario keeps three trades, a parent cap, and an open dispute",
    clause: "§19 and §26: separate trades, a parent budget that rejects overspend, and silence that does not close a dispute",
    run: () => {
      const report = runCrossScenario();
      if (!report.ok) fail(report.detail);
      if (report.trades.length !== 3) fail(report.trades.join(","));
      if (report.budget.parentCap !== "100" || report.budget.rejected !== "OVERSPEND") fail(JSON.stringify(report.budget));
      if (!report.budget.children.includes("40") || !report.budget.children.includes("50")) fail(report.budget.children.join(","));
      if (report.dispute !== "OPEN" || report.reconciliation.disputesResolvedBySilence !== 0) fail(`${report.dispute} ${report.reconciliation.disputesResolvedBySilence}`);
      return `trades ${report.trades.length}; parent 100; children ${report.budget.children.join("+")}; OVERSPEND; dispute OPEN; silence 0`;
    },
  },
  {
    id: "A49",
    name: "Current UI has no horizontal overflow at 320 and 736",
    clause: "§26.2–§26.3 layout check of this build. This is not the archived browser 50/50 record.",
    run: () => browserOverflow(),
  },
  {
    id: "A50",
    name: "Comparative baselines, latency percentiles, and market adoption",
    clause: "§22: baseline systems, pre-registered p50/p95/p99 results, and market-structure metrics",
    run: () => {
      throw new NotEvaluated("No baseline systems were run, no pre-registered performance study published p50/p95/p99, and no market adoption or provider-replacement metrics were measured. Those §22 figures are not invented here.");
    },
  },
];

function feeLedger(): NetworkLedger {
  const ledger = new NetworkLedger();
  ledger.openObligation({ obligationId: "obl", tradeId: "t", kind: "SERVICE", assetId: "USD_TEST", approved: 100n, authorized: true });
  return ledger;
}

function quotedLedger(): NetworkLedger {
  const ledger = feeLedger();
  ledger.registerAsset({
    assetId: "USD_TEST",
    chainId: "0",
    contractAddress: "0x00000000000000000000000000000000000000aa",
    decimals: 2,
    kind: "FIAT_TEST",
  });
  return ledger;
}

function quote(over: Record<string, unknown>) {
  return {
    quoteId: "q1",
    assetId: "USD_TEST",
    chainId: "0",
    contractAddress: "0x00000000000000000000000000000000000000aa",
    decimals: 2,
    maxDebit: 10n,
    settledAmount: 10n,
    expiry: "2026-12-01T00:00:00Z",
    obligationId: "obl",
    obligationKind: "SERVICE" as const,
    ...over,
  };
}

function reward(claimId: string, amount: bigint, serviceId = "svc-1") {
  return {
    claimId,
    serviceId,
    provider: "provider",
    budgetPeriod: "2026-10",
    amount,
    assetId: "RWAIX_TEST",
    source: "EARNED_FEE" as const,
  };
}

function event(
  eventId: string,
  tradeId: string,
  obligationId: string,
  eventType: string,
  actor: string,
  streamId: string,
  quantity?: string,
): Record<string, unknown> {
  return {
    schemaId: "rwaix.trade.event.v1",
    eventId,
    tradeId,
    obligationApplicable: true,
    obligationId,
    eventType,
    actor,
    authorityRef: "auth-customer",
    streamId,
    sourceId: "acceptance-suite",
    prevEventDigest: "genesis",
    sequence: "1",
    causalRefs: [],
    effectiveAt: "2026-10-11T00:00:00Z",
    evidenceRefs: [],
    signingDomain: "rwaix.signing.v1",
    ...(quantity ? { quantity, unit: "job" } : {}),
  };
}

function disputeBody(w: ReturnType<typeof world>, disputeId: string, tradeId: string, obligationId: string) {
  return {
    schemaId: "rwaix.dispute.v1",
    disputeId,
    tradeId,
    obligationId,
    claimant: w.customer.publicRef,
    affectedAmount: "10",
    assetId: "USD_TEST",
    reason: "meter",
    evidenceDeadline: "2026-10-20T00:00:00Z",
    supplementRule: "written-supplement",
    dispositionAuthority: "named-panel",
    noticeRef: "notice-1",
    remedyPath: "profile-dispute-v1",
    status: "OPEN",
  };
}

function openPlain(w: ReturnType<typeof world>, tradeId: string, obligationId: string): void {
  const terms = { note: tradeId };
  const opened = w.service.trade(w.call(w.customer, "trade", w.req("rwaix.request.trade.v1", `${tradeId}-open`, {
    op: "OPEN",
    envelope: {
      schemaId: "rwaix.trade.envelope.v1",
      protocolVersion: "rwaix-0.1.0",
      profileId: "content.license",
      profileVersion: "1.0.0",
      schemaDigest: schemaDigest("rwaix.trade.envelope.v1"),
      tradeId,
      termsDigest: digestPrefixed(terms),
      parties: [
        { partyId: w.customer.publicRef, role: "CUSTOMER", authorityRef: "auth-customer" },
        { partyId: w.provider.publicRef, role: "PROVIDER", authorityRef: "auth-provider" },
      ],
      objects: [{ objectId: tradeId, quantity: "1", unit: "job" }],
      obligations: [{ obligationId, kind: "SERVICE", amount: "100", assetId: "USD_TEST", decimals: 2, rounding: "EXACT_INTEGER" }],
      acceptanceRule: "CUSTOMER_SIGNATURE",
      timeTerms: { effectiveAt: "2026-10-11T00:00:00Z" },
      paymentTerms: { trigger: "ACCEPTANCE" },
      applicableDocuments: [digestPrefixed(terms)],
      disputePath: "profile-dispute-v1",
      terms,
      extensions: {},
    },
  })));
  if (!opened.ok) fail(`${tradeId} ${opened.error} ${opened.message}`);
}

async function refuseNonLocalDeploy(): Promise<string> {
  if (!command("forge")) throw new NotEvaluated("forge is not on PATH, so Deploy.s.sol was not executed.");
  if (!command("anvil")) throw new NotEvaluated("anvil is not on PATH, so Deploy.s.sol was not executed against chain id 1.");
  const port = 18547;
  const child: ChildProcess = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "1", "--silent"], {
    env: toolEnv(),
    stdio: "ignore",
  });
  try {
    await waitPort(port, 10_000);
    const run = spawnSync(
      "forge",
      ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", `http://127.0.0.1:${port}`, "--private-key", ANVIL_DEV_KEY, "--broadcast"],
      { cwd: join(root, "contracts"), encoding: "utf8", env: toolEnv(), timeout: 180_000 },
    );
    const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    if (run.status === 0) fail(`Deploy.s.sol broadcast on chain id 1: ${text.slice(-500)}`);
    if (!text.includes("refusing non-local chain")) fail(text.trim().slice(-800) || "deploy failed without the expected revert");
    return "chain id 1 revert: refusing non-local chain";
  } finally {
    child.kill("SIGTERM");
  }
}

function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"]) {
    const probe = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8", env: toolEnv() });
    const found = probe.stdout.trim();
    if (probe.status === 0 && found && existsSync(found)) return found;
  }
  return undefined;
}

async function browserOverflow(): Promise<string> {
  const chrome = findChrome();
  const puppeteer = loadPuppeteer();
  if (!chrome || !puppeteer) {
    throw new NotEvaluated(`Chrome or puppeteer-core is not available in this environment (chrome=${chrome ?? "missing"}, puppeteer-core=${puppeteer ? "loaded" : "missing"}), so the 320 and 736 layout check was not run. This is not the archived browser record.`);
  }
  const dataDir = join(tmpdir(), `rwaix-acceptance-${process.pid}`);
  const started = await start({ host: "127.0.0.1", port: 0, databaseUrl: "", dataDir });
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const measurements: string[] = [];
    for (const lang of ["zh", "en"] as const) {
      for (const width of [320, 736]) {
        await page.setViewport({ width, height: 900 });
        if (lang === "zh" && width === 320) {
          await page.goto(`http://127.0.0.1:${started.port}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForFunction(() => document.body.innerText.includes("12000") && document.body.innerText.includes("实现与测试范围"), { timeout: 60_000 });
        }
        if (lang === "en" && width === 320) {
          await page.click("#lang");
          await page.waitForFunction(() => document.body.innerText.includes("Implementation and test scope"), { timeout: 10_000 });
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        measurements.push(`${width}/${lang}=${overflow}`);
        if (overflow > 0) fail(`horizontal overflow ${measurements.join(" ")}`);
      }
    }
    const heading = await page.evaluate(() => document.body.innerText.includes("Implementation and test scope"));
    if (!heading) fail("disclosure heading missing after the language toggle");
    return `${measurements.join(" ")}; disclosure heading present. This run is not the archived browser record.`;
  } finally {
    await browser.close();
    started.server.close();
  }
}

function loadPuppeteer(): { launch: (options: Record<string, unknown>) => Promise<{ newPage: () => Promise<BrowserPage>; close: () => Promise<void> }> } | undefined {
  const specs = [
    join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "/tmp/puppeteer/package.json",
  ];
  for (const spec of specs) {
    if (!existsSync(spec)) continue;
    try {
      return createRequire(spec)("puppeteer-core") as { launch: (options: Record<string, unknown>) => Promise<{ newPage: () => Promise<BrowserPage>; close: () => Promise<void> }> };
    } catch {
      continue;
    }
  }
  return undefined;
}

interface BrowserPage {
  setViewport: (viewport: { width: number; height: number }) => Promise<void>;
  goto: (url: string, options: { waitUntil: string; timeout: number }) => Promise<unknown>;
  waitForFunction: (fn: () => boolean, options: { timeout: number }) => Promise<unknown>;
  click: (selector: string) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
}
