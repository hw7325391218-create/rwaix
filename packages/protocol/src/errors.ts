import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(dirname(fileURLToPath(import.meta.url)), "../../schemas/v1/error-codes.json");
const KNOWN = new Set<string>((JSON.parse(readFileSync(file, "utf8")) as { codes: string[] }).codes);

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    if (!KNOWN.has(code)) {
      throw new Error(`unregistered error code: ${code}`);
    }
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

export const ERROR_CODES: readonly string[] = [...KNOWN];
