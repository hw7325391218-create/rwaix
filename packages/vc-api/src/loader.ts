import { createRequire } from "node:module";
import * as didMethodKey from "@digitalbazaar/did-method-key";
import * as ecdsaMultikey from "@digitalbazaar/ecdsa-multikey";
import * as ed25519Multikey from "@digitalbazaar/ed25519-multikey";
import { defaultDocumentLoader } from "@digitalbazaar/vc";

const require = createRequire(import.meta.url);
const dataIntegrity = require("@digitalbazaar/data-integrity-context") as { contexts: Map<string, unknown> };
const multikey = require("@digitalbazaar/multikey-context") as { contexts: Map<string, unknown> };
const didContext = require("@digitalcredentials/did-context") as { contexts: Map<string, unknown> };

const didKeyDriver = didMethodKey.driver();
didKeyDriver.use({ multibaseMultikeyHeader: "z6Mk", fromMultibase: ed25519Multikey.from });
didKeyDriver.use({ multibaseMultikeyHeader: "zDna", fromMultibase: ecdsaMultikey.from });

const staticDocuments = new Map<string, unknown>();
for (const source of [dataIntegrity.contexts, multikey.contexts, didContext.contexts]) {
  for (const [url, document] of source) staticDocuments.set(url, document);
}
staticDocuments.set("https://www.w3.org/ns/credentials/examples/v2", {
  "@context": { "@vocab": "https://www.w3.org/ns/credentials/examples#" },
});

export interface JsonLdDocument {
  contextUrl: null;
  documentUrl: string;
  document: unknown;
}

export async function documentLoader(url: string): Promise<JsonLdDocument> {
  if (url.startsWith("did:")) {
    const document = await didKeyDriver.get({ url });
    return { contextUrl: null, documentUrl: url, document };
  }
  const cached = staticDocuments.get(url);
  if (cached !== undefined) return { contextUrl: null, documentUrl: url, document: cached };
  return defaultDocumentLoader(url);
}
