import { ProtocolError } from "./errors.js";

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

export function assertIso(value: string): void {
  if (!ISO.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ProtocolError("SCHEMA_INVALID", `bad timestamp ${value}`);
  }
}

export function isoToUnix(value: string): bigint {
  assertIso(value);
  return BigInt(Math.floor(Date.parse(value) / 1000));
}

export function secondsBetween(later: string, earlier: string): number {
  return Number(isoToUnix(later) - isoToUnix(earlier));
}

export interface Clock {
  now(): string;
}

export class ManualClock implements Clock {
  constructor(private current: string) {
    assertIso(current);
  }
  now(): string {
    return this.current;
  }
  set(value: string): void {
    assertIso(value);
    this.current = value;
  }
}
