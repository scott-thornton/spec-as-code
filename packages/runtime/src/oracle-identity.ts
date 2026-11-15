import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Oracle identity (specs/oracle-identity; the operator's 2026-11-14
 * ruling, decision record .spc/reviews/oracle-identity-decision.md).
 * A discriminating flip is the system's core attribution claim: this
 * criterion, as ONE instrument, went red against one implementation
 * state and green against another. The criterion digest pins the
 * command text; this module pins the oracle FILE bytes the command
 * executes. "If provenance changes whether a conclusion is justified,
 * provenance cannot be merely descriptive metadata." Cross-run
 * synthesis with detected oracle drift is REJECTED (candidate
 * preserved, rendered, never establishing); in-run drift demands
 * same-oracle counterfactual replay - "more information should enable
 * a stronger verification procedure, not a weaker acceptance rule."
 * Extraction is five-way and fail-closed: an empty extraction NEVER
 * implicitly means unreferenced.
 */

export {
  classifyCommandOracle,
  oracleSnapshotAt,
  workspacePackageDirs,
  type OracleClassification,
  type OracleFileSnapshot,
  type OracleSnapshot,
} from "@spc/repo";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifyCommandOracle } from "@spc/repo";

export type OracleComparison =
  | { status: "unreferenced" }
  | { status: "matched"; files: { path: string; digest: string }[] }
  | { status: "drifted"; files: { path: string; redDigest: string; greenDigest: string }[] }
  | { status: "unresolved"; files: { path: string; reason: string }[] };

export function compareOracleSnapshots(
  red?: OracleSnapshot | null,
  green?: OracleSnapshot | null,
  resolvable?: (revision: string) => boolean,
): OracleComparison {
  if (resolvable !== undefined) {
    for (const snap of [red, green]) {
      if (snap !== undefined && snap !== null && !resolvable(snap.revision)) {
        return { status: "unresolved", files: [{ path: "(revision)", reason: `revision ${snap.revision.slice(0, 12)} cannot be resolved` }] };
      }
    }
  }
  if (red === undefined || green === undefined) return { status: "unresolved", files: [{ path: "(classification failed closed)", reason: "snapshot unavailable" }] };
  if (red === null && green === null) return { status: "unreferenced" };
  if (red === null || green === null) {
    return { status: "unresolved", files: [{ path: "(mixed)", reason: "one side command-only, the other file-referenced" }] };
  }
  const paths = new Set([...red.files.map((f) => f.path), ...green.files.map((f) => f.path)]);
  const redBy = new Map(red.files.map((f) => [f.path, f.digest]));
  const greenBy = new Map(green.files.map((f) => [f.path, f.digest]));
  const drifted: { path: string; redDigest: string; greenDigest: string }[] = [];
  const matched: { path: string; digest: string }[] = [];
  for (const p of paths) {
    const r = redBy.get(p);
    const g = greenBy.get(p);
    if (r === undefined || g === undefined) {
      return { status: "unresolved", files: [{ path: p, reason: "missing on one side" }] };
    }
    if (r !== g) drifted.push({ path: p, redDigest: r, greenDigest: g });
    else matched.push({ path: p, digest: r });
  }
  if (drifted.length > 0) return { status: "drifted", files: drifted };
  return { status: "matched", files: matched };
}

export interface FlipRejection {
  reason: "oracle-drift" | "oracle-unresolved";
  paths: string[];
  redRunId: string;
  greenRunId: string;
  redRevision: string;
  greenRevision: string;
}

export interface FlipDecision {
  established: boolean;
  provenance: "synthesizedFlip" | "inRunFlip" | "counterfactualFlip" | "indeterminate";
  rejected?: FlipRejection;
  render(): string;
}

function rejectedDecision(rejection: FlipRejection): FlipDecision {
  const word = rejection.reason === "oracle-drift" ? "drift" : "unresolved oracle references";
  return {
    established: false,
    provenance: "indeterminate",
    rejected: rejection,
    render(): string {
      const lines = [
        `Synthesis rejected: oracle ${word} (${rejection.redRunId} -X-> ${rejection.greenRunId})`,
        ...rejection.paths.map((p) => `  ${p} (${rejection.redRevision.slice(0, 8)} -> ${rejection.greenRevision.slice(0, 8)})`),
        "  historical evidence retained; the observations cannot establish a discriminating transition",
      ];
      return lines.join("\n");
    },
  };
}

