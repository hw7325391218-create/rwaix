import { ProtocolError, signJws, verifyJws, type P256Key } from "@rwaix/protocol";
import { didDocument, publicKeyFromDidKey, type DidDocument } from "./did.js";

export interface CredentialStatus {
  type: "BitstringStatusListEntry";
  statusPurpose: "revocation" | "suspension";
  statusListIndex: string;
  statusListCredential: string;
}

export interface VerifiableCredential {
  schemaId: "rwaix.vc.v1";
  "@context": string[];
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: { id: string; claims: Record<string, string> };
  credentialStatus?: CredentialStatus;
}

export interface DidResolver {
  resolve(did: string): DidDocument | undefined;
}

export function localResolver(extra: Record<string, DidDocument> = {}): DidResolver {
  return {
    resolve(did: string) {
      if (extra[did]) return extra[did];
      if (did.startsWith("did:key:")) return didDocument(did, publicKeyFromDidKey(did));
      return undefined;
    },
  };
}

export function issueCredential(key: P256Key, issuerDid: string, credential: VerifiableCredential): string {
  if (credential.issuer !== issuerDid) throw new ProtocolError("SCHEMA_INVALID", "vc issuer");
  return signJws(key, credential);
}

export function verifyCredential(jws: string, resolver: DidResolver): { signer: string; credential: VerifiableCredential } {
  const encoded = jws.split(".")[1];
  if (!encoded) throw new ProtocolError("SIGNATURE_INVALID", "vc payload");
  const credential = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as VerifiableCredential;
  if (credential.schemaId !== "rwaix.vc.v1" || !credential.type.includes("VerifiableCredential")) {
    throw new ProtocolError("SCHEMA_INVALID", "vc type");
  }
  const signer = verifyJws(jws, credential);
  const document = resolver.resolve(credential.issuer);
  if (!document) throw new ProtocolError("NOT_FOUND", "issuer did");
  const method = document.verificationMethod[0];
  if (!method) throw new ProtocolError("NOT_FOUND", "verification method");
  const keyBytes = publicKeyFromDidKey(`did:key:${method.publicKeyMultibase}`);
  const expected = `p256:${Buffer.from(keyBytes).toString("hex")}`;
  if (expected !== signer) throw new ProtocolError("SIGNATURE_INVALID", "vc signer does not match the DID document");
  return { signer, credential };
}
