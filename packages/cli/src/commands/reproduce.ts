import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSpecFile, git } from "@spc/repo";
import { resolveRepoRoot } from "../context.js";
import {
  checkComparability,
  classifyReproduction,
  commandDigest,
  type ReproductionVerdict,
  type SideEvidence,
} from "../reproduce-compare.js";

/**
 * `spc reproduce <runId>` (specs/reproduce-verification): re-execute
 * a run's recorded verification at its committed result revision and
 * compare the new observations with the originals - reproduced,
 * diverged, not-comparable, or inconclusive per criterion, with the
 * attribution rule that infrastructure in the NEW execution is
 * inconclusive, never divergence. Re-execution RIDES the existing
 * verify --run machinery (spawned, not refactored): disposable
 * worktree at the result revision, dependency preflight, frozen
 * criteria through the executor with host admission, a NEW run
 * record. The original run's records are only ever read - integrity
 * is the bundle machinery's guarantee, reproduction is behavioral,
 * and the two are never conflated.
 */

const CLI = new URL("../dist/main.js", import.meta.url).pathname;

interface EvidenceRecord {
  id?: string;
  criterionId?: string;
  outcome?: string;
  payload?: Record<string, unknown>;
}

function loadEvidence(runDir: string): SideEvidence[] {
  const file = path.join(runDir, "evidence.jsonl");
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as EvidenceRecord)
      .filter((e) => typeof e.criterionId === "string")
      .map((e) => {
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        const outcome =
          e.outcome === "supports" || e.outcome === "contradicts" || e.outcome === "inconclusive"
            ? e.outcome
            : undefined;
        return {
          criterionId: e.criterionId as string,
          evidenceId: typeof e.id === "string" ? e.id : undefined,
          outcome,
          failureShape: typeof payload["failureShape"] === "string" ? payload["failureShape"] : undefined,
          command: typeof payload["command"] === "string" ? payload["command"] : undefined,
        } satisfies SideEvidence;
      });
  } catch {
    return [];
  }
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

export async function runReproduceCommand(runId: string, opts?: { json?: boolean; cwd?: string }): Promise<number> {
  const repoRoot = resolveRepoRoot(opts?.cwd);
  const runDir = path.join(repoRoot, ".spc", "runs", runId);
  if (!existsSync(path.join(runDir, "metadata.json"))) {
    console.error(`error SPC_RUN_NOT_FOUND: no run ${runId} under ${path.join(repoRoot, ".spc", "runs")}`);
    return 2;
  }
  const meta = JSON.parse(readFileSync(path.join(runDir, "metadata.json"), "utf8")) as {
    specId: string;
    specDigest?: string;
  };
  const stateFile = path.join(runDir, "state.json");
  const state = existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, "utf8")) as { resultRevision?: string })
    : {};
  if (!state.resultRevision) {
    console.error(`error REPRO_NO_RESULT: run ${runId} has no committed result revision to reproduce`);
    return 2;
  }
  const resultRevision = state.resultRevision;

  const originalEvidence = loadEvidence(runDir);

  // Preflight (REPRO-002): the frozen definitions at the result
  // revision and the execution prerequisites, every mismatch named.
  const frozen = specAtRevision(repoRoot, resultRevision, meta.specId);
  const pnpmAvailable = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0;
  const comparability = checkComparability({
    recordedSpecDigest: meta.specDigest ?? "sha256:unrecorded",
    specDigestAtRevision: frozen?.digest,
    originalCriteria: originalEvidence.map((e) => e.criterionId),
    frozenCriteria: frozen?.criteria ?? [],
    prerequisites: { node: true, pnpm: pnpmAvailable },
  });

  if (!comparability.comparable && frozen === undefined) {
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
  const newRuns = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => !before.has(d)) : [];
  const freshRunId = newRuns.find((d) => d.startsWith("v-")) ?? newRuns[0];
  if (!freshRunId) {
    console.error(`error REPRO_NO_RERUN: verify --run produced no new run record; its output follows\n${childOut}`);
    return 2;
  }
  const freshEvidence = loadEvidence(path.join(runsDir, freshRunId));

  // Comparison per ORIGINAL criterion (REPRO-003).
  const rows = originalEvidence.map((original) => {
    const fresh = freshEvidence.find((f) => f.criterionId === original.criterionId);
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
          }
        : undefined,
      ...(original.command ? { commandDigest: commandDigest(original.command) } : {}),
    };
  });
  const counts = { reproduced: 0, diverged: 0, "not-comparable": 0, inconclusive: 0 } as Record<string, number>;
  for (const row of rows) counts[row.verdict]++;

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
    return counts["diverged"] > 0 ? 1 : 0;
  }

  console.log(`reproduce ${runId} -> ${freshRunId} at ${resultRevision.slice(0, 12)}`);
  if (!comparability.comparable) {
    console.log(`comparability: PARTIAL - ${comparability.reasons.join("; ")}`);
  }
  for (const row of rows) {
    const freshOut = row.fresh ? row.fresh.outcome : "(absent)";
    console.log(
      `  ${row.id}  ${row.verdict}  (${row.original.outcome} -> ${freshOut})  original ${row.original.evidenceId}  fresh ${row.fresh?.evidenceId ?? "(absent)"}${row.commandDigest ? `  command ${row.commandDigest.slice(0, 19)}` : ""}`,
    );
  }
  console.log(
    `summary: ${counts["reproduced"]} reproduced, ${counts["diverged"]} diverged, ${counts["not-comparable"]} not-comparable, ${counts["inconclusive"]} inconclusive`,
  );
  return counts["diverged"] > 0 ? 1 : 0;
}
