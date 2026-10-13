export const PROTOCOL_VERSION = "rwaix-0.1.0";
export const SIGNING_DOMAIN = "rwaix.signing.v1";
export const SERVICE_AUDIENCE = "rwaix:reference";
export const SCHEMA_RELEASE = "1.0.0";
export const ENGINE_VERSION = "rwaix-policy-0.1.0";

export const ACTIONS = [
  "registerObject",
  "publishVersion",
  "resolveBinding",
  "submitEvidence",
  "evaluatePolicy",
  "verifyReceipt",
  "checkStatus",
  "prepareIntent",
  "executeIntent",
  "trade",
  "setStatus",
  "agent",
] as const;

export type ActionName = (typeof ACTIONS)[number];
