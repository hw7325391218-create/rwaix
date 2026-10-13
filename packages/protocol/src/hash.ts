import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalStringify } from "./canonical.js";

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256(bytes));
}

export function digestPrefixed(value: unknown): string {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

export function digestBytes32(value: unknown): `0x${string}` {
  return `0x${sha256Hex(canonicalStringify(value))}`;
}
