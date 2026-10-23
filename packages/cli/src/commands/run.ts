import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { compileSpecFile, diffStat, git } from "@spc/repo";
import { renderPrDraft } from "@spc/renderer";
import { cancelRun, exportRun, loadRunView, replayRun, resolveChain, runSupersede, supersededByLookup } from "@spc/runtime";
import { loadRunMeta as loadRunMetaFromRuntime } from "@spc/runtime";
import { resolveRepoRoot } from "../context.js";

/** `spc run show <runId>` - reconstruct what happened, without chat logs. */
/** `spc run supersede <runId> --by <runId>`: administrative replacement. */
export function runSupersedeCommand(runId: string, byRunId: string, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const result = runSupersede(repoRoot, runId, byRunId);
  console.log(`Recorded: run ${result.byRunId} supersedes run ${result.supersededRunId} (administrative replacement - no ancestry, no evidence inheritance, no verdict rewrite).`);
  return 0;
}

export function runShow(runId: string, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const view = loadRunView(path.join(repoRoot, ".spc", "runs"), runId);
  if (!view) {
    throw new SpcError("RUN_NOT_FOUND", `run ${runId} not found under ${path.join(repoRoot, ".spc", "runs")}`);
  }
  const summaryFile = path.join(repoRoot, ".spc", "runs", runId, "summary.md");
  if (existsSync(summaryFile)) {
    console.log(readFileSync(summaryFile, "utf8"));
  } else {
    console.log(`Run ${runId}: status ${view.state.status} (no summary written yet)`);
  }
  const supersededBy = supersededByLookup(path.join(repoRoot, ".spc", "runs"), runId);
  if (supersededBy) {
    console.log(`\nSuperseded by ${supersededBy} (administrative replacement; this run's records are kept, never inherited)`);
  }
  console.log(`\nRun directory: ${path.join(repoRoot, ".spc", "runs", runId)}`);
  return 0;
}

/** `spc run pr <runId>` - generate a PR title/body from run records (§82). */
export function runPr(runId: string, options: { cwd?: string; out?: string }): number {
  const repoRoot = resolveRepoRoot(options.cwd);
  const view = loadRunView(path.join(repoRoot, ".spc", "runs"), runId);
  if (!view) {
    throw new SpcError("RUN_NOT_FOUND", `run ${runId} not found under ${path.join(repoRoot, ".spc", "runs")}`);
  }
  const specFile = findSpecFileForRun(repoRoot, view.meta.specId);
  const specIr = specFile ? compileSpecFile(specFile).ir : null;
  if (!specIr) {
    throw new SpcError("SPEC_NOT_FOUND", `spec ${view.meta.specId} not found under ${path.join(repoRoot, "specs")}`);
  }
  // Chain verdict first (approved ruling): the PR claims what the CHAIN
  // establishes, then the diff - and the two are separated, with any
  // linked-run result not contained in this branch flagged.
  const chain = resolveChain(path.join(repoRoot, ".spc", "runs"), runId);
  let chainHeader = "";
  if (chain.length > 1) {
    const musts = specIr.properties.filter((pp) => pp.priority === "must");
    const ok = musts.filter((pp) => {
      const r = view.state.requirements?.[pp.id];
      return r?.status === "satisfied" || r?.status === "waived";
    }).length;
    const inherited = Object.values(view.state.requirements ?? {}).filter((r) => (r.reason ?? "").includes("established by prior run")).length;
    const lines = [
      `**Chain: ${chain.length} linked runs, combined ${ok}/${musts.length} must satisfied** (${ok - inherited} newly in this run, ${inherited} inherited from chain)`,
      "",
      "| Run | Contribution |",
      "| --- | --- |",
    ];
    for (const c of chain) {
      lines.push(`| ${c.runId} | ${c.runId === runId ? "this PR" : "prior evidence"} |`);
    }
    const missing = chain
      .filter((c) => c.runId !== runId)
      .filter((c) => {
        const st = path.join(repoRoot, ".spc", "runs", c.runId, "state.json");
        try {
          const rev = (JSON.parse(readFileSync(st, "utf8")) as { resultRevision?: string }).resultRevision;
          return !rev || !git(repoRoot, ["merge-base", "--is-ancestor", rev, "HEAD"]).ok;
        } catch {
          return true;
        }
      });
    if (missing.length > 0) {
      lines.push("", `> Note: chain evidence includes ${missing.map((m) => m.runId).join(", ")} whose result revisions are NOT contained in this branch - the cumulative verdict and this diff are not the same claim.`);
    }
    chainHeader = lines.join("\n") + "\n\n";
  }
  const draft = renderPrDraft({
    specIr,
    runState: view.state,
    followups: view.followups,
    evidence: view.evidence,
    ...(view.state.baseRevision && view.state.resultRevision
      ? { diffStat: diffStat(repoRoot, view.state.baseRevision, view.state.resultRevision).trim() || undefined }
      : {}),
  });
  const body = `# ${draft.title}\n\n${chainHeader}${draft.body}\n`;
  if (options.out) {
    writeFileSync(options.out, body, "utf8");
    console.log(`PR draft written to ${options.out}`);
  } else {
    console.log(body);
  }
  console.log("Humans decide whether to open/merge; nothing is posted automatically.");
  return 0;
}

