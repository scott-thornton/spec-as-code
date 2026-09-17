import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
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
