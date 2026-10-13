import { gunzipSync, gzipSync } from "node:zlib";
import { ProtocolError, signJws, verifyJws, type P256Key } from "@rwaix/protocol";

/** W3C Bitstring Status List minimum length: 16KB, for herd privacy. */
export const STATUS_LIST_BYTES = 16384;
export const STATUS_LIST_BITS = STATUS_LIST_BYTES * 8;

export type StatusPurpose = "revocation" | "suspension";

export interface StatusListCredential {
  schemaId: "rwaix.status-list.v1";
  "@context": string[];
  type: string[];
  id: string;
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: {
    id: string;
    type: "BitstringStatusList";
    statusPurpose: StatusPurpose;
    encodedList: string;
  };
}

/** Index 0 is the left-most bit of the first byte (W3C bitstring encoding). */
export function setBit(bytes: Uint8Array, index: number, on: boolean): void {
  if (index < 0 || index >= bytes.length * 8) throw new ProtocolError("SCHEMA_INVALID", "status index out of range");
  const byteIndex = Math.floor(index / 8);
  const mask = 1 << (7 - (index % 8));
  const current = bytes[byteIndex] ?? 0;
  bytes[byteIndex] = on ? current | mask : current & ~mask;
}

export function getBit(bytes: Uint8Array, index: number): number {
  if (index < 0 || index >= bytes.length * 8) throw new ProtocolError("SCHEMA_INVALID", "status index out of range");
  const byteIndex = Math.floor(index / 8);
  const mask = 1 << (7 - (index % 8));
  return ((bytes[byteIndex] ?? 0) & mask) === 0 ? 0 : 1;
}

export function emptyBitstring(): Uint8Array {
  return new Uint8Array(STATUS_LIST_BYTES);
}

export function encodeBitstring(bytes: Uint8Array): string {
  if (bytes.length * 8 < STATUS_LIST_BITS) throw new ProtocolError("SCHEMA_INVALID", "bitstring shorter than 16KB");
  return `u${gzipSync(bytes).toString("base64url")}`;
}

export function decodeBitstring(encoded: string): Uint8Array {
  if (!encoded.startsWith("u")) throw new ProtocolError("SCHEMA_INVALID", "encodedList must be multibase base64url");
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(encoded.slice(1), "base64url"));
  } catch {
    throw new ProtocolError("SCHEMA_INVALID", "encodedList is not gzip");
  }
  if (raw.length * 8 < STATUS_LIST_BITS) throw new ProtocolError("SCHEMA_INVALID", "decoded bitstring shorter than 16KB");
  return new Uint8Array(raw);
}

/**
 * Revocation bits are irreversible. Suspension bits can be cleared.
 * Returns the encoded list after the change.
 */
export function writeStatus(encoded: string, index: number, purpose: StatusPurpose, on: boolean): string {
  const bytes = decodeBitstring(encoded);
  const current = getBit(bytes, index);
  if (purpose === "revocation" && current === 1 && !on) {
    throw new ProtocolError("LIFECYCLE_TERMINAL", "revocation bit cannot be cleared");
  }
  setBit(bytes, index, on);
  return encodeBitstring(bytes);
}

export function issueStatusList(
  key: P256Key,
  input: { id: string; statusPurpose: StatusPurpose; encodedList: string; validFrom: string; validUntil: string },
): { credential: StatusListCredential; proof: string } {
  decodeBitstring(input.encodedList);
  const credential: StatusListCredential = {
    schemaId: "rwaix.status-list.v1",
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://www.w3.org/ns/credentials/status/v1"],
    type: ["VerifiableCredential", "BitstringStatusListCredential"],
    id: input.id,
    issuer: key.publicRef,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    credentialSubject: {
      id: `${input.id}#list`,
      type: "BitstringStatusList",
      statusPurpose: input.statusPurpose,
      encodedList: input.encodedList,
    },
  };
  return { credential, proof: signJws(key, credential) };
}

export function verifyStatusList(input: {
  credential: StatusListCredential;
  proof: string;
  index: number;
  purpose: StatusPurpose;
  atTime: string;
  trustedIssuers: string[];
}): { bit: number; status: "ACTIVE" | "REVOKED" | "SUSPENDED" } {
  let signer = "";
  try {
    signer = verifyJws(input.proof, input.credential);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("SIGNATURE_INVALID", "status list signature");
  }
  if (signer !== input.credential.issuer) throw new ProtocolError("SIGNATURE_INVALID", "status list issuer key");
  if (!input.trustedIssuers.includes(input.credential.issuer)) throw new ProtocolError("UNAUTHORIZED", "status list issuer is not trusted");
  if (!input.credential.type.includes("BitstringStatusListCredential")) throw new ProtocolError("SCHEMA_INVALID", "status list type");
  if (input.credential.credentialSubject.type !== "BitstringStatusList") throw new ProtocolError("SCHEMA_INVALID", "status list subject");
  if (input.credential.credentialSubject.statusPurpose !== input.purpose) {
    throw new ProtocolError("SCHEMA_INVALID", "status purpose does not match the list");
  }
  if (input.atTime < input.credential.validFrom || input.atTime > input.credential.validUntil) {
    throw new ProtocolError("EXPIRED", "status list is outside its validity window");
  }
  const bytes = decodeBitstring(input.credential.credentialSubject.encodedList);
  const bit = getBit(bytes, input.index);
  if (bit === 0) return { bit, status: "ACTIVE" };
  return { bit, status: input.purpose === "revocation" ? "REVOKED" : "SUSPENDED" };
}