function findSpecFileForRun(repoRoot: string, specId: string): string | null {
  const specsDir = path.join(repoRoot, "specs");
  if (!existsSync(specsDir)) return null;
  for (const entry of readdirSync(specsDir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const file = path.join(specsDir, entry);
    const r = compileSpecFile(file);
    if (r.ok && r.ir?.spec.metadata.id === specId) return file;
  }
  return null;
}

/** `spc run cancel <runId>` - make an interrupted run's terminal state truthful. */
export function runCancel(runId: string, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const state = cancelRun(repoRoot, runId);
  console.log(`Run ${runId} cancelled (was running; task states preserved).`);
  console.log(`Run directory: ${path.join(repoRoot, ".spc", "runs", runId)}`);
  void state;
  return 0;
}

/** `spc run export <runId>`: self-contained evidence bundle. */
export function runExport(runId: string, options: { out?: string; cwd?: string }): number {
  const repoRoot = resolveRepoRoot(options.cwd);
  const result = exportRun(repoRoot, runId, options.out);
  for (const warning of result.warnings) {
    console.log(`warning: ${warning}`);
  }
  console.log(`Exported run ${runId} to ${path.relative(process.cwd(), result.dir)}`);
  console.log(`Manifest:   ${path.relative(process.cwd(), result.manifestPath)}`);
  console.log("The bundle is self-contained (spec, plan, events, evidence, diff, hashes);");
  console.log("verify integrity by checking component sha256 values against manifest.json.");
  return 0;
}

/** `spc run replay <runId>`: verify the log, chain, projection and attestation. */
export function runReplay(runId: string, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const runsDir = path.join(repoRoot, ".spc", "runs");
  const meta = loadRunMetaFromRuntime(runsDir, runId);
  let plan: import("@spc/schema").Plan | null = null;
  if (meta?.planId) {
    const planFile = path.join(repoRoot, ".spc", "plans", `${meta.planId}.json`);
    if (existsSync(planFile)) plan = JSON.parse(readFileSync(planFile, "utf8"));
  }
  const report = replayRun(runsDir, runId, plan);
  console.log(`Run ${report.runId}: ${report.ok ? "replay OK" : "REPLAY FAILED"}`);
  console.log(`Events: ${report.eventCount} (${report.chainStatus}), evidence: ${report.evidenceCount}`);
  console.log(`Projection: ${report.projectionMatches ? "state.json follows from the event log" : "DIVERGED"}`);
  for (const d of report.projectionDiffs) console.log(`  - ${d}`);
  console.log(`Attestation: ${report.attestation}${report.attestationDetail ? ` (${report.attestationDetail})` : ""}`);
  console.log(`Anchor: ${report.anchor}${report.anchorDetail ? ` (${report.anchorDetail})` : ""}`);
  return report.ok ? 0 : 1;
}
