import { ProtocolError, type P256Key } from "@rwaix/protocol";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] ?? 0) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i] ?? 0];
  return out;
}

export function base58btcDecode(text: string): Uint8Array {
  const bytes = [0];
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new ProtocolError("SCHEMA_INVALID", "base58 character");
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const body = bytes.reverse();
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

/** did:key for a 32-byte Ed25519 public key (multicodec ed25519-pub, 0xed01). */
export function didKeyEd25519(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new ProtocolError("SCHEMA_INVALID", "did:key expects a 32-byte Ed25519 key");
  const prefixed = new Uint8Array(2 + publicKey.length);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);
  return `did:key:z${base58btc(prefixed)}`;
}

/** did:key for a compressed P-256 public key (multicodec p256-pub, 0x1200). */
export function didKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 33) throw new ProtocolError("SCHEMA_INVALID", "did:key expects a compressed P-256 key");
  const prefixed = new Uint8Array(2 + publicKey.length);
  prefixed[0] = 0x80;
  prefixed[1] = 0x24;
  prefixed.set(publicKey, 2);
  return `did:key:z${base58btc(prefixed)}`;
}

export function didKeyFromSigner(key: P256Key): string {
  return didKey(key.publicKey);
}

export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new ProtocolError("SCHEMA_INVALID", "did:key");
  const decoded = base58btcDecode(did.slice("did:key:z".length));
  if (decoded.length !== 35 || decoded[0] !== 0x80 || decoded[1] !== 0x24) {
    throw new ProtocolError("SCHEMA_INVALID", "did:key multicodec");
  }
  return decoded.slice(2);
}

/**
 * did:web method id.
 * A numeric second segment is a port and its colon is percent-encoded
 * (`127.0.0.1:8787` → `did:web:127.0.0.1%3A8787`).
 * Later segments are path steps and keep their colons
 * (`example.com:app` → `did:web:example.com:app`, which resolves to
 * `https://example.com/app/did.json`).
 */
export function didWeb(authority: string): string {
  const segments = authority.split(":");
  const port = segments[1];
  if (segments.length >= 2 && port !== undefined && /^[0-9]+$/.test(port)) {
    const host = segments[0];
    const path = segments.slice(2);
    const encoded = `${host}%3A${port}`;
    return path.length === 0 ? `did:web:${encoded}` : `did:web:${encoded}:${path.join(":")}`;
  }
  return `did:web:${authority}`;
}

export interface DidDocument {
  "@context": string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: "Multikey";
    controller: string;
    publicKeyMultibase: string;
  }>;
  assertionMethod: string[];
}

export function didDocument(did: string, publicKey: Uint8Array): DidDocument {
  const multibase = `z${base58btc(new Uint8Array([0x80, 0x24, ...publicKey]))}`;
  const id = `${did}#key-1`;
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: [{ id, type: "Multikey", controller: did, publicKeyMultibase: multibase }],
    assertionMethod: [id],
  };
}
