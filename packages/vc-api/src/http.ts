import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { issueWithSuite, verifyCredentialDocument, verifyPresentationDocument } from "./credentials.js";
import { loadIssuers } from "./keys.js";
import { VcApiError } from "./validate.js";

export interface VcApiServer {
  server: ReturnType<typeof createServer>;
  host: string;
  port: number;
  eddsaDid: string;
  ecdsaDid: string;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  return JSON.parse(text) as unknown;
}

export function vcApiPath(pathname: string): string | undefined {
  if (pathname === "/vc-api" || pathname.startsWith("/vc-api/")) {
    const rest = pathname.slice("/vc-api".length);
    return rest.length === 0 ? "/" : rest;
  }
  if (pathname.startsWith("/credentials/") || pathname.startsWith("/presentations/") || pathname.startsWith("/ecdsa/")) {
    return pathname;
  }
  return undefined;
}

export async function handleVcApi(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = vcApiPath(url.pathname);
  if (!path) return false;
  if (request.method !== "POST") {
    send(response, 404, { verified: false, errors: ["not found"] });
    return true;
  }
  try {
    const body = await readJson(request);
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const options = typeof record.options === "object" && record.options !== null ? record.options as Record<string, unknown> : undefined;
    if (path === "/credentials/issue" || path === "/ecdsa/credentials/issue") {
      const cryptosuite = path.startsWith("/ecdsa/") ? "ecdsa-rdfc-2019" : "eddsa-rdfc-2022";
      const verifiableCredential = await issueWithSuite(cryptosuite, record.credential);
      send(response, 200, { verifiableCredential });
      return true;
    }
    if (path === "/credentials/verify") {
      await verifyCredentialDocument(record.verifiableCredential, options);
      send(response, 200, { verified: true });
      return true;
    }
    if (path === "/presentations/verify") {
      await verifyPresentationDocument(record.verifiablePresentation, options);
      send(response, 200, { verified: true });
      return true;
    }
    send(response, 404, { verified: false, errors: ["not found"] });
  } catch (error) {
    const status = error instanceof VcApiError ? error.status : error instanceof SyntaxError ? 400 : 400;
    const message = error instanceof Error ? error.message : "request failed";
    send(response, status, { verified: false, errors: [message] });
  }
  return true;
}

export async function startVcApi(options?: { host?: string; port?: number }): Promise<VcApiServer> {
  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? Number(process.env.VC_API_PORT ?? 0);
  const issuers = await loadIssuers();
  const server = createServer((request, response) => {
    void handleVcApi(request, response).then((handled) => {
      if (!handled) send(response, 404, { verified: false, errors: ["not found"] });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return { server, host, port: bound, eddsaDid: issuers.eddsa.did, ecdsaDid: issuers.ecdsa.did };
}
