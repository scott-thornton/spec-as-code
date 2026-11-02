import { SpcError } from "./errors.js";

/**
 * Exhaustiveness assertion (specs/tooling-sweep): a switch over a union
 * whose default arm calls this gains compiler-enforced exhaustiveness -
 * the NEXT union member is a type error at every handler site, caught by
 * the typecheck gate instead of a failed run (the receipts: the
 * summarizeCriterion and lintSpec breaks when the suite member joined
 * AcceptanceCriterion).
 */
export function assertNever(x: never): never {
  throw new SpcError("SPC_RUNTIME_ERROR", `unhandled union member: ${String(x)}`);
}
