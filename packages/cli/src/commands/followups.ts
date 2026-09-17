import path from "node:path";
import { allOpenFollowups, loadRunView, resolveFollowup } from "@spc/runtime";
import { loadRepoConfig, resolveRepoRoot, resolveSpec } from "../context.js";

/** `spc followups` — structured queue across runs. */
export function runFollowups(cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const open = allOpenFollowups(path.join(repoRoot, ".spc", "runs"));
  const blocking = open.filter((x) => x.followup.blocking);
  const nonBlocking = open.filter((x) => !x.followup.blocking);

  if (blocking.length === 0 && nonBlocking.length === 0) {
    console.log("No open follow-ups.");
    return 0;
  }
  if (blocking.length > 0) {
    console.log("BLOCKING\n");
    for (const { runId, followup } of blocking) {
      console.log(`${followup.id}  ${followup.title}   (run ${runId})`);
      console.log(`    ${followup.description}`);
      if (followup.options?.length) {
        for (const o of followup.options) console.log(`      --option ${o.id}: ${o.description}`);
      }
    }
    console.log("");
  }
  if (nonBlocking.length > 0) {
    console.log("NON-BLOCKING\n");
    for (const { runId, followup } of nonBlocking) {
      console.log(`${followup.id}  ${followup.title}   (run ${runId})`);
    }
  }
  console.log("\nResolve with: spc followup resolve <id> --run <runId> --option <optionId> [--note <text>]");
  return blocking.length > 0 ? 1 : 0;
}

/** `spc followup resolve <id> --option <id>` */
export function runFollowupResolve(options: {
  followupId: string;
  runId?: string;
  optionId?: string;
  note?: string;
  cwd?: string;
}): number {
  const repoRoot = resolveRepoRoot(options.cwd);
  const runsDir = path.join(repoRoot, ".spc", "runs");
  const candidates: string[] = [];
  if (options.runId) {
    candidates.push(options.runId);
  } else {
    for (const { runId, followup } of allOpenFollowups(runsDir)) {
      if (followup.id === options.followupId && !candidates.includes(runId)) candidates.push(runId);
    }
  }
  if (candidates.length === 0) {
    console.log(`No open follow-up ${options.followupId} found.`);
    return 1;
  }
  if (candidates.length > 1) {
    console.log(`Follow-up ${options.followupId} exists in multiple runs (${candidates.join(", ")}); pass --run.`);
    return 1;
  }
  const runId = candidates[0]!;
  const view = loadRunView(runsDir, runId);
  if (!view) {
    console.log(`Run ${runId} not readable.`);
    return 1;
  }
  const specDir = path.join(repoRoot, "specs");
  const { ir } = resolveSpec(specDir);
  const config = loadRepoConfig(repoRoot);

  const result = resolveFollowup({
    repoRoot,
    runId,
    followupId: options.followupId,
    optionId: options.optionId,
    note: options.note,
    resolvedBy: "human",
    specIr: ir,
    config,
  });
  console.log(`Resolved ${result.followup.id} (${result.followup.title}).`);
  for (const s of result.propertyStates) {
    console.log(`  ${s.propertyId}: ${s.status}${s.reason ? ` — ${s.reason}` : ""}`);
  }
  return 0;
}
