import assert from "node:assert/strict";
import { test } from "node:test";
import { openPglite } from "@rwaix/persistence";
import { ChainIndexer, FakeChain, JsonRpcChain } from "../src/index.js";

test("indexer records block hashes and moves included ops through finality and reorg", async () => {
  const sql = await openPglite();
  const chain = new FakeChain();
  const indexer = new ChainIndexer(sql, chain, "31337", 2);
  chain.push("0xaaa");
  await indexer.submit("op-1");
  assert.equal(await indexer.state("op-1"), "COMMITTED");
  await indexer.include("op-1", 1);
  await indexer.poll();
  assert.equal(await indexer.state("op-1"), "INCLUDED");
  chain.push("0xbbb");
  await indexer.poll();
  assert.equal(await indexer.state("op-1"), "FINAL");
  chain.push("0xccc");
  chain.reorg(1, ["0xddd", "0xeee", "0xfff"]);
  await indexer.poll();
  assert.equal(await indexer.state("op-1"), "REORGED");
  const snapshot = await indexer.blockSnapshot(1);
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot.find((item) => item.block_hash === "0xaaa")?.canonical, false);
  assert.equal(snapshot.find((item) => item.block_hash === "0xddd")?.canonical, true);
  await sql.close();
});

test("json-rpc chain reads a local block payload", async () => {
  const chain = new JsonRpcChain("http://127.0.0.1:9", async () => Response.json({
    result: { number: "0x2", hash: "0xbbb", parentHash: "0xaaa" },
  }));
  const latest = await chain.latest();
  assert.equal(latest?.number, 2);
  assert.equal(latest?.hash, "0xbbb");
});
