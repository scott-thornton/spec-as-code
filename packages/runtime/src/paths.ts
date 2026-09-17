import path from "node:path";

export interface SpcPaths {
  repoRoot: string;
  specsDir: string;
  spcDir: string;
  configPath: string;
  plansDir: string;
  runsDir: string;
  worktreesDir: string;
  cacheDir: string;
  runDir(runId: string): string;
  eventsFile(runId: string): string;
  stateFile(runId: string): string;
  evidenceFile(runId: string): string;
  observationsFile(runId: string): string;
  followupsFile(runId: string): string;
  summaryFile(runId: string): string;
  metadataFile(runId: string): string;
  snapshotFile(runId: string): string;
  amendmentsDir(runId: string): string;
  usageFile(runId: string): string;
  planFile(planId: string): string;
  planApprovalFile(planId: string): string;
}

/** Runtime layout under .spc/. specs/ is human-authored source of intent. */
export function spcPaths(repoRoot: string): SpcPaths {
  const spcDir = path.join(repoRoot, ".spc");
  const plansDir = path.join(spcDir, "plans");
  const runsDir = path.join(spcDir, "runs");
  const runDir = (runId: string): string => path.join(runsDir, runId);
  return {
    repoRoot,
    specsDir: path.join(repoRoot, "specs"),
    spcDir,
    configPath: path.join(spcDir, "config.yaml"),
    plansDir,
    runsDir,
    worktreesDir: path.join(spcDir, "worktrees"),
    cacheDir: path.join(spcDir, "cache"),
    runDir,
    eventsFile: (runId) => path.join(runDir(runId), "events.jsonl"),
    stateFile: (runId) => path.join(runDir(runId), "state.json"),
    evidenceFile: (runId) => path.join(runDir(runId), "evidence.jsonl"),
    observationsFile: (runId) => path.join(runDir(runId), "observations.jsonl"),
    followupsFile: (runId) => path.join(runDir(runId), "followups.json"),
    summaryFile: (runId) => path.join(runDir(runId), "summary.md"),
    metadataFile: (runId) => path.join(runDir(runId), "metadata.json"),
    snapshotFile: (runId) => path.join(runDir(runId), "snapshot.json"),
    amendmentsDir: (runId) => path.join(runDir(runId), "amendments"),
    usageFile: (runId) => path.join(runDir(runId), "usage.jsonl"),
    planFile: (planId) => path.join(plansDir, `${planId}.json`),
    planApprovalFile: (planId) => path.join(plansDir, `${planId}.approved.json`),
  };
}
