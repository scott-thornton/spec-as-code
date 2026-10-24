import path from "node:path";

/**
 * Oracle validity and red eligibility (oracle-validity spec, 2026-10-25).
 *
 * The distinction being protected: a valid execution, a valid
 * observation, and a valid acceptance criterion are three different
 * claims. A red oracle that cannot parse never discriminated anything,
 * so its red is entitled to establish nothing - not a flip in the live
 * evaluator, not an inherited flip in a chain, however green the
 * result beside it.
 *
 * Classification fails to uncertainty, never to false certainty
 * (external review, 2026-10-24): only a transform failure whose
 * diagnostic unambiguously names the oracle's own source is
 * oracle-invalid. Transitive breakage, ambiguous paths, compound
 * commands, unknown runner output - all unclassified, all
 * red-eligible under current policy. Historical records are never
 * rewritten: eligibility is DERIVED at consumption where the recorded
 * diagnostics permit, and legacy records without derivable diagnostics
 * acquire no manufactured claim.
 */

const TEST_FILE = /(^|[/\\])([\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)$/;
const TRANSFORM_ENVELOPE = /Transform failed with \d+ error/i;
const DIAGNOSTIC_PATH = /((?:[A-Za-z]:)?[^\s:]+):\d+:\d+:\s*ERROR:/g;

/** Test-file path tokens named by the command, across shell segments. */
export function oraclePathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    for (const raw of segment.trim().split(/\s+/)) {
      const token = raw.replace(/^["']|["']$/g, "");
      if (TEST_FILE.test(token)) paths.push(token);
    }
  }
  return paths;
}

export interface OracleValidity {
  invalid: boolean;
  detail?: string;
}

/**
 * Confirmed oracle-invalid ONLY when: the output carries a
 * transform/parse envelope, the command names exactly one distinct
 * test file, and every diagnostic path in the envelope resolves to
 * that file's basename. Everything else - including the legitimate
 * cannot-find-module red of a module-import oracle - is unclassified.
 */
export function classifyOracleValidity(command: string, output: string): OracleValidity {
  if (!TRANSFORM_ENVELOPE.test(output)) return { invalid: false };
  const oracles = [...new Set(oraclePathsFromCommand(command))];
  if (oracles.length !== 1) return { invalid: false };
  const oracleBase = path.posix.basename(oracles[0]!.replace(/\\/g, "/"));
  const diagnostics = [...output.matchAll(DIAGNOSTIC_PATH)].map((m) => m[1]!);
  if (diagnostics.length === 0) return { invalid: false };
  const bases = new Set(diagnostics.map((p) => path.posix.basename(p.replace(/\\/g, "/"))));
  if (bases.size === 1 && [...bases][0] === oracleBase) {
    return { invalid: true, detail: `transform error located in the oracle source ${oracles[0]}` };
  }
  return { invalid: false };
}

/**
 * Flip eligibility as a property of the evidence, applied identically
 * by every consumer (evaluator, ancestor reconstruction, re-verify).
 * A stamped-invalid red is ineligible; an unstamped record is
 * re-derived from its recorded diagnostics at consumption - a cached
 * or legacy red cannot bypass the semantics, and a record without
 * derivable diagnostics stays eligible without acquiring a claim of
 * confirmed validity.
 */
export function isEligibleRed(record: { outcome?: string; payload?: unknown }): boolean {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  if (payload.oracleValidity === "invalid") return false;
  if (record.outcome !== "contradicts") return true;
  const command = typeof payload.command === "string" ? payload.command : "";
  if (!command) return true;
  const output = `${payload.stdout ?? ""}\n${payload.stderr ?? ""}`;
  if (!output) return true;
  return !classifyOracleValidity(command, output).invalid;
}
