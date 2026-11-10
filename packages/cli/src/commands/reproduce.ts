import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSpecFile, git } from "@spc/repo";
import { resolveRepoRoot } from "../context.js";
import {
  checkComparability,
  classifyReproduction,
  commandDigest,
  latestByCriterion,
  type ReproductionVerdict,
  type SideEvidence,
} from "../reproduce-compare.js";

/**
 * `spc reproduce <runId>` (specs/reproduce-verification): re-execute
 * a run's recorded verification at its committed result revision and
 * compare the new observations with the originals - reproduced,
 * diverged, not-comparable, or inconclusive per criterion, with the
 * attribution rule that infrastructure (or a cache replay) in the NEW
 * execution is inconclusive, never divergence. Re-execution RIDES the
 * existing verify --run machinery (spawned, not refactored): worktree
 * at the result revision, dependency preflight, frozen criteria with
 * host admission, a NEW run record. The original run's records are
 * only ever read - integrity is the bundle machinery's guarantee,
 * reproduction is behavioral, and the two are never conflated.
 */

const CLI = new URL("../main.js", import.meta.url).pathname;

interface EvidenceRecord {
  id?: string;
  criterionId?: string;
  outcome?: string;
  phase?: string;
  payload?: Record<string, unknown>;
}

/** Parse per-line (bad lines counted and warned, never silently
 *  discarded), then collapse to the LATEST non-red record per
 *  criterion - the evaluator's own satisfaction semantics. */
function loadEvidence(runDir: string): { latest: Map<string, SideEvidence>; badLines: number } {
  const file = path.join(runDir, "evidence.jsonl");
  const latest = new Map<string, SideEvidence>();
  if (!existsSync(file)) return { latest, badLines: 0 };
  let badLines = 0;
  const records: SideEvidence[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as EvidenceRecord;
      if (typeof e.criterionId !== "string") continue;
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      records.push({
        criterionId: e.criterionId,
        evidenceId: typeof e.id === "string" ? e.id : undefined,
        outcome:
          e.outcome === "supports" || e.outcome === "contradicts" || e.outcome === "inconclusive"
            ? e.outcome
            : undefined,
        failureShape: typeof payload["failureShape"] === "string" ? payload["failureShape"] : undefined,
        command: typeof payload["command"] === "string" ? payload["command"] : undefined,
        ...(typeof payload["reusedFrom"] === "string" ? { reusedFrom: payload["reusedFrom"] } : {}),
        ...(e.phase === "red" ? { phase: "red" } : {}),
      } as SideEvidence);
    } catch {
      badLines++;
    }
  }
  return { latest: latestByCriterion(records), badLines };
}

/** Compile the spec with `specId` as it existed at `revision` (git
 *  ls-tree + show + compile) and return its digest and criterion ids -
 *  the frozen definitions the run actually ran. */
