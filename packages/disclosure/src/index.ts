import { createHash } from "node:crypto";
import { ProtocolError, signJws, verifyJws, type P256Key } from "@rwaix/protocol";

/**
 * Selective disclosure in the SD-JWT compact shape (draft-ietf-oauth-selective-disclosure-jwt).
 * Digests are base64url(SHA-256(disclosure)). The issuer signature is JWS ES256.
 * Claim values in this suite are strings.
 */
export interface SdIssuerPayload {
  schemaId: "rwaix.sd-jwt.v1";
  iss: string;
  _sd_alg: "sha-256";
  _sd: string[];
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function b64urlText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function disclosureFor(salt: string, name: string, value: string): string {
  if (!salt || salt.length < 16) throw new ProtocolError("SCHEMA_INVALID", "disclosure salt is too short");
  return b64urlText(JSON.stringify([salt, name, value]));
}

export function disclosureDigest(disclosure: string): string {
  return b64url(createHash("sha256").update(disclosure).digest());
}

export function issueSelectiveDisclosure(
  key: P256Key,
  claims: Record<string, string>,
  salts: Record<string, string>,
): { payload: SdIssuerPayload; issuerJws: string; disclosures: Record<string, string> } {
  const disclosures: Record<string, string> = {};
  const digests: string[] = [];
  for (const name of Object.keys(claims).sort()) {
    const value = claims[name];
    if (typeof value !== "string") throw new ProtocolError("SCHEMA_INVALID", "SD-JWT claim values are strings");
    const salt = salts[name];
    if (!salt) throw new ProtocolError("SCHEMA_INVALID", `missing salt for ${name}`);
    const disclosure = disclosureFor(salt, name, value);
    disclosures[name] = disclosure;
    digests.push(disclosureDigest(disclosure));
  }
  digests.sort();
  const payload: SdIssuerPayload = { schemaId: "rwaix.sd-jwt.v1", iss: key.publicRef, _sd_alg: "sha-256", _sd: digests };
  return { payload, issuerJws: signJws(key, payload), disclosures };
}

export function presentSelectiveDisclosure(issuerJws: string, disclosures: string[]): string {
  return `${issuerJws}~${disclosures.join("~")}~`;
}

export function verifySelectiveDisclosure(presentation: string): { issuer: string; claims: Record<string, string> } {
  const parts = presentation.split("~");
  if (parts.length < 2 || parts[parts.length - 1] !== "") throw new ProtocolError("SCHEMA_INVALID", "SD-JWT presentation must end with ~");
  const issuerJws = parts[0];
  if (!issuerJws) throw new ProtocolError("SCHEMA_INVALID", "missing issuer jwt");
  const encodedPayload = issuerJws.split(".")[1];
  if (!encodedPayload) throw new ProtocolError("SIGNATURE_INVALID", "SD-JWT issuer payload");
  let payload: SdIssuerPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SdIssuerPayload;
  } catch {
    throw new ProtocolError("SIGNATURE_INVALID", "SD-JWT issuer payload");
  }
  if (payload._sd_alg !== "sha-256" || payload.schemaId !== "rwaix.sd-jwt.v1" || !Array.isArray(payload._sd)) {
    throw new ProtocolError("SCHEMA_INVALID", "SD-JWT payload");
  }
  const issuer = verifyJws(issuerJws, payload);
  if (issuer !== payload.iss) throw new ProtocolError("SIGNATURE_INVALID", "SD-JWT issuer");
  const allowed = new Set(payload._sd);
  const claims: Record<string, string> = {};
  for (const disclosure of parts.slice(1, -1)) {
    if (!disclosure) throw new ProtocolError("SCHEMA_INVALID", "empty disclosure");
    const digest = disclosureDigest(disclosure);
    if (!allowed.has(digest)) throw new ProtocolError("SIGNATURE_INVALID", "disclosure is not committed");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(disclosure, "base64url").toString("utf8")) as unknown;
    } catch {
      throw new ProtocolError("SCHEMA_INVALID", "disclosure json");
    }
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded.some((item) => typeof item !== "string")) {
      throw new ProtocolError("SCHEMA_INVALID", "disclosure array");
    }
    const [, name, value] = decoded as [string, string, string];
    if (name in claims) throw new ProtocolError("SCHEMA_INVALID", "duplicate disclosed claim");
    claims[name] = value;
    allowed.delete(digest);
  }
  return { issuer, claims };
}
