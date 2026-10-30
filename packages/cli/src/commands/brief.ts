import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { git } from "@spc/repo";
import { HarnessStore } from "@spc/llm-harness";
import { describeRequestState } from "./agent.js";
import { postureFor, resolveChain } from "@spc/runtime";
import { loadRepoConfig, resolveAllSpecs, resolveRepoRoot } from "../context.js";

interface LastRun {
  id: string;
  status: string;
  configDigest?: string;
  openBlocking: { id: string; title: string }[];
}

/** Derived pipeline position for a run's line (specs/pipeline-
 *  signposting): every observed state gets exactly one interpretation,
 *  pure derivation from state brief already computes. */
function pipelinePosition(lastRun: LastRun | null, pending: { role: string; runId?: string; id: string }[], lastRunId: string | undefined): string | null {
  if (!lastRun) return null;
  if (lastRun.status === "running") {
    const mine = pending.filter((r) => r.runId === lastRunId);
    const executor = mine.find((r) => r.role === "executor");
    if (executor) return "awaiting answer (stage 4 of 7)";
    const planner = mine.find((r) => r.role === "planner" || r.role === "replanner");
    if (planner) return planner.role === "planner" ? "plan (stage 3 of 7)" : "replan (within the run)";
    return "run in progress";
  }
  if (lastRun.status === "succeeded" || lastRun.status === "partially_satisfied") return "adversarial pass, then push";
  if (lastRun.status === "failed" || lastRun.status === "cancelled") return "recovery (rectify, resume, or start fresh)";
  return null;
}

interface BriefSpec {
  id: string;
  lastRun: LastRun | null;
  configChanged: boolean;
  chainDepth?: number;
  posture: string;
  postureReason: string;
}

/**
 * `spc brief` - one read-only command for session orientation: every
 * spec with its last run and open blocking follow-ups, the pending
 * harness queue, the config posture, a warning when a spec's last run
 * executed under a different config (stale authored assumptions - the
 * 2026-10-19 near-miss), and unmerged run branches. Renders recorded
 * state only; never runs criteria, never creates runs, never writes.
 */
