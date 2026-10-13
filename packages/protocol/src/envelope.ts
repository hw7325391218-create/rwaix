import { digestPrefixed } from "./hash.js";
import { signJws } from "./jws.js";
import type { P256Key } from "./keys.js";
import { PROTOCOL_VERSION, SIGNING_DOMAIN, SERVICE_AUDIENCE, type ActionName } from "./constants.js";

export interface SigningEnvelope {
  schemaId: "rwaix.signing.v1";
  protocolVersion: typeof PROTOCOL_VERSION;
  domain: typeof SIGNING_DOMAIN;
  chainId: string;
  action: ActionName;
  audience: string;
  nonce: string;
  deadline: string;
  payloadDigest: string;
}

export interface SignedRequest {
  schemaId: "rwaix.signed.v1";
  request: Record<string, unknown>;
  chainId: string;
  audience: string;
  nonce: string;
  deadline: string;
  proof: string;
}

export function buildSigningEnvelope(input: {
  action: ActionName;
  chainId: string;
  audience: string;
  nonce: string;
  deadline: string;
  request: unknown;
}): SigningEnvelope {
  return {
    schemaId: "rwaix.signing.v1",
    protocolVersion: PROTOCOL_VERSION,
    domain: SIGNING_DOMAIN,
    chainId: input.chainId,
    action: input.action,
    audience: input.audience,
    nonce: input.nonce,
    deadline: input.deadline,
    payloadDigest: digestPrefixed(input.request),
  };
}

export function signRequest(
  key: P256Key,
  action: ActionName,
  request: Record<string, unknown>,
  meta: { nonce: string; deadline: string; chainId?: string; audience?: string },
): SignedRequest {
  const chainId = meta.chainId ?? "31337";
  const audience = meta.audience ?? SERVICE_AUDIENCE;
  const envelope = buildSigningEnvelope({
    action,
    chainId,
    audience,
    nonce: meta.nonce,
    deadline: meta.deadline,
    request,
  });
  return {
    schemaId: "rwaix.signed.v1",
    request,
    chainId,
    audience,
    nonce: meta.nonce,
    deadline: meta.deadline,
    proof: signJws(key, envelope),
  };
}