function specAtRevision(
  repoRoot: string,
  revision: string,
  specId: string,
): { digest: string; criteria: string[] } | undefined {
  const tree = git(repoRoot, ["ls-tree", "-r", "--name-only", revision, "specs/"]);
  if (!tree.ok) return undefined;
  const candidates = tree.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const scratch = path.join(repoRoot, ".spc", "worktrees");
  for (const file of candidates) {
    const show = git(repoRoot, ["show", `${revision}:${file}`]);
    if (!show.ok) continue;
    const tmp = path.join(scratch, `.repro-spec-${revision.slice(0, 8)}.yaml`);
    try {
      mkdirSync(scratch, { recursive: true });
      writeFileSync(tmp, show.stdout, "utf8");
      const compiled = compileSpecFile(tmp);
      if (!compiled.ok || !compiled.ir || compiled.ir.spec.metadata.id !== specId) continue;
      const criteria: string[] = [];
      for (const property of compiled.ir.properties) {
        for (const criterion of property.acceptance) criteria.push(criterion.id);
      }
      return { digest: compiled.ir.digest, criteria };
    } catch {
      // unreadable candidate: next
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return undefined;
}

/** The CURRENT tree's compiled digest for the spec - the text the
 *  child will actually execute. */
function currentSpecDigest(repoRoot: string, specId: string): string | undefined {
  const specsDir = path.join(repoRoot, "specs");
  if (!existsSync(specsDir)) return undefined;
  for (const f of readdirSync(specsDir).sort()) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    try {
      const compiled = compileSpecFile(path.join(specsDir, f));
      if (compiled.ok && compiled.ir && compiled.ir.spec.metadata.id === specId) return compiled.ir.digest;
    } catch {
      // unreadable candidate: next
    }
  }
  return undefined;
}

export async function runReproduceCommand(runId: string, opts?: { json?: boolean; cwd?: string }): Promise<number> {
  const repoRoot = resolveRepoRoot(opts?.cwd);
  const runDir = path.join(repoRoot, ".spc", "runs", runId);
  if (!existsSync(path.join(runDir, "metadata.json"))) {
    console.error(`error SPC_RUN_NOT_FOUND: no run ${runId} under ${path.join(repoRoot, ".spc", "runs")}`);
    return 2;
  }
  let meta: { specId: string; specDigest?: string };
  try {
    meta = JSON.parse(readFileSync(path.join(runDir, "metadata.json"), "utf8")) as { specId: string; specDigest?: string };
  } catch (e) {
    console.error(`error SPC_RUN_NOT_FOUND: run ${runId} has an unreadable metadata.json (${(e as Error).message})`);
    return 2;
  }
  const stateFile = path.join(runDir, "state.json");
  let state: { resultRevision?: string } = {};
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, "utf8")) as { resultRevision?: string };
    } catch (e) {
      console.error(`error REPRO_NO_RESULT: run ${runId} has an unreadable state.json (${(e as Error).message})`);
      return 2;
    }
  }
  if (!state.resultRevision) {
    console.error(`error REPRO_NO_RESULT: run ${runId} has no committed result revision to reproduce`);
    return 2;
  }
  const resultRevision = state.resultRevision;

  const { latest: originalLatest, badLines } = loadEvidence(runDir);
  if (originalLatest.size === 0) {
    console.error(
      `error REPRO_NO_EVIDENCE: run ${runId} has no recorded evidence to compare${badLines > 0 ? ` (${badLines} unparseable line(s))` : ""} - never a vacuous report`,
    );
    return 2;
  }
  if (badLines > 0) {
    console.error(`warning: ${badLines} unparseable evidence line(s) in run ${runId} were skipped and named here`);
  }
  const originalEvidence = [...originalLatest.values()];

  // Preflight (REPRO-002): the frozen definitions at the result
  // revision, the CURRENT text the child will execute, and the
  // prerequisites - every mismatch named.
  const frozen = specAtRevision(repoRoot, resultRevision, meta.specId);
  const pnpmAvailable = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0;
  const comparability = checkComparability({
    ...(meta.specDigest !== undefined ? { recordedSpecDigest: meta.specDigest } : {}),
    ...(frozen !== undefined ? { specDigestAtRevision: frozen.digest } : {}),
    ...(frozen !== undefined ? { currentSpecDigest: currentSpecDigest(repoRoot, meta.specId) } : {}),
    originalCriteria: originalEvidence.map((e) => e.criterionId),
    frozenCriteria: frozen?.criteria ?? [],
    prerequisites: { node: true, pnpm: pnpmAvailable },
  });

  if (frozen === undefined) {
    // The spec itself does not resolve at the revision: nothing can be
    // re-executed - a named not-comparable report, never a guess.
    if (opts?.json) {
      console.log(JSON.stringify({ runId, comparable: false, reasons: comparability.reasons, criteria: [] }, null, 2));
    } else {
      console.error(`reproduce ${runId}: NOT COMPARABLE - the spec cannot be resolved at ${resultRevision.slice(0, 12)}`);
      for (const reason of comparability.reasons) console.error(`  - ${reason}`);
    }
    return 1;
  }

  // Re-execution through the existing machinery (spawned verbatim):
  // worktree at the result revision, dependency preflight, frozen
  // criteria with host admission, a NEW run record.
  const runsDir = path.join(repoRoot, ".spc", "runs");
  const before = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
  const rerun = spawnSync(process.execPath, [CLI, "verify", "--run", runId, "--cwd", repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 600_000,
    env: process.env,
  });
  const childOut = `${rerun.stdout ?? ""}${rerun.stderr ?? ""}`;
  if (opts?.json !== true && childOut.trim() !== "") console.log(childOut.trimEnd());
  if (rerun.status === null || rerun.error) {
    console.error(
      `error REPRO_NO_RERUN: the verify --run child died (${rerun.error ? rerun.error.message : "no exit"}) - a partial re-execution is never dressed as complete; its output follows\n${childOut}`,
    );
    return 2;
  }
  const newRuns = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => !before.has(d)) : [];
  const newVerifyRuns = newRuns.filter((d) => d.startsWith("v-"));
  if (newVerifyRuns.length > 1) {
    console.error(
      `error REPRO_AMBIGUOUS_RERUN: ${newVerifyRuns.length} verification runs appeared (${newVerifyRuns.join(", ")}) - ownership cannot be established; refusing to guess`,
    );
    return 2;
  }
  const freshRunId = newVerifyRuns[0] ?? newRuns[0];
  if (!freshRunId) {
    console.error(`error REPRO_NO_RERUN: verify --run produced no new run record; its output follows\n${childOut}`);
    return 2;
  }
  const { latest: freshLatest } = loadEvidence(path.join(runsDir, freshRunId));

  // Comparison per ORIGINAL criterion (REPRO-003), on the latest
  // non-red record of each side.
  const rows = originalEvidence.map((original) => {
    const fresh = freshLatest.get(original.criterionId);
    const verdict: ReproductionVerdict = classifyReproduction(original, fresh);
    return {
      id: original.criterionId,
      verdict,
      original: {
        evidenceId: original.evidenceId ?? "(none)",
        outcome: original.outcome ?? "(unrecorded)",
        ...(original.failureShape ? { failureShape: original.failureShape } : {}),
      },
      fresh: fresh
        ? {
            evidenceId: fresh.evidenceId ?? "(none)",
            outcome: fresh.outcome ?? "(unrecorded)",
            ...(fresh.failureShape ? { failureShape: fresh.failureShape } : {}),
            ...(fresh.reusedFrom ? { reusedFrom: fresh.reusedFrom } : {}),
          }
        : undefined,
      ...(original.command ? { commandDigest: commandDigest(original.command) } : {}),
      ...(fresh?.command ? { freshCommandDigest: commandDigest(fresh.command) } : {}),
    };
  });
  const counts: Record<string, number> = { reproduced: 0, diverged: 0, "not-comparable": 0, inconclusive: 0 };
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;

  // A report that established nothing (no reproduced row) is not a
  // success, whatever the verdict mix.
  const exitCode = (counts["diverged"] ?? 0) > 0 || ((counts["reproduced"] ?? 0) === 0 && rows.length > 0) ? 1 : 0;

  if (opts?.json) {
    console.log(
      JSON.stringify(
        {
          runId,
          freshRunId,
          revision: resultRevision,
          comparable: comparability.comparable,
          ...(comparability.reasons.length > 0 ? { reasons: comparability.reasons } : {}),
          criteria: rows,
        },
        null,
        2,
      ),
    );
    return exitCode;
  }

  console.log(`reproduce ${runId} -> new verification run ${freshRunId} at ${resultRevision.slice(0, 12)}`);
  if (!comparability.comparable) {
    console.log(`comparability: PARTIAL - ${comparability.reasons.join("; ")}`);
  }
  for (const row of rows) {
    const freshOut = row.fresh ? row.fresh.outcome : "(absent)";
    const reused = row.fresh?.reusedFrom ? " (cache replay)" : "";
    console.log(
      `  ${row.id}  ${row.verdict}  (${row.original.outcome} -> ${freshOut}${reused})  original ${row.original.evidenceId}  fresh ${row.fresh?.evidenceId ?? "(absent)"}${row.commandDigest ? `  command ${row.commandDigest.slice(0, 19)}` : ""}`,
    );
  }
  console.log(
    `summary: ${counts["reproduced"] ?? 0} reproduced, ${counts["diverged"] ?? 0} diverged, ${counts["not-comparable"] ?? 0} not-comparable, ${counts["inconclusive"] ?? 0} inconclusive`,
  );
  return exitCode;
}
