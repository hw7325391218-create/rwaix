declare module "@digitalbazaar/vc" {
  export function issue(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  export function verifyCredential(options: Record<string, unknown>): Promise<{ verified: boolean; error?: unknown }>;
  export function verify(options: Record<string, unknown>): Promise<{ verified: boolean; error?: unknown }>;
  export function defaultDocumentLoader(url: string): Promise<{ contextUrl: null; documentUrl: string; document: unknown }>;
}

declare module "@digitalbazaar/data-integrity" {
  export class DataIntegrityProof {
    constructor(options: Record<string, unknown>);
  }
}

declare module "@digitalbazaar/eddsa-rdfc-2022-cryptosuite" {
  export const cryptosuite: Record<string, unknown>;
}

declare module "@digitalbazaar/ecdsa-rdfc-2019-cryptosuite" {
  export const cryptosuite: Record<string, unknown>;
}

declare module "@digitalbazaar/ed25519-multikey" {
  export function from(key: Record<string, unknown>): Promise<MultikeyPair>;
}

declare module "@digitalbazaar/ecdsa-multikey" {
  export function from(key: Record<string, unknown>): Promise<MultikeyPair>;
}

declare module "@digitalbazaar/did-method-key" {
  export class DidKeyDriver {
    use(options: { multibaseMultikeyHeader: string; fromMultibase: (key: Record<string, unknown>) => Promise<unknown> }): void;
    get(options: { did?: string; url?: string }): Promise<unknown>;
  }
  export function driver(): DidKeyDriver;
}

declare module "jsonld-signatures" {
  export class AssertionProofPurpose {
    constructor(options?: Record<string, unknown>);
  }
  export class AuthenticationProofPurpose {
    constructor(options?: { challenge?: string; domain?: string; controller?: string });
  }
  const jsigs: {
    purposes: {
      AssertionProofPurpose: typeof AssertionProofPurpose;
      AuthenticationProofPurpose: typeof AuthenticationProofPurpose;
    };
  };
  export default jsigs;
}

interface MultikeyPair {
  id?: string;
  controller?: string;
  publicKeyMultibase?: string;
  signer(): { id?: string; algorithm?: string; sign(input: { data: Uint8Array }): Promise<Uint8Array> };
}
