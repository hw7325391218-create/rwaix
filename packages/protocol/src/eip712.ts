import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { ProtocolError } from "./errors.js";

export interface TypeField {
  name: string;
  type: string;
}

export type TypedSchema = Record<string, TypeField[]>;

const text = new TextEncoder();

function keccak(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

function pad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new ProtocolError("SCHEMA_INVALID", "EIP-712 value exceeds 32 bytes");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function hexBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  return hexToBytes(body.length % 2 === 0 ? body.toLowerCase() : `0${body.toLowerCase()}`);
}

function uint256(value: unknown): Uint8Array {
  const n = typeof value === "bigint" ? value : BigInt(value as string | number);
  if (n < 0n) throw new ProtocolError("SCHEMA_INVALID", "negative uint256");
  return pad32(hexBytes(n.toString(16)));
}

export function encodeType(primary: string, types: TypedSchema): string {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || !types[name]) return;
    seen.add(name);
    for (const field of types[name]) {
      const base = field.type.replace(/\[\]$/, "");
      if (types[base]) visit(base);
    }
  };
  visit(primary);
  seen.delete(primary);
  const one = (name: string) => `${name}(${types[name].map((field) => `${field.type} ${field.name}`).join(",")})`;
  return one(primary) + [...seen].sort().map(one).join("");
}

function encodeField(type: string, value: unknown, types: TypedSchema): Uint8Array {
  if (types[type]) return hashStruct(type, types, value as Record<string, unknown>);
  if (type === "string") {
    if (typeof value !== "string") throw new ProtocolError("SCHEMA_INVALID", "EIP-712 string");
    return keccak(text.encode(value));
  }
  if (type === "bytes32") {
    if (typeof value !== "string") throw new ProtocolError("SCHEMA_INVALID", "EIP-712 bytes32");
    return pad32(hexBytes(value));
  }
  if (type === "address") {
    if (typeof value !== "string") throw new ProtocolError("SCHEMA_INVALID", "EIP-712 address");
    return pad32(hexBytes(value));
  }
  if (type === "uint256") return uint256(value);
  if (type === "bool") return uint256(value === true ? 1 : 0);
  if (type === "bytes") {
    if (typeof value !== "string") throw new ProtocolError("SCHEMA_INVALID", "EIP-712 bytes");
    return keccak(hexBytes(value));
  }
  throw new ProtocolError("SCHEMA_INVALID", `unsupported EIP-712 type ${type}`);
}

export function hashStruct(primary: string, types: TypedSchema, data: Record<string, unknown>): Uint8Array {
  const parts: Uint8Array[] = [keccak(text.encode(encodeType(primary, types)))];
  for (const field of types[primary] ?? []) {
    parts.push(encodeField(field.type, data[field.name], types));
  }
  return keccak(concatBytes(...parts));
}

export const DOMAIN_TYPE: TypeField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export const ACTION_TYPE: TypeField[] = [
  { name: "protocolVersion", type: "string" },
  { name: "action", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "audience", type: "string" },
  { name: "nonce", type: "string" },
  { name: "deadline", type: "uint256" },
  { name: "payloadDigest", type: "bytes32" },
];

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: bigint | number | string;
  verifyingContract: string;
}

export function domainSeparator(domain: Eip712Domain): Uint8Array {
  return hashStruct("EIP712Domain", { EIP712Domain: DOMAIN_TYPE }, domain as unknown as Record<string, unknown>);
}

export function typedDataDigest(
  domain: Eip712Domain,
  primary: string,
  types: TypedSchema,
  message: Record<string, unknown>,
): Uint8Array {
  const withDomain: TypedSchema = { ...types, EIP712Domain: DOMAIN_TYPE };
  return keccak(
    concatBytes(
      text.encode("\x19\x01"),
      hashStruct("EIP712Domain", withDomain, domain as unknown as Record<string, unknown>),
      hashStruct(primary, withDomain, message),
    ),
  );
}

export function signTypedData(
  privateKey: Uint8Array,
  domain: Eip712Domain,
  primary: string,
  types: TypedSchema,
  message: Record<string, unknown>,
): string {
  const digest = typedDataDigest(domain, primary, types, message);
  const sig = secp256k1.sign(digest, privateKey);
  const compact = sig.toCompactRawBytes();
  const full = new Uint8Array(65);
  full.set(compact, 0);
  full[64] = sig.recovery + 27;
  return `0x${bytesToHex(full)}`;
}

export function verifyTypedData(
  signature: string,
  publicKey: Uint8Array,
  domain: Eip712Domain,
  primary: string,
  types: TypedSchema,
  message: Record<string, unknown>,
): boolean {
  const digest = typedDataDigest(domain, primary, types, message);
  const bytes = hexBytes(signature);
  if (bytes.length !== 65) return false;
  return secp256k1.verify(bytes.slice(0, 64), digest, publicKey);
}

export const RWAIX_ACTION_TYPES: TypedSchema = { Action: ACTION_TYPE };