export function runBrief(cwd: string | undefined, format: "text" | "json" = "text"): number {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadRepoConfig(repoRoot);

  // Config identity: the file bytes when present, else the parsed
  // default config serialized canonically - stable either way.
  const configPath = path.join(repoRoot, ".spc", "config.yaml");
  const configDigest = existsSync(configPath)
    ? "sha256:" + createHash("sha256").update(readFileSync(configPath, "utf8"), "utf8").digest("hex")
    : "sha256:" + createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");

  // Index runs by spec (newest createdAt wins).
  const runsDir = path.join(repoRoot, ".spc", "runs");
  const lastBySpec = new Map<string, LastRun>();
  if (existsSync(runsDir)) {
    for (const entry of readdirSync(runsDir)) {
      const metaFile = path.join(runsDir, entry, "metadata.json");
      if (!existsSync(metaFile)) continue;
      let meta: { runId?: string; specId?: string; createdAt?: string; configDigest?: string };
      try {
        meta = JSON.parse(readFileSync(metaFile, "utf8"));
      } catch {
        continue;
      }
      if (!meta.specId || !meta.runId) continue;
      const prev = lastBySpec.get(meta.specId);
      if (prev && (prev.id > meta.runId)) continue; // run ids sort chronologically
      let status = "unknown";
      let openBlocking: { id: string; title: string }[] = [];
      const stateFile = path.join(runsDir, entry, "state.json");
      if (existsSync(stateFile)) {
        try {
          status = (JSON.parse(readFileSync(stateFile, "utf8")) as { status?: string }).status ?? status;
        } catch {
          // keep unknown
        }
      }
      const followFile = path.join(runsDir, entry, "followups.json");
      if (existsSync(followFile)) {
        try {
          const list = JSON.parse(readFileSync(followFile, "utf8")) as { id: string; title: string; blocking: boolean; status: string }[];
          openBlocking = list.filter((f) => f.blocking && f.status === "open").map((f) => ({ id: f.id, title: f.title }));
        } catch {
          // none readable
        }
      }
      lastBySpec.set(meta.specId, { id: meta.runId, status, configDigest: meta.configDigest, openBlocking });
    }
  }

  const specs: BriefSpec[] = resolveAllSpecs(path.join(repoRoot, "specs")).map(({ ir }) => {
    const posture = postureFor(ir, path.join(repoRoot, ".spc", "runs"), repoRoot);
    const lastRun = lastBySpec.get(ir.spec.metadata.id) ?? null;
    // Chain depth: walk the validated parent links from the head run.
    let chainDepth = 1;
    if (lastRun) {
      const chain = resolveChain(runsDir, lastRun.id);
      chainDepth = chain.length;
    }
    return {
      id: ir.spec.metadata.id,
      lastRun,
      configChanged: lastRun !== null && lastRun.configDigest !== undefined && lastRun.configDigest !== configDigest,
      posture: posture.posture,
      postureReason: posture.reason,
      ...(chainDepth > 1 ? { chainDepth } : {}),
    };
  });
  const postureCounts: Record<string, number> = { standing: 0, active: 0, unverified: 0, stale: 0 };
  for (const s of specs) postureCounts[s.posture] = (postureCounts[s.posture] ?? 0) + 1;

  const harnessStore = new HarnessStore(repoRoot);
  const pendingRequests = harnessStore.listPending();
  const pendingHarness = pendingRequests.length;

  const unmergedRunBranches = git(repoRoot, ["branch", "--list", "spc/*", "--no-merged", "HEAD"])
    .stdout.split("\n").map((l) => l.trim().replace(/^\* /, "")).filter(Boolean);

  const worktreesDir = path.join(repoRoot, ".spc", "worktrees");
  const strayWorktrees = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];

  if (format === "json") {
    console.log(JSON.stringify({
      specs: specs.map((s) => ({
        id: s.id,
        lastRun: s.lastRun ? { id: s.lastRun.id, status: s.lastRun.status } : null,
        configChanged: s.configChanged,
        openBlockingFollowups: s.lastRun?.openBlocking ?? [],
        ...(s.chainDepth ? { chainDepth: s.chainDepth } : {}),
      })),
      pendingHarness,
      unmergedRunBranches,
      strayWorktrees,
    }, null, 2));
    return 0;
  }

  console.log(`specs/ (${specs.length})`);
  for (const s of specs) {
    const position = pipelinePosition(s.lastRun, pendingRequests.map((r) => ({ role: r.role, id: r.id, ...(r.runId ? { runId: r.runId } : {}) })), s.lastRun?.id);
    const run = s.lastRun ? `${s.lastRun.id}  ${s.lastRun.status}${position ? ` · ${position}` : ""}` : "no runs";
    const blockers = s.lastRun && s.lastRun.openBlocking.length > 0
      ? `   ${s.lastRun.openBlocking.map((f) => f.id).join(", ")}`
      : "";
    console.log(`  ${s.id.padEnd(34)} ${run}${blockers}${s.chainDepth ? ` · ${s.chainDepth} runs (chain)` : ""}`);
    if (s.configChanged) {
      console.log(`    ⚠ config changed since ${s.id}'s last run - authored assumptions may be stale`);
    }
  }
  console.log(`postures: ${postureCounts.standing} standing · ${postureCounts.active} active · ${postureCounts.unverified} unverified · ${postureCounts.stale} stale`);
  if (pendingRequests.length > 0) {
    // The orientation command shows the queue's derived state, not a
    // count: an orphan is obvious here in seconds.
    console.log(`harness queue (${pendingHarness}):`);
    for (const r of pendingRequests) {
      const answeredAt = harnessStore.getAnswer(r.id)?.answeredAt;
      console.log(`  ${r.id.padEnd(34)} ${describeRequestState(r)}${answeredAt ? `  answered (${answeredAt.slice(11, 16)} UTC)` : ""}`);
    }
  } else {
    console.log(`pending harness requests: ${pendingHarness}`);
  }
  const posture = [
    config.provider?.name ?? "none",
    config.execution.inPlace ? `inPlace ${config.execution.inPlaceBranch}` : null,
    config.verification.requireRedPhase ? "requireRedPhase" : null,
    config.verification.protectedPaths.length > 0 ? `protectedPaths (${config.verification.protectedPaths.join(", ")})` : null,
  ].filter(Boolean);
  console.log(`config: ${posture.join(" · ")}`);
  if (unmergedRunBranches.length > 0) {
    console.log("unmerged run branches:");
    for (const b of unmergedRunBranches) console.log(`  ${b}`);
  }
  if (strayWorktrees.length > 0) {
    console.log(`stray worktrees: ${strayWorktrees.join(", ")}`);
  }
  return 0;
}
