import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { canonicalStringify } from "./canonical.js";
import { ProtocolError } from "./errors.js";
import { sha256Hex } from "./hash.js";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "../../schemas/v1");

interface SchemaIndex {
  schemas: Record<string, string>;
}

const index = JSON.parse(readFileSync(join(schemaDir, "schema-index.json"), "utf8")) as SchemaIndex;
const ajv = new Ajv({ allErrors: true, strict: false });

for (const name of readdirSync(schemaDir)) {
  if (!name.endsWith(".schema.json")) continue;
  const schema = JSON.parse(readFileSync(join(schemaDir, name), "utf8")) as { $id?: string };
  ajv.addSchema(schema);
}

const validators = new Map<string, ValidateFunction>();
const digests = new Map<string, string>();

for (const [schemaId, file] of Object.entries(index.schemas)) {
  const raw = JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as { $id: string };
  const validate = ajv.getSchema(raw.$id);
  if (!validate) throw new Error(`schema failed to compile: ${schemaId}`);
  validators.set(schemaId, validate);
  digests.set(schemaId, `sha256:${sha256Hex(canonicalStringify(raw))}`);
}

function fail(errors: ErrorObject[] | null | undefined): ProtocolError {
  const list = errors ?? [];
  const unknown = list.some((error) => error.keyword === "additionalProperties");
  const detail = list
    .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
    .join("; ");
  return new ProtocolError(unknown ? "UNKNOWN_FIELD" : "SCHEMA_INVALID", detail || "schema validation failed");
}

export function validateBySchemaId(schemaId: string, data: unknown): void {
  const validate = validators.get(schemaId);
  if (!validate) throw new ProtocolError("SCHEMA_INVALID", `unknown schema ${schemaId}`);
  if (!validate(data)) throw fail(validate.errors);
}

export function schemaDigest(schemaId: string): string {
  const digest = digests.get(schemaId);
  if (!digest) throw new ProtocolError("SCHEMA_INVALID", `unknown schema ${schemaId}`);
  return digest;
}

export function listSchemaIds(): string[] {
  return Object.keys(index.schemas);
}
