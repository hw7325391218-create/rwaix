import type { TrustPolicy } from "@rwaix/policy-engine";

export interface ScopeResult {
  ok: boolean;
  reasonCode?: string;
}

/**
 * Industry adapters map external facts into kernel objects.
 * They must list facts the kernel cannot judge. They do not extend
 * the policy engine with arbitrary code.
 */
export interface IndustryAdapter<TInput> {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly externalFacts: readonly string[];
  buildPolicy(): TrustPolicy;
  mapEvidence(input: TInput): Record<string, string>;
  checkScope(terms: Record<string, string>, evidence: Record<string, string>): ScopeResult;
}

export function assertStringMap(input: Record<string, string>, fields: readonly string[]): ScopeResult {
  for (const field of fields) {
    if (!input[field]) return { ok: false, reasonCode: "MISSING_REQUIRED_FIELD" };
  }
  return { ok: true };
}
