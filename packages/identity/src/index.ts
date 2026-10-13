export { base58btc, didDocument, didKey, didKeyEd25519, didKeyFromSigner, didWeb, publicKeyFromDidKey } from "./did.js";
export type { DidDocument } from "./did.js";
export { AccountRecovery } from "./recovery.js";
export type { RecoveryPolicy } from "./recovery.js";
export { issueCredential, localResolver, verifyCredential } from "./vc.js";
export type { CredentialStatus, DidResolver, VerifiableCredential } from "./vc.js";
