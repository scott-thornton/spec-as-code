import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { git } from "@spc/repo";

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

export type OracleClassification =
  | { kind: "unreferenced" }
  | { kind: "referenced"; files: string[] }
  | { kind: "unsupported"; reason: string };

/** Segment rank for worst-segment-wins: unsupported dominates. */
const RANK: Record<OracleClassification["kind"], number> = { unsupported: 3, referenced: 2, unreferenced: 1 };

function classifySegment(segment: string, packageDirs: Map<string, string>): OracleClassification {
  const tokens = segment.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === undefined || tokens[0] === "") {
    return { kind: "unreferenced" }; // empty segment: nothing to execute
  }
  // pnpm segments: --filter resolution
  if (tokens[0] === "pnpm") {
    const filterIdx = tokens.findIndex((t) => t === "--filter" || t.startsWith("--filter="));
    if (filterIdx === -1) {
      return { kind: "unsupported", reason: "pnpm without --filter: instrument discovery-defined" };
    }
    const spec = tokens[filterIdx] === "--filter" ? tokens[filterIdx + 1] : tokens[filterIdx]!.slice("--filter=".length);
    const pkg = (spec ?? "").replace(/\.{2,}$/, "");
    const dir = pkg !== "" ? packageDirs.get(pkg) : undefined;
    const rest = tokens.slice(filterIdx + (tokens[filterIdx] === "--filter" ? 2 : 1)).join(" ");
    // vitest run <file...>
    const vitest = /\bvitest\s+run\b/.exec(rest);
    if (vitest) {
      const after = rest.slice(vitest.index! + vitest[0].length);
      const files = [...after.matchAll(/(?:^|\s)([\w./-]+\.test\.[cm]?[jt]sx?)/g)].map((m) => m[1]!);
      if (files.length === 0) {
        return { kind: "unsupported", reason: "vitest run without explicit test files: discovery-defined" };
      }
      if (dir === undefined) {
        return { kind: "unsupported", reason: `--filter ${pkg} does not resolve to a workspace directory` };
      }
      return { kind: "referenced", files: files.map((f) => path.posix.join(dir, f)) };
    }
    if (/\bexec\s+node\b/.test(rest)) {
      const m = /(?:^|\s)([\w./-]+\.[cm]?js)\b/.exec(rest);
      if (m && dir !== undefined && !m[1]!.startsWith("/")) {
        return { kind: "referenced", files: [path.posix.join(dir, m[1]!)] };
      }
      if (m && m[1]!.startsWith("/")) {
        return { kind: "referenced", files: [m[1]!.slice(1)] };
      }
    }
    if (/\btest\b/.test(rest) || /\brun\s+\S+/.test(rest)) {
      // package test scripts / run scripts: the instrument is the
      // script definition (package.json) + discovery - unsupported.
      return { kind: "unsupported", reason: "package script execution: instrument is script-defined, not command-only" };
    }
    return { kind: "unreferenced" }; // e.g. bare pnpm --filter X with no execution
  }
  // node-executed repo scripts: referenced
  if (tokens[0] === "node") {
    const m = /^"?([\w./-]+\.[cm]?js)"?/.exec(tokens[1] ?? "");
    if (m && !tokens.slice(1).join(" ").startsWith("-e")) {
      return { kind: "referenced", files: [m[1]!] };
    }
    return { kind: "unreferenced" }; // node -e / node (REPL): command-only
  }
  // Positively command-only shell: test/[: -f checks observe, don't execute repo files
  if (tokens[0] === "test" || tokens[0] === "[") {
    return { kind: "unreferenced" };
  }
  // Everything else: unsupported (fail closed)
  return { kind: "unsupported", reason: `grammar not classified: ${tokens[0]}` };
}

export function classifyCommandOracle(command: string, packageDirs: Map<string, string>): OracleClassification {
  const segments = command.trim().split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  const classified = segments.map((s) => classifySegment(s, packageDirs));
  if (classified.length === 0) return { kind: "unreferenced" };
  let worst = classified[0]!;
  for (const c of classified) {
    if (RANK[c.kind] > RANK[worst.kind]) worst = c;
  }
  // Referenced compounds merge their file lists.
  if (worst.kind === "referenced") {
    const files = classified.flatMap((c) => (c.kind === "referenced" ? c.files : []));
    return { kind: "referenced", files: [...new Set(files)] };
  }
  return worst;
}

export interface OracleFileSnapshot {
  path: string;
  digest: string;
}

export interface OracleSnapshot {
  criterionDigest?: string;
  revision: string;
  files: OracleFileSnapshot[];
}

/** Snapshot the referenced oracle files AT a revision (hardened git
 *  adapter; never the working tree). null = command-only (positively
 *  unreferenced); undefined = classification fail-closed. */
export function oracleSnapshotAt(
  repoRoot: string,
  revision: string,
  command: string,
  packageDirs: Map<string, string>,
): OracleSnapshot | null | undefined {
  const classification = classifyCommandOracle(command, packageDirs);
  if (classification.kind === "unreferenced") return null;
  if (classification.kind === "unsupported") return undefined;
  const files: OracleFileSnapshot[] = [];
  for (const file of classification.files) {
    const show = git(repoRoot, ["show", `${revision}:${file}`]);
    if (!show.ok) return undefined; // unresolved at this revision: fail closed
    files.push({ path: file, digest: "sha256:" + createHash("sha256").update(show.stdout, "utf8").digest("hex") });
  }
  return { revision, files };
}

export type OracleComparison =
  | { status: "unreferenced" }
  | { status: "matched"; files: { path: string; digest: string }[] }
  | { status: "drifted"; files: { path: string; redDigest: string; greenDigest: string }[] }
  | { status: "unresolved"; files: { path: string; reason: string }[] };

export function compareOracleSnapshots(red?: OracleSnapshot | null, green?: OracleSnapshot | null): OracleComparison {
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
        `Synthesis rejected: oracle ${word}`,
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
    return rejectedDecision({ reason: "oracle-drift", paths, redRevision: red.revision, greenRevision: green.revision });
  }
  return rejectedDecision({ reason: "oracle-unresolved", paths, redRevision: red.revision, greenRevision: green.revision });
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
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^\s*-\s+id:/.test(lines[j]!)) break; // next criterion
        if (/^\s*discriminating:\s*true/.test(lines[j]!)) {
          disc = true;
          break;
        }
        if (/^\s*(command|type):/.test(lines[j]!)) break;
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
