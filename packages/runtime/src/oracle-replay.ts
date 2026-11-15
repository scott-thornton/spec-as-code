import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSpecFile, createWorktree, git, removeWorktree } from "@spc/repo";
import { verifyProperties } from "./verify.js";
import { EventStore } from "./events.js";
import { EvidenceStore, FollowupStore } from "./stores.js";
import { loadConfig } from "./run.js";
import { spcPaths } from "./paths.js";
import { classifyCommandOracle, oracleSnapshotAt } from "./oracle-identity.js";

/**
 * The same-oracle counterfactual replay engine (specs/
 * oracle-identity-replay, OIR-002; the operator's ruling, slice 3).
 * When a run's own changes touched a discriminating criterion's
 * oracle files, the in-run red -> green flip crossed instrument
 * drift: the changeset explains the transition, it does not validate
 * the measurement. The replay asks the ruling's question - would the
 * FINAL oracle have failed against the BASE implementation? - by
 * cutting an isolated worktree at the base revision, overlaying the
 * final oracle file contents onto it, and executing the criterion
 * through the frozen machinery (scratch stores, admission inherited
 * by construction). Contradicted (red) establishes the flip with
 * counterfactualFlip provenance; supported (green) or inconclusive
 * renders indeterminate - never an unqualified acceptance.
 */

export interface OracleDrift {
  status: "untouched" | "drifted" | "held-fail-closed";
  files: string[];
}

/** Did the run's own changes (base -> result) touch any oracle file
 *  the criterion's command references? Unsupported classifications
 *  hold for replay conservatively (fail closed). */
export async function referencedOracleDiff(
  repoRoot: string,
  baseRevision: string,
  resultRevision: string,
  command: string,
  packageDirs: Map<string, string>,
): Promise<OracleDrift> {
  const classification = classifyCommandOracle(command, packageDirs);
  if (classification.kind === "unreferenced") return { status: "untouched", files: [] };
  if (classification.kind === "unsupported") return { status: "held-fail-closed", files: [] };
  // Globs resolve against each revision's tree; a changed membership
  // IS drift (the instrument set changed).
  const { expandOracleFiles } = await import("@spc/repo");
  const baseFiles = expandOracleFiles(repoRoot, baseRevision, classification.files);
  const resultFiles = expandOracleFiles(repoRoot, resultRevision, classification.files);
  if (baseFiles === undefined || resultFiles === undefined) {
    return { status: "held-fail-closed", files: classification.files };
  }
  if (JSON.stringify(baseFiles) !== JSON.stringify(resultFiles)) {
    return { status: "drifted", files: [...new Set([...baseFiles, ...resultFiles])] };
  }
  const drifted: string[] = [];
  for (const file of baseFiles) {
    const base = git(repoRoot, ["show", `${baseRevision}:${file}`]);
    const result = git(repoRoot, ["show", `${resultRevision}:${file}`]);
    if (!base.ok || !result.ok) {
      // A file that does not resolve at either revision: the anchor
      // set is incomplete - hold for replay (fail closed).
      return { status: "held-fail-closed", files: baseFiles };
    }
    if (base.stdout !== result.stdout) drifted.push(file);
  }
  return drifted.length > 0 ? { status: "drifted", files: drifted } : { status: "untouched", files: [] };
}

export interface ReplayResult {
  outcome: "red" | "green" | "unavailable";
  overlaid: string[];
  detail: string;
}

/** Replay the FINAL oracle (at resultRevision) against the BASE
 *  implementation (worktree cut at baseRevision, oracle files
 *  overlaid). The criterion executes through the frozen machinery. */
export async function runCounterfactualReplay(
  repoRoot: string,
  specId: string,
  criterionId: string,
  command: string,
  baseRevision: string,
  resultRevision: string,
  packageDirs: Map<string, string>,
): Promise<ReplayResult> {
  const classification = classifyCommandOracle(command, packageDirs);
  if (classification.kind !== "referenced") {
    return { outcome: "unavailable", overlaid: [], detail: `classification ${classification.kind}: no oracle set to replay` };
  }
  const worktreesDir = path.join(repoRoot, ".spc", "worktrees");
  const name = `replay-${criterionId}-${Date.now()}`;
  let worktree: string | null = null;
  try {
    worktree = createWorktree(repoRoot, specId, name, worktreesDir, { startPoint: baseRevision }).path;
    // Overlay the FINAL oracle contents onto the base worktree.
    for (const file of classification.files) {
      const result = git(repoRoot, ["show", `${resultRevision}:${file}`]);
      if (!result.ok) {
        return { outcome: "unavailable", overlaid: [], detail: `oracle file ${file} unreadable at ${resultRevision.slice(0, 8)}` };
      }
      const target = path.join(worktree, file);
      mkdirSync(path.dirname(target), { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(target, result.stdout, "utf8");
    }
    // A minimal single-criterion spec wrapping the command, compiled
    // in a scratch file (the challenge engine's runCriterion pattern).
    const scratch = mkdtempSync(path.join(os.tmpdir(), "spc-replay-"));
    try {
      const specYaml = [
        "apiVersion: spc.dev/v1alpha1",
        "kind: Spec",
        "metadata:",
        `  id: ${specId}`,
        "  title: replay",
        "goal: >",
        "  replay",
        "requirements:",
        "  - id: R-001",
        "    statement: s",
        "    priority: must",
        "    acceptance:",
        `      - id: ${criterionId}`,
        "        type: command",
        `        command: ${JSON.stringify(command)}`,
        "        expect: {exitCode: 0}",
        "",
      ].join("\n");
      const specFile = path.join(scratch, "spec.yaml");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(specFile, specYaml, "utf8");
      const compiled = compileSpecFile(specFile);
      if (!compiled.ok || !compiled.ir) {
        return { outcome: "unavailable", overlaid: classification.files, detail: "replay spec does not compile" };
      }
      const property = compiled.ir.properties.find((p) => p.acceptance.some((c) => c.id === criterionId));
      if (!property) {
        return { outcome: "unavailable", overlaid: classification.files, detail: "criterion not found in replay spec" };
      }
      const acceptance = property.acceptance.filter((c) => c.id === criterionId);
      const now = () => new Date().toISOString();
      const stores = path.join(scratch, "stores");
      mkdirSync(stores, { recursive: true });
      const events = new EventStore(path.join(stores, "events.jsonl"), "replay", now);
      const evidence = new EvidenceStore(path.join(stores, "evidence.jsonl"));
      const followups = new FollowupStore(path.join(stores, "followups.json"));
      const config = loadConfig(spcPaths(worktree).configPath);
      const sweep = await verifyProperties({
        properties: [{ ...property, acceptance }],
        runId: "replay",
        cwd: worktree,
        revision: baseRevision,
        config,
        provider: null,
        events,
        evidence,
        followups,
      });
      const state = sweep.states[0];
      if (state?.status === "unsatisfied") return { outcome: "red", overlaid: classification.files, detail: "the final oracle, against the base implementation, is contradicted" };
      if (state?.status === "satisfied") return { outcome: "green", overlaid: classification.files, detail: "green -> green: the oracle change produced the flip" };
      return { outcome: "unavailable", overlaid: classification.files, detail: `replay inconclusive: ${state?.reason ?? state?.status ?? "unknown"}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } catch (e) {
    return { outcome: "unavailable", overlaid: [], detail: `replay failed: ${(e as Error).message}` };
  } finally {
    if (worktree) {
      try {
        removeWorktree(repoRoot, worktree);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

void readFileSync;
