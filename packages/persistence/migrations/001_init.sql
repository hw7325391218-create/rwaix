CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  collection text NOT NULL,
  doc_id text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (collection, doc_id)
);

CREATE TABLE IF NOT EXISTS journal (
  seq bigserial PRIMARY KEY,
  recorded_at text NOT NULL,
  action text NOT NULL,
  doc_id text NOT NULL,
  body jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_blocks (
  chain_id text NOT NULL,
  height bigint NOT NULL,
  block_hash text NOT NULL,
  parent_hash text NOT NULL,
  canonical boolean NOT NULL,
  PRIMARY KEY (chain_id, height, block_hash)
);

CREATE TABLE IF NOT EXISTS chain_ops (
  chain_id text NOT NULL,
  op_id text NOT NULL,
  state text NOT NULL,
  height bigint,
  block_hash text,
  PRIMARY KEY (chain_id, op_id)
);

INSERT INTO schema_migrations (id) VALUES ('001_init') ON CONFLICT (id) DO NOTHING;
