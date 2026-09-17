import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError, compileSpecSource } from "@spc/core";
import { diffStat } from "@spc/repo";
import { renderPrDraft } from "@spc/renderer";
import { loadRunView } from "@spc/runtime";
import { resolveRepoRoot } from "../context.js";

/** `spc run show <runId>` — reconstruct what happened, without chat logs. */
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
  console.log(`\nRun directory: ${path.join(repoRoot, ".spc", "runs", runId)}`);
  return 0;
}

/** `spc run pr <runId>` — generate a PR title/body from run records (§82). */
export function runPr(runId: string, options: { cwd?: string; out?: string }): number {
  const repoRoot = resolveRepoRoot(options.cwd);
  const view = loadRunView(path.join(repoRoot, ".spc", "runs"), runId);
  if (!view) {
    throw new SpcError("RUN_NOT_FOUND", `run ${runId} not found under ${path.join(repoRoot, ".spc", "runs")}`);
  }
  const specFile = findSpecFileForRun(repoRoot, view.meta.specId);
  const specIr = specFile ? compileSpecSource(readFileSync(specFile, "utf8"), specFile).ir : null;
  if (!specIr) {
    throw new SpcError("SPEC_NOT_FOUND", `spec ${view.meta.specId} not found under ${path.join(repoRoot, "specs")}`);
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
  const body = `# ${draft.title}\n\n${draft.body}\n`;
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
    const r = compileSpecSource(readFileSync(file, "utf8"), file);
    if (r.ok && r.ir?.spec.metadata.id === specId) return file;
  }
  return null;
}
