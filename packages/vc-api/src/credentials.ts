import { DataIntegrityProof } from "@digitalbazaar/data-integrity";
import { cryptosuite as ecdsaRdfc2019 } from "@digitalbazaar/ecdsa-rdfc-2019-cryptosuite";
import { cryptosuite as eddsaRdfc2022 } from "@digitalbazaar/eddsa-rdfc-2022-cryptosuite";
import { issue, verify, verifyCredential } from "@digitalbazaar/vc";
import jsigs from "jsonld-signatures";
import { documentLoader } from "./loader.js";
import { loadIssuers, type IssuerProfile } from "./keys.js";
import { prepareCredential, VcApiError } from "./validate.js";

const { AssertionProofPurpose, AuthenticationProofPurpose } = jsigs.purposes;

function usesDirection(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesDirection);
  if (typeof value === "object" && value !== null) {
    if ("@direction" in value) return true;
    return Object.values(value).some(usesDirection);
  }
  return false;
}

function withDirection(suite: Record<string, unknown>): Record<string, unknown> {
  const canonize = suite.canonize as (input: unknown, options?: Record<string, unknown>) => Promise<string>;
  return {
    ...suite,
    canonize(input: unknown, options: Record<string, unknown> = {}) {
      const direction = usesDirection(input) ? { rdfDirection: "i18n-datatype" } : {};
      return canonize(input, { ...direction, ...options });
    },
  };
}

const cryptosuites: Record<string, Record<string, unknown>> = {
  "eddsa-rdfc-2022": withDirection(eddsaRdfc2022),
  "ecdsa-rdfc-2019": withDirection(ecdsaRdfc2019),
};

function assertPreviousProofs(document: unknown): void {
  if (typeof document !== "object" || document === null) return;
  const proof = (document as { proof?: unknown }).proof;
  const proofs = Array.isArray(proof) ? proof : typeof proof === "object" && proof !== null ? [proof] : [];
  const ids = new Set<string>();
  for (const item of proofs) {
    if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
      ids.add((item as { id: string }).id);
    }
  }
  for (const item of proofs) {
    if (typeof item !== "object" || item === null || !("previousProof" in item)) continue;
    const previous = (item as { previousProof?: unknown }).previousProof;
    const refs = typeof previous === "string" ? [previous] : Array.isArray(previous) ? previous : null;
    if (!refs || refs.some((ref) => typeof ref !== "string" || !ids.has(ref))) {
      throw new VcApiError(400, "previousProof does not identify another proof");
    }
  }
}

function verificationSuites(): DataIntegrityProof[] {
  return Object.values(cryptosuites).map((cryptosuite) => new DataIntegrityProof({ cryptosuite }));
}

function purposeFor(options: Record<string, unknown> | undefined): InstanceType<typeof AssertionProofPurpose> | InstanceType<typeof AuthenticationProofPurpose> {
  if (options && (options.challenge != null || options.domain != null)) {
    return new AuthenticationProofPurpose({
      challenge: typeof options.challenge === "string" ? options.challenge : undefined,
      domain: typeof options.domain === "string" ? options.domain : undefined,
    });
  }
  return new AssertionProofPurpose();
}

function failure(error: unknown): never {
  if (error instanceof VcApiError) throw error;
  const message = error instanceof Error ? error.message : "verification failed";
  throw new VcApiError(400, message);
}

export async function issueCredential(profile: IssuerProfile, credential: unknown): Promise<Record<string, unknown>> {
  const prepared = await prepareCredential(credential, profile.did);
  try {
    const verifiableCredential = await issue({
      credential: prepared,
      suite: new DataIntegrityProof({ signer: profile.signer, cryptosuite: cryptosuites[profile.cryptosuite] }),
      documentLoader,
    });
    return verifiableCredential;
  } catch (error) {
    failure(error);
  }
}

export async function verifyCredentialDocument(verifiableCredential: unknown, options?: Record<string, unknown>): Promise<void> {
  if (typeof verifiableCredential !== "object" || verifiableCredential === null || Array.isArray(verifiableCredential)) {
    throw new VcApiError(400, "verifiableCredential must be an object");
  }
  try {
    const result = await verifyCredential({
      credential: verifiableCredential,
      suite: verificationSuites(),
      documentLoader,
      purpose: purposeFor(options),
    });
    if (!result.verified) failure(result.error ?? new Error("proof verification failed"));
    assertPreviousProofs(verifiableCredential);
  } catch (error) {
    failure(error);
  }
}

export async function verifyPresentationDocument(verifiablePresentation: unknown, options?: Record<string, unknown>): Promise<void> {
  if (typeof verifiablePresentation !== "object" || verifiablePresentation === null) {
    throw new VcApiError(400, "verifiablePresentation must be an object");
  }
  const challenge = typeof options?.challenge === "string" ? options.challenge : undefined;
  const domain = typeof options?.domain === "string" ? options.domain : undefined;
  try {
    const result = await verify({
      presentation: verifiablePresentation,
      suite: verificationSuites(),
      documentLoader,
      challenge,
      domain,
      purpose: new AssertionProofPurpose(),
    });
    if (!result.verified) failure(result.error ?? new Error("presentation verification failed"));
  } catch (error) {
    failure(error);
  }
}

export async function issueWithSuite(cryptosuite: IssuerProfile["cryptosuite"], credential: unknown): Promise<Record<string, unknown>> {
  const issuers = await loadIssuers();
  const profile = cryptosuite === "ecdsa-rdfc-2019" ? issuers.ecdsa : issuers.eddsa;
  return issueCredential(profile, credential);
}