export function evaluateSynthesisCandidate(
  red: { runId: string; revision: string },
  green: { runId: string; revision: string },
  comparison: OracleComparison,
): FlipDecision {
  if (comparison.status === "matched" || comparison.status === "unreferenced") {
    return {
      established: true,
      provenance: "synthesizedFlip",
      render(): string {
        return `flip established ${red.runId} -> ${green.runId} (chain inheritance; oracle identity: ${comparison.status})`;
      },
    };
  }
  const paths = comparison.files.map((f) => f.path);
  if (comparison.status === "drifted") {
    return rejectedDecision({ reason: "oracle-drift", paths, redRunId: red.runId, greenRunId: green.runId, redRevision: red.revision, greenRevision: green.revision });
  }
  return rejectedDecision({ reason: "oracle-unresolved", paths, redRunId: red.runId, greenRunId: green.runId, redRevision: red.revision, greenRevision: green.revision });
}

export function evaluateInRunFlip(state: { drifted: boolean }, replayOutcome: "red" | "green" | "unavailable"): FlipDecision {
  if (!state.drifted) {
    return { established: true, provenance: "inRunFlip", render: () => "in-run flip (oracle unchanged)" };
  }
  if (replayOutcome === "red") {
    return {
      established: true,
      provenance: "counterfactualFlip",
      render: () => "counterfactual flip: the final oracle, replayed against the base implementation, went red -> green",
    };
  }
  return {
    established: false,
    provenance: "indeterminate",
    render: () =>
      replayOutcome === "green"
        ? "counterfactual replay: green -> green - the implementation change is not demonstrated by this criterion"
        : "counterfactual replay unavailable - indeterminate",
  };
}

/** The classification audit over every command criterion in specs/:
 *  the measured distribution, pinned by oracle. */
export function auditSpecsClassification(
  repoRoot: string,
  packageDirs: Map<string, string>,
  now: () => Date = () => new Date(),
): {
  totalCommands: number;
  byFlag: Record<"discriminating" | "guard", Record<"referenced" | "unreferenced" | "unsupported" | "unresolved", number>>;
} {
  void now;
  const byFlag = {
    discriminating: { referenced: 0, unreferenced: 0, unsupported: 0, unresolved: 0 },
    guard: { referenced: 0, unreferenced: 0, unsupported: 0, unresolved: 0 },
  };
  let totalCommands = 0;
  const specsDir = path.join(repoRoot, "specs");
  if (!existsSync(specsDir)) return { totalCommands, byFlag };
  for (const f of readdirSync(specsDir).sort()) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const text = readFileSync(path.join(specsDir, f), "utf8");
    // Lightweight criterion walk: every command: line is a criterion
    // command; the discriminating flag is the nearest preceding
    // `discriminating: true` within the same acceptance block.
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*command:\s*(.+)$/.exec(lines[i]!);
      if (!m) continue;
      const command = m[1]!.trim();
      // Look ahead for the discriminating flag (it follows command in
      // the house layout: command, expect, discriminating).
      let disc = false;
      const isBoundary = (l: string): boolean => /^\s*(-\s+id:|requirements:|constraints:|acceptance:|statement:)/.test(l);
      for (let j = i + 1; j < Math.min(i + 8, lines.length) && !isBoundary(lines[j]!); j++) {
        if (/discriminating:\s*true/.test(lines[j]!)) {
          disc = true;
          break;
        }
      }
      if (!disc) {
        for (let j = i - 1; j >= Math.max(0, i - 8) && !isBoundary(lines[j]!); j--) {
          if (/discriminating:\s*true/.test(lines[j]!)) {
            disc = true;
            break;
          }
        }
      }
      totalCommands += 1;
      const c = classifyCommandOracle(command, packageDirs);
      const bucket = disc ? byFlag.discriminating : byFlag.guard;
      if (c.kind === "referenced") bucket.referenced += 1;
      else if (c.kind === "unreferenced") bucket.unreferenced += 1;
      else bucket.unsupported += 1; // unsupported subsumes unresolved-at-audit
    }
  }
  return { totalCommands, byFlag };
}
