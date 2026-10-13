import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ProtocolError, digestPrefixed } from "@rwaix/protocol";
import type { ReferenceService } from "@rwaix/sdk";
import type { SignedRequest } from "@rwaix/protocol";

const require = createRequire(import.meta.url);
const snarkjs = require("snarkjs") as {
  groth16: {
    fullProve: (
      input: Record<string, string>,
      wasm: string,
      zkey: string,
    ) => Promise<{ proof: Record<string, unknown>; publicSignals: string[] }>;
    verify: (vkey: unknown, publicSignals: string[], proof: unknown) => Promise<boolean>;
  };
  curves: { getCurveFromName: (name: string) => Promise<{ terminate: () => Promise<void> }> };
};

const artifacts = join(dirname(fileURLToPath(import.meta.url)), "../artifacts");
const wasm = join(artifacts, "range32.wasm");
const zkey = join(artifacts, "range32_final.zkey");
const vkey = JSON.parse(readFileSync(join(artifacts, "verification_key.json"), "utf8")) as unknown;

export interface RangeProof {
  schemaId: "rwaix.zk.range.v1";
  circuit: "range32";
  min: string;
  max: string;
  proof: Record<string, unknown>;
  publicSignals: string[];
}

/**
 * Groth16 range proof: private value, public min and max.
 * The powers-of-tau contribution used to build the checked-in key was a
 * public test ceremony. It demonstrates the circuit and the verifier wiring.
 * It is not a sound production setup, because the ceremony entropy was not a
 * discarded multi-party trapdoor.
 */
export async function proveRange(value: bigint, min: bigint, max: bigint): Promise<RangeProof> {
  if (value < 0n || value > 0xffffffffn || min < 0n || max > 0xffffffffn) {
    throw new ProtocolError("SCHEMA_INVALID", "range proof inputs must fit in 32 bits");
  }
  let proved: { proof: Record<string, unknown>; publicSignals: string[] };
  try {
    proved = await snarkjs.groth16.fullProve({ value: value.toString(), min: min.toString(), max: max.toString() }, wasm, zkey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolError("SIGNATURE_INVALID", `range circuit rejected the witness: ${message.split("\n")[0]}`);
  }
  const proof: RangeProof = {
    schemaId: "rwaix.zk.range.v1",
    circuit: "range32",
    min: min.toString(),
    max: max.toString(),
    proof: proved.proof,
    publicSignals: proved.publicSignals,
  };
  if (!(await verifyRange(proof))) throw new ProtocolError("SIGNATURE_INVALID", "fresh range proof did not verify");
  return proof;
}

export async function verifyRange(proof: RangeProof): Promise<boolean> {
  if (proof.circuit !== "range32" || proof.schemaId !== "rwaix.zk.range.v1") return false;
  if (proof.publicSignals.length !== 2) return false;
  if (proof.publicSignals[0] !== proof.min || proof.publicSignals[1] !== proof.max) return false;
  return snarkjs.groth16.verify(vkey, proof.publicSignals, proof.proof);
}

export async function shutdownProver(): Promise<void> {
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  await curve.terminate();
}

/** Verify a range proof, note its digest, then submit the signed evidence. */
export async function submitEvidenceWithProof(
  service: ReferenceService,
  signed: SignedRequest,
  proof: RangeProof,
): Promise<ReturnType<ReferenceService["submitEvidence"]>> {
  if (!(await verifyRange(proof))) throw new ProtocolError("SIGNATURE_INVALID", "range proof rejected");
  const request = signed.request;
  if (digestPrefixed(request.zkProof) !== digestPrefixed(proof)) {
    throw new ProtocolError("SCHEMA_INVALID", "signed zkProof does not match the verified proof");
  }
  service.noteProof(digestPrefixed(proof));
  return service.submitEvidence(signed);
}

export async function verifyReceiptWithProof(
  service: ReferenceService,
  signed: SignedRequest,
  proof: RangeProof,
): Promise<ReturnType<ReferenceService["verifyReceipt"]>> {
  if (!(await verifyRange(proof))) throw new ProtocolError("SIGNATURE_INVALID", "range proof rejected");
  service.noteProof(digestPrefixed(proof));
  return service.verifyReceipt(signed);
}
