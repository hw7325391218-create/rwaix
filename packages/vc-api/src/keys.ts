import * as EcdsaMultikey from "@digitalbazaar/ecdsa-multikey";
import * as Ed25519Multikey from "@digitalbazaar/ed25519-multikey";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 as p256Curve } from "@noble/curves/p256.js";
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

/**
 * WARNING: by default the VC-API issuer keys are derived from fixed, public seeds
 * in this file. They are PUBLIC TEST KEYS. Anyone can sign as these DIDs, so a
 * signature from them proves nothing about who issued a credential.
 *
 * Operators can inject their own keys through the environment:
 *   RWAIX_VC_EDDSA_SEED_HEX   32-byte Ed25519 seed, hex (64 hex chars)
 *   RWAIX_VC_ECDSA_KEY_HEX    32-byte P-256 private key, hex (64 hex chars)
 * Injected keys change the issuer DIDs, so docs/interop/rwaix.json must be updated.
 */
function hexKey(name: string): Uint8Array | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be 32 bytes of hex`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function multibase(bytes: Uint8Array): string {
  return `z${base58btc(bytes)}`;
}

export async function loadIssuers(): Promise<{ eddsa: IssuerProfile; ecdsa: IssuerProfile }> {
  const edSeed = hexKey("RWAIX_VC_EDDSA_SEED_HEX") ?? sha256(new TextEncoder().encode("rwaix-ed25519-v1:vc-api-eddsa"));
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

  const injectedP256 = hexKey("RWAIX_VC_ECDSA_KEY_HEX");
  if (injectedP256 && !p256Curve.utils.isValidPrivateKey(injectedP256)) throw new Error("RWAIX_VC_ECDSA_KEY_HEX is not a valid P-256 key");
  const p256 = injectedP256
    ? { privateKey: injectedP256, publicKey: p256Curve.getPublicKey(injectedP256, true) }
    : keyFromSeed("vc-api-ecdsa-p256");
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
