import { sha256, sha384 } from "@noble/hashes/sha2.js";

const VC_V1 = "https://www.w3.org/2018/credentials/v1";
const VC_V2 = "https://www.w3.org/ns/credentials/v2";
const DATE_TIME = /^-?([1-9][0-9]{3,}|0[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T(([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?|(24:00:00(\.0+)?))(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/;
const LANGUAGE_KEYS = new Set(["@value", "@language", "@direction"]);
const TYPED_PROPERTIES = ["credentialStatus", "termsOfUse", "evidence", "refreshService", "credentialSchema"] as const;

export class VcApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const resourceCache = new Map<string, Uint8Array>();

function isUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObjects(value: unknown, name: string): Record<string, unknown>[] {
  if (isPlainObject(value)) return [value];
  if (Array.isArray(value) && value.every(isPlainObject)) return value;
  throw new VcApiError(400, `${name} must be an object or an array of objects`);
}

function assertTypeValue(value: unknown, name: string): void {
  if (typeof value === "string" && value.length > 0) return;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)) return;
  throw new VcApiError(400, `${name} must be a string or an array of strings`);
}

function assertOptionalId(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!isUrl(value)) throw new VcApiError(400, `${name} must be a single URL`);
}

function assertLanguageValue(value: unknown, name: string): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) assertLanguageValue(item, name);
    return;
  }
  if (!isPlainObject(value)) throw new VcApiError(400, `${name} must be a string or a language value`);
  if (!("@value" in value) || typeof value["@value"] !== "string") {
    throw new VcApiError(400, `${name} language value requires @value`);
  }
  for (const key of Object.keys(value)) {
    if (!LANGUAGE_KEYS.has(key)) throw new VcApiError(400, `${name} contains ${key}`);
  }
}

function walkNames(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) walkNames(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "@context" || key === "proof") continue;
    if (key === "name" || key === "description") assertLanguageValue(child, key);
    else walkNames(child);
  }
}

async function fetchResource(url: string): Promise<Uint8Array> {
  const cached = resourceCache.get(url);
  if (cached) return cached;
  if (!url.startsWith("https://")) throw new VcApiError(400, "relatedResource id must be https");
  const response = await fetch(url);
  if (!response.ok) throw new VcApiError(400, `relatedResource ${url} returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1_000_000) throw new VcApiError(400, "relatedResource is too large");
  resourceCache.set(url, bytes);
  return bytes;
}

function digestSri(hash: Uint8Array): string {
  return `sha384-${Buffer.from(hash).toString("base64")}`;
}

function multibaseSha256(bytes: Uint8Array): string {
  return `u${Buffer.from(sha256(bytes)).toString("base64url")}`;
}

async function assertRelatedResource(value: unknown): Promise<void> {
  const resources = asObjects(value, "relatedResource");
  const seen = new Set<string>();
  for (const resource of resources) {
    if (!isUrl(resource.id)) throw new VcApiError(400, "relatedResource.id must be a URL");
    if (seen.has(resource.id)) throw new VcApiError(400, "relatedResource.id must be unique");
    seen.add(resource.id);
    const sri = resource.digestSRI;
    const multibase = resource.digestMultibase;
    if (typeof sri !== "string" && typeof multibase !== "string") {
      throw new VcApiError(400, "relatedResource requires digestSRI or digestMultibase");
    }
    const bytes = await fetchResource(resource.id);
    const hash = sha384(bytes);
    if (typeof sri === "string" && sri !== digestSri(hash)) throw new VcApiError(400, "relatedResource digestSRI does not match");
    if (typeof multibase === "string" && multibase !== multibaseSha256(bytes)) {
      throw new VcApiError(400, "relatedResource digestMultibase does not match");
    }
  }
}

export async function prepareCredential(input: unknown, issuerDid: string): Promise<Record<string, unknown>> {
  if (!isPlainObject(input)) throw new VcApiError(400, "credential must be an object");
  const credential = structuredClone(input);
  delete credential.proof;
  const context = credential["@context"];
  if (!Array.isArray(context) || context.length === 0) throw new VcApiError(400, "@context must be an array");
  if (context[0] !== VC_V1 && context[0] !== VC_V2) throw new VcApiError(400, "@context must start with the VC base context");
  for (const item of context.slice(1)) {
    if (typeof item === "string") {
      if (!isUrl(item)) throw new VcApiError(400, "@context URL is invalid");
    } else if (!isPlainObject(item)) {
      throw new VcApiError(400, "@context values must be URLs or objects");
    }
  }
  assertTypeValue(credential.type, "type");
  const types = Array.isArray(credential.type) ? credential.type : [credential.type];
  if (!types.includes("VerifiableCredential")) throw new VcApiError(400, "type must include VerifiableCredential");
  if ("id" in credential) assertOptionalId(credential.id, "credential.id");
  if (!("issuer" in credential)) credential.issuer = issuerDid;
  else if (typeof credential.issuer === "string") {
    if (!isUrl(credential.issuer)) throw new VcApiError(400, "issuer must be a URL");
  } else if (isPlainObject(credential.issuer)) {
    if (credential.issuer.id === null || credential.issuer.id === undefined) {
      throw new VcApiError(400, "issuer.id is required");
    }
    if (!isUrl(credential.issuer.id)) throw new VcApiError(400, "issuer.id must be a URL");
  } else {
    throw new VcApiError(400, "issuer must be a URL or an object");
  }
  const subjects = Array.isArray(credential.credentialSubject) ? credential.credentialSubject : [credential.credentialSubject];
  for (const subject of subjects) {
    if (isPlainObject(subject) && "id" in subject) assertOptionalId(subject.id, "credentialSubject.id");
  }
  for (const property of ["validFrom", "validUntil"] as const) {
    if (property in credential && !DATE_TIME.test(String(credential[property]))) {
      throw new VcApiError(400, `${property} must be an XML dateTimeStamp`);
    }
  }
  if (typeof credential.validFrom === "string" && typeof credential.validUntil === "string") {
    if (Date.parse(credential.validFrom) > Date.parse(credential.validUntil)) {
      throw new VcApiError(400, "validFrom must be the same as or earlier than validUntil");
    }
  }
  for (const property of TYPED_PROPERTIES) {
    if (!(property in credential)) continue;
    for (const entry of asObjects(credential[property], property)) {
      assertTypeValue(entry.type, `${property}.type`);
      if ("id" in entry) assertOptionalId(entry.id, `${property}.id`);
      if (property === "credentialSchema" && !isUrl(entry.id)) {
        throw new VcApiError(400, "credentialSchema.id must be a URL");
      }
    }
  }
  if ("relatedResource" in credential) await assertRelatedResource(credential.relatedResource);
  if (context[0] === VC_V2) walkNames(credential);
  return credential;
}
