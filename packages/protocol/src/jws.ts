import { p256 } from "@noble/curves/p256.js";
import { sha256 } from "@noble/hashes/sha256.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalStringify } from "./canonical.js";
import { ProtocolError } from "./errors.js";
import type { P256Key } from "./keys.js";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function b64urlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function signJws(key: P256Key, payload: unknown): string {
  const header = { alg: "ES256", typ: "JWS", kid: key.publicRef };
  const encodedHeader = b64url(new TextEncoder().encode(canonicalStringify(header)));
  const encodedPayload = b64url(new TextEncoder().encode(canonicalStringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sig = p256.sign(sha256(new TextEncoder().encode(signingInput)), key.privateKey);
  return `${signingInput}.${b64url(sig.toCompactRawBytes())}`;
}

export function verifyJws(jws: string, expectedPayload: unknown): string {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ProtocolError("SIGNATURE_INVALID", "malformed JWS");
  }
  const [encodedHeader, encodedPayload, encodedSig] = parts as [string, string, string];
  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(encodedHeader))) as typeof header;
  } catch {
    throw new ProtocolError("SIGNATURE_INVALID", "bad JWS header");
  }
  if (header.alg !== "ES256" || header.typ !== "JWS" || typeof header.kid !== "string") {
    throw new ProtocolError("SIGNING_DOMAIN_MISMATCH", "JWS header is not the RWAIX ES256 domain");
  }
  const payloadJson = new TextDecoder().decode(b64urlDecode(encodedPayload));
  if (payloadJson !== canonicalStringify(expectedPayload)) {
    throw new ProtocolError("SIGNATURE_INVALID", "JWS payload does not match the request digest envelope");
  }
  if (!/^p256:[a-f0-9]{66}$/.test(header.kid)) {
    throw new ProtocolError("SIGNATURE_INVALID", "kid is not a compressed P-256 key");
  }
  const ok = p256.verify(
    b64urlDecode(encodedSig),
    sha256(new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)),
    hexToBytes(header.kid.slice(5)),
  );
  if (!ok) throw new ProtocolError("SIGNATURE_INVALID", "P-256 verification failed");
  return header.kid;
}

export function publicRefFromPrivate(privateKey: Uint8Array): string {
  return `p256:${bytesToHex(p256.getPublicKey(privateKey, true))}`;
}
