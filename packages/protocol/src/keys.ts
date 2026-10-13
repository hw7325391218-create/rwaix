import { p256 } from "@noble/curves/p256.js";
import { sha256 } from "@noble/hashes/sha256.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface P256Key {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicRef: string;
}

export function keyFromSeed(seed: string): P256Key {
  let material = sha256(new TextEncoder().encode(`rwaix-p256-v1:${seed}`));
  while (!p256.utils.isValidPrivateKey(material)) material = sha256(material);
  const publicKey = p256.getPublicKey(material, true);
  return { privateKey: material, publicKey, publicRef: `p256:${bytesToHex(publicKey)}` };
}
