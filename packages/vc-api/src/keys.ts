import * as EcdsaMultikey from "@digitalbazaar/ecdsa-multikey";
import * as Ed25519Multikey from "@digitalbazaar/ed25519-multikey";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha256.js";
import { base58btc, didKey, didKeyEd25519 } from "@rwaix/identity";
import { keyFromSeed } from "@rwaix/protocol";

export interface Signer {
  id?: string;
  algorithm?: string;
  sign(input: { data: Uint8Array }): Promise<Uint8Array>;
}

export interface IssuerProfile {
  cryptosuite: "eddsa-rdfc-2022" | "ecdsa-rdfc-2019";
  did: string;
  publicKeyMultibase: string;
  signer: Signer;
}

function multibase(bytes: Uint8Array): string {
  return `z${base58btc(bytes)}`;
}

export async function loadIssuers(): Promise<{ eddsa: IssuerProfile; ecdsa: IssuerProfile }> {
  const edSeed = sha256(new TextEncoder().encode("rwaix-ed25519-v1:vc-api-eddsa"));
  const edPublic = ed25519.getPublicKey(edSeed);
  const edDid = didKeyEd25519(edPublic);
  const edPublicMultibase = edDid.slice("did:key:".length);
  const edSecret = new Uint8Array(2 + edSeed.length);
  edSecret[0] = 0x80;
  edSecret[1] = 0x26;
  edSecret.set(edSeed, 2);
  const edPair = await Ed25519Multikey.from({
    "@context": "https://w3id.org/security/multikey/v1",
    type: "Multikey",
    controller: edDid,
    id: `${edDid}#${edPublicMultibase}`,
    publicKeyMultibase: edPublicMultibase,
    secretKeyMultibase: multibase(edSecret),
  });
  const edSigner = edPair.signer();
  edSigner.id = `${edDid}#${edPublicMultibase}`;

  const p256 = keyFromSeed("vc-api-ecdsa-p256");
  const p256Did = didKey(p256.publicKey);
  const p256PublicMultibase = p256Did.slice("did:key:".length);
  const p256Secret = new Uint8Array(2 + p256.privateKey.length);
  p256Secret[0] = 0x86;
  p256Secret[1] = 0x26;
  p256Secret.set(p256.privateKey, 2);
  const p256Pair = await EcdsaMultikey.from({
    "@context": "https://w3id.org/security/multikey/v1",
    type: "Multikey",
    controller: p256Did,
    id: `${p256Did}#${p256PublicMultibase}`,
    publicKeyMultibase: p256PublicMultibase,
    secretKeyMultibase: multibase(p256Secret),
  });
  const p256Signer = p256Pair.signer();
  p256Signer.id = `${p256Did}#${p256PublicMultibase}`;

  return {
    eddsa: { cryptosuite: "eddsa-rdfc-2022", did: edDid, publicKeyMultibase: edPublicMultibase, signer: edSigner },
    ecdsa: { cryptosuite: "ecdsa-rdfc-2019", did: p256Did, publicKeyMultibase: p256PublicMultibase, signer: p256Signer },
  };
}
