export { canonicalStringify } from "./canonical.js";
export { ACTIONS, ENGINE_VERSION, PROTOCOL_VERSION, SCHEMA_RELEASE, SERVICE_AUDIENCE, SIGNING_DOMAIN } from "./constants.js";
export type { ActionName } from "./constants.js";
export { ACTION_TYPE, DOMAIN_TYPE, RWAIX_ACTION_TYPES, domainSeparator, encodeType, hashStruct, signTypedData, typedDataDigest, verifyTypedData } from "./eip712.js";
export type { Eip712Domain, TypeField, TypedSchema } from "./eip712.js";
export { buildSigningEnvelope, signRequest } from "./envelope.js";
export type { SignedRequest, SigningEnvelope } from "./envelope.js";
export { ERROR_CODES, ProtocolError, isProtocolError } from "./errors.js";
export { digestBytes32, digestPrefixed, sha256Hex } from "./hash.js";
export { publicRefFromPrivate, signJws, verifyJws } from "./jws.js";
export { keyFromSeed } from "./keys.js";
export type { P256Key } from "./keys.js";
export { listSchemaIds, schemaDigest, validateBySchemaId } from "./schema.js";
export { ManualClock, assertIso, isoToUnix, secondsBetween } from "./time.js";
export type { Clock } from "./time.js";

export type Result<T> = { ok: true; value: T; recordedAt: string } | { ok: false; error: string; message: string };
