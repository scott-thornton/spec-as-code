import path from "node:path";
import { applyPlan, resumeRun, type ApplyReport } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveRepoRoot } from "../context.js";

/** `spc apply [planFile] [--resume runId] [--allow-dirty] [--force]` */
export async function runApply(options: {
  planFile?: string;
  resumeRunId?: string;
  allowDirty?: boolean;
  force?: boolean;
  cwd?: string;
}): Promise<number> {
  const repoRoot = resolveRepoRoot(options.cwd);
  const config = loadRepoConfig(repoRoot);
  const deps = {
    providerFactory: async () => createProvider(config, repoRoot),
    log: (line: string) => console.log(line),
  };
  const report = options.resumeRunId
    ? await resumeRun({ repoRoot, resumeRunId: options.resumeRunId, allowDirty: options.allowDirty, force: options.force }, deps)
    : await applyPlan({ repoRoot, planFile: options.planFile, allowDirty: options.allowDirty, force: options.force }, deps);
  printReport(report);
  return report.status === "succeeded" ? 0 : 1;
}

export function printReport(report: ApplyReport): void {
  console.log("");
  console.log(`Run ${report.runId}: ${report.status.replace("_", " ")}`);
  if (report.branch) console.log(`Branch:    ${report.branch}`);
  if (report.baseRevision) console.log(`Base:      ${report.baseRevision.slice(0, 12)}`);
  if (report.resultRevision) console.log(`Result:    ${report.resultRevision.slice(0, 12)}`);
  if (report.worktree) console.log(`Worktree:  ${path.relative(process.cwd(), report.worktree)}`);
  console.log(`Model calls: ${report.modelCalls}, replans: ${report.replans}`);
  console.log("");
  console.log("Requirements:");
  for (const r of report.requirements) {
    console.log(`  ${r.status.padEnd(12)} ${r.propertyId}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  const open = report.followups.filter((f) => f.status === "open");
  if (open.length > 0) {
    console.log("");
    console.log("Open follow-ups:");
    for (const f of open) console.log(`  ${f.blocking ? "[blocking] " : "           "}${f.id} ${f.title}`);
  }
  console.log("");
  console.log(`Details: ${path.relative(process.cwd(), report.summaryPath)}`);
}
