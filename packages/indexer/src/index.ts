import type { Sql } from "@rwaix/persistence";

export type ChainState = "COMMITTED" | "INCLUDED" | "FINAL" | "REORGED";

export interface ChainBlock {
  number: number;
  hash: string;
  parentHash: string;
}

export interface ChainRpc {
  latest(): Promise<ChainBlock | null>;
  block(number: number): Promise<ChainBlock | null>;
}

export class FakeChain implements ChainRpc {
  private blocks: ChainBlock[] = [];

  push(hash: string, parentHash?: string): ChainBlock {
    const parent = this.blocks[this.blocks.length - 1];
    const block = { number: this.blocks.length + 1, hash, parentHash: parentHash ?? parent?.hash ?? "genesis" };
    this.blocks.push(block);
    return block;
  }

  /** Replace the suffix starting at `height` (1-based) with a new canonical fork. */
  reorg(height: number, hashes: string[]): void {
    const parent = height <= 1 ? "genesis" : this.blocks[height - 2]?.hash ?? "genesis";
    this.blocks = this.blocks.slice(0, height - 1);
    let previous = parent;
    for (const hash of hashes) {
      this.blocks.push({ number: this.blocks.length + 1, hash, parentHash: previous });
      previous = hash;
    }
  }

  async latest(): Promise<ChainBlock | null> {
    return this.blocks[this.blocks.length - 1] ?? null;
  }

  async block(number: number): Promise<ChainBlock | null> {
    return this.blocks.find((item) => item.number === number) ?? null;
  }
}

/**
 * Follows one chain. An operation is COMMITTED before inclusion, INCLUDED when
 * a block hash is known, FINAL after `finalityDepth` confirmations, and
 * REORGED when that block hash leaves the canonical chain. The block hash is
 * the snapshot. A reorg does not delete the old hash row.
 */
export class ChainIndexer {
  constructor(
    private readonly sql: Sql,
    private readonly rpc: ChainRpc,
    private readonly chainId: string,
    private readonly finalityDepth: number,
  ) {}

  async submit(opId: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO chain_ops (chain_id, op_id, state) VALUES ($1, $2, 'COMMITTED')
       ON CONFLICT (chain_id, op_id) DO NOTHING`,
      [this.chainId, opId],
    );
  }

  async include(opId: string, height: number): Promise<void> {
    const block = await this.rpc.block(height);
    if (!block) throw new Error(`no block at ${height}`);
    await this.sql.query(
      `INSERT INTO chain_ops (chain_id, op_id, state, height, block_hash) VALUES ($1, $2, 'INCLUDED', $3, $4)
       ON CONFLICT (chain_id, op_id) DO UPDATE SET state = 'INCLUDED', height = EXCLUDED.height, block_hash = EXCLUDED.block_hash`,
      [this.chainId, opId, height, block.hash],
    );
  }

  async poll(): Promise<void> {
    const latest = await this.rpc.latest();
    if (!latest) return;
    for (let height = 1; height <= latest.number; height += 1) {
      const block = await this.rpc.block(height);
      if (!block) continue;
      const rows = await this.sql.query<{ block_hash: string; canonical: boolean }>(
        "SELECT block_hash, canonical FROM chain_blocks WHERE chain_id = $1 AND height = $2 AND canonical = true",
        [this.chainId, height],
      );
      const canonical = rows[0];
      if (canonical && canonical.block_hash !== block.hash) {
        await this.sql.query(
          "UPDATE chain_blocks SET canonical = false WHERE chain_id = $1 AND height = $2 AND block_hash = $3",
          [this.chainId, height, canonical.block_hash],
        );
        await this.sql.query(
          `UPDATE chain_ops SET state = 'REORGED' WHERE chain_id = $1 AND block_hash = $2 AND state IN ('INCLUDED', 'FINAL')`,
          [this.chainId, canonical.block_hash],
        );
      }
      await this.sql.query(
        `INSERT INTO chain_blocks (chain_id, height, block_hash, parent_hash, canonical) VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (chain_id, height, block_hash) DO UPDATE SET canonical = true`,
        [this.chainId, height, block.hash, block.parentHash],
      );
    }
    const included = await this.sql.query<{ op_id: string; height: string }>(
      "SELECT op_id, height::text AS height FROM chain_ops WHERE chain_id = $1 AND state = 'INCLUDED'",
      [this.chainId],
    );
    for (const op of included) {
      if (latest.number - Number(op.height) + 1 >= this.finalityDepth) {
        await this.sql.query("UPDATE chain_ops SET state = 'FINAL' WHERE chain_id = $1 AND op_id = $2", [this.chainId, op.op_id]);
      }
    }
  }

  async state(opId: string): Promise<ChainState | undefined> {
    const rows = await this.sql.query<{ state: ChainState }>("SELECT state FROM chain_ops WHERE chain_id = $1 AND op_id = $2", [this.chainId, opId]);
    return rows[0]?.state;
  }

  async blockSnapshot(height: number): Promise<Array<{ block_hash: string; canonical: boolean }>> {
    return this.sql.query("SELECT block_hash, canonical FROM chain_blocks WHERE chain_id = $1 AND height = $2 ORDER BY block_hash", [this.chainId, height]);
  }
}

function asBlock(value: unknown): ChainBlock | null {
  if (!value || typeof value !== "object") return null;
  const block = value as { number?: string; hash?: string; parentHash?: string };
  if (!block.number || !block.hash || !block.parentHash) return null;
  return { number: Number.parseInt(block.number, 16), hash: block.hash, parentHash: block.parentHash };
}

/** JSON-RPC chain follower. The URL comes from the operator's environment. */
export class JsonRpcChain implements ChainRpc {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? method);
    return body.result ?? null;
  }

  async latest(): Promise<ChainBlock | null> {
    return asBlock(await this.rpc("eth_getBlockByNumber", ["latest", false]));
  }

  async block(number: number): Promise<ChainBlock | null> {
    return asBlock(await this.rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]));
  }

  async chainId(): Promise<number> {
    const value = await this.rpc("eth_chainId", []);
    if (typeof value !== "string") throw new Error("eth_chainId");
    return Number.parseInt(value, 16);
  }

  async getCode(address: string): Promise<string> {
    const value = await this.rpc("eth_getCode", [address, "latest"]);
    return typeof value === "string" ? value : "0x";
  }

  async call(to: string, data: string): Promise<string> {
    const value = await this.rpc("eth_call", [{ to, data }, "latest"]);
    if (typeof value !== "string") throw new Error("eth_call");
    return value;
  }
}
