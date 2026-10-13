import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "@rwaix/adapter-profiles";
import { disclosureDigest, disclosureFor, issueSelectiveDisclosure } from "@rwaix/disclosure";
import { evaluatePolicy } from "@rwaix/policy-engine";
import { canonicalStringify, digestPrefixed, keyFromSeed } from "@rwaix/protocol";
import { emptyBitstring, setBit } from "@rwaix/status-list";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const issuer = keyFromSeed("vector-issuer");
const adapter = adapterFor("content", issuer.publicRef);
const policy = adapter.buildPolicy();
const terms = { workVersion: "work-v3", territory: "CN", sublicense: "no" };
const context = {
  schemaId: "rwaix.context.v1" as const,
  audience: "rwaix:licensee",
  purpose: "content.license.verify",
  objectRef: { objectId: "license", bindingVersion: "1" },
  requestedAction: "content.use",
  domain: "content",
  subjectRef: "license",
  challengeNonce: "nonce-0001",
  deadline: "2026-12-01T00:00:00Z",
  policyVersion: "1.0.0",
};
type GraphNode = {
  nodeId: string;
  nodeType: string;
  sourceId: string;
  controllerId: string;
  contentDigest: string;
  capturedAt: string;
  issuer?: string;
  payload?: Record<string, string>;
};
const baseGraph: {
  schemaId: "rwaix.evidence.graph.v1";
  graphId: string;
  nodes: GraphNode[];
  edges: { edgeId: string; edgeType: string; from: string; to: string }[];
} = {
  schemaId: "rwaix.evidence.graph.v1",
  graphId: "g-license",
  nodes: [
    { nodeId: "cred", nodeType: "CREDENTIAL", sourceId: "issuer", controllerId: issuer.publicRef, contentDigest: digestPrefixed({ v: 1 }), issuer: issuer.publicRef, capturedAt: "2026-10-11T00:00:00Z" },
    { nodeId: "obs", nodeType: "OBSERVATION", sourceId: "src", controllerId: issuer.publicRef, contentDigest: digestPrefixed({ v: 1 }), capturedAt: "2026-10-11T00:00:00Z", payload: terms },
  ],
  edges: [{ edgeId: "e1", edgeType: "BASED_ON", from: "obs", to: "cred" }],
};
const snapshot = { schemaId: "rwaix.status.snapshot.v1" as const, snapshotId: "snap", asOf: "2026-10-11T00:00:00Z", entries: [{ subjectRef: "license", status: "ACTIVE" }] };

function pack(id: string, graph: typeof baseGraph, termSet: Record<string, string>, policySet = policy, contextSet = context) {
  const input = { context: contextSet, policy: policySet, graph, statusSnapshot: snapshot, terms: termSet, evaluationTime: "2026-10-11T00:00:00Z", startedAtMs: 0, nowMs: 1 };
  const decision = evaluatePolicy(input);
  if (!decision.ok) throw new Error(decision.error);
  return { id, input, expect: { decision: decision.decision.decision, reasonCodes: decision.decision.reasonCodes, predicateResults: decision.decision.predicateResults } };
}

const mismatch = structuredClone(baseGraph);
mismatch.graphId = "g-bad";
mismatch.nodes[1] = { ...mismatch.nodes[1], payload: { ...terms, sublicense: "yes" } };
const empty = structuredClone(baseGraph);
empty.graphId = "g-empty";
empty.nodes = [];
empty.edges = [];
const nftAdapter = adapterFor("nft", issuer.publicRef);
const nftPolicy = nftAdapter.buildPolicy();
const nftTerms = {
  network: "31337",
  contract: "0x00000000000000000000000000000000000000aa",
  tokenId: "1",
  workDigest: digestPrefixed({ work: "vector-nft" }),
  licenceVersion: "licence-v1",
  licenceScope: "display-private",
  sellerControl: "seller-holds",
  recipient: "buyer-wallet",
  copyrightTransfer: "false",
};
const nftContext = {
  schemaId: "rwaix.context.v1" as const,
  audience: "rwaix:nft-buyer",
  purpose: "nft.trade.verify",
  objectRef: { objectId: "nft-work", bindingVersion: "1" },
  requestedAction: "nft.accept",
  domain: "nft",
  subjectRef: "license",
  challengeNonce: "nonce-0001",
  deadline: "2026-12-01T00:00:00Z",
  policyVersion: "1.0.0",
};
const nftGraph = structuredClone(baseGraph);
nftGraph.graphId = "g-nft";
nftGraph.nodes[1] = { ...nftGraph.nodes[1], payload: nftTerms };
const nftCopyright = structuredClone(nftGraph);
nftCopyright.graphId = "g-nft-copyright";
nftCopyright.nodes[1] = { ...nftCopyright.nodes[1], payload: { ...nftTerms, copyrightTransfer: "true" } };
const values = [{ b: 1, a: 2 }, { amount: "10", asset: "USD_TEST" }, ["b", "a"]];
const issued = issueSelectiveDisclosure(issuer, { shown: "yes", hidden: "secret" }, { shown: "salt-shown-00000001", hidden: "salt-hidden-0000001" });
const disclosure = disclosureFor("salt-shown-00000001", "shown", "yes");
const bits = emptyBitstring();
setBit(bits, 94567, true);
const out = {
  canonical: values.map((value) => ({ value, canonical: canonicalStringify(value), digest: digestPrefixed(value) })),
  policies: [
    pack("allow", baseGraph, terms),
    pack("scope", mismatch, terms),
    pack("empty", empty, terms),
    pack("nft-allow", nftGraph, nftTerms, nftPolicy, nftContext),
    pack("nft-copyright", nftCopyright, nftTerms, nftPolicy, nftContext),
  ],
  sdJwt: { disclosure, digest: disclosureDigest(disclosure), issuerJws: issued.issuerJws, publicKeyHex: Buffer.from(issuer.publicKey).toString("hex") },
  status: { gzipHex: gzipSync(bits).toString("hex"), index: 94567, bit: 1 },
};
const file = join(root, "verifiers/vectors/kernel.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);
