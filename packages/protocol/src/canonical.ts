import { ProtocolError } from "./errors.js";

function encodeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) || !Number.isSafeInteger(value)) {
      throw new ProtocolError("SCHEMA_INVALID", "canonicalization rejects non-safe integer numbers; amounts must be strings");
    }
    return String(value);
  }
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      const child = record[key];
      if (child === undefined) {
        throw new ProtocolError("SCHEMA_INVALID", `undefined field ${key} is not canonical JSON`);
      }
      parts.push(`${encodeString(key)}:${encode(child)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new ProtocolError("SCHEMA_INVALID", `unsupported canonical type ${typeof value}`);
}

/** RFC 8785 subset: sorted object keys, no whitespace, safe integers only. */
export function canonicalStringify(value: unknown): string {
  return encode(value);
}
