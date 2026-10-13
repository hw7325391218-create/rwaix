import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualClock, digestPrefixed, keyFromSeed, signRequest } from "@rwaix/protocol";
import { ReferenceService } from "@rwaix/sdk";
import { journalLength, loadDocument, openPglite, saveDocument } from "../src/index.js";

test("postgres snapshot survives a new process directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rwaix-pg-"));
  const clock = new ManualClock("2026-10-11T00:00:00Z");
  const verifier = keyFromSeed("persist-verifier");
  const owner = keyFromSeed("persist-owner");
  const first = new ReferenceService({ clock, verifier });
  const created = first.registerObject(signRequest(owner, "registerObject", {
    schemaId: "rwaix.request.registerObject.v1",
    protocolVersion: "rwaix-0.1.0",
    idempotencyKey: "persist-1",
    objectId: "obj-persist",
    objectType: "SUBJECT",
    controller: owner.publicRef,
    lifecyclePolicy: "NON_TRANSFERABLE",
    metadataDigest: digestPrefixed({ persist: true }),
  }, { nonce: "persist-nonce-01", deadline: "2027-01-01T00:00:00Z" }));
  assert.equal(created.ok, true);
  const published = first.publishVersion(signRequest(owner, "publishVersion", {
    schemaId: "rwaix.request.publishVersion.v1",
    protocolVersion: "rwaix-0.1.0",
    idempotencyKey: "persist-v1",
    objectId: "obj-persist",
    bindingVersion: "1",
    contentDigest: digestPrefixed({ persist: true }),
    metadataDigest: digestPrefixed({ persist: true }),
  }, { nonce: "persist-nonce-v1", deadline: "2027-01-01T00:00:00Z" }));
  assert.equal(published.ok, true);
  const sql = await openPglite(dir);
  await saveDocument(sql, "service", "kernel", first.toJSON(), clock.now(), "snapshot");
  assert.equal(await journalLength(sql), 1);
  await sql.close();
  const again = await openPglite(dir);
  const body = await loadDocument<ReturnType<ReferenceService["toJSON"]>>(again, "service", "kernel");
  const second = new ReferenceService({ clock, verifier });
  second.loadJSON(body as Parameters<ReferenceService["loadJSON"]>[0]);
  const resolved = second.resolveBinding(signRequest(owner, "resolveBinding", {
    schemaId: "rwaix.request.resolveBinding.v1",
    protocolVersion: "rwaix-0.1.0",
    idempotencyKey: "persist-2",
    objectId: "obj-persist",
    bindingVersion: "1",
  }, { nonce: "persist-nonce-02", deadline: "2027-01-01T00:00:00Z" }));
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.value.objectId, "obj-persist");
  await again.close();
  await rm(dir, { recursive: true, force: true });
});
