import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Sql {
  exec(text: string): Promise<void>;
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../migrations/001_init.sql"), "utf8");

export async function migrate(sql: Sql): Promise<void> {
  const statements = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await sql.exec(statement);
}

export function wrapPglite(db: PGlite): Sql {
  return {
    async exec(text: string) {
      await db.exec(text);
    },
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await db.query<T>(text, params);
      return result.rows;
    },
    async close() {
      await db.close();
    },
  };
}

export async function openPglite(dataDir?: string): Promise<Sql> {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  const sql = wrapPglite(db);
  await migrate(sql);
  return sql;
}

export async function openPostgres(connectionString: string): Promise<Sql> {
  const pool = new pg.Pool({ connectionString });
  const sql: Sql = {
    async exec(text: string) {
      await pool.query(text);
    },
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await pool.query(text, params);
      return result.rows as T[];
    },
    async close() {
      await pool.end();
    },
  };
  await migrate(sql);
  return sql;
}

export async function openDatabase(options?: { databaseUrl?: string; dataDir?: string }): Promise<Sql> {
  if (options?.databaseUrl) return openPostgres(options.databaseUrl);
  return openPglite(options?.dataDir);
}

export async function saveDocument(sql: Sql, collection: string, docId: string, body: unknown, recordedAt: string, action: string): Promise<void> {
  await sql.query(
    `INSERT INTO documents (collection, doc_id, body) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (collection, doc_id) DO UPDATE SET body = EXCLUDED.body`,
    [collection, docId, JSON.stringify(body)],
  );
  await sql.query(
    `INSERT INTO journal (recorded_at, action, doc_id, body) VALUES ($1, $2, $3, $4::jsonb)`,
    [recordedAt, action, docId, JSON.stringify(body)],
  );
}

export async function loadDocument<T>(sql: Sql, collection: string, docId: string): Promise<T | undefined> {
  const rows = await sql.query<{ body: T }>("SELECT body FROM documents WHERE collection = $1 AND doc_id = $2", [collection, docId]);
  return rows[0]?.body;
}

export async function journalLength(sql: Sql): Promise<number> {
  const rows = await sql.query<{ count: string }>("SELECT count(*)::text AS count FROM journal");
  return Number(rows[0]?.count ?? 0);
}
