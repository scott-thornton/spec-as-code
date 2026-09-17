import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Deterministic digest over the canonical JSON of `value`. */
export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}
