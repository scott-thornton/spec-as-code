import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSpecSource, SpcError } from "@spc/core";
import { compileSpecFile, diffStat, git } from "@spc/repo";
import { renderPrDraft } from "@spc/renderer";
import { cancelRun, exportRun, loadRunView, replayRun, resolveChain, runSupersede, supersededByLookup } from "@spc/runtime";
import { loadRunMeta as loadRunMetaFromRuntime } from "@spc/runtime";
import { HarnessStore } from "@spc/llm-harness";
import { resolveRepoRoot } from "../context.js";

/** `spc run show <runId>` - reconstruct what happened, without chat logs. */
/** `spc run supersede <runId> --by <runId>`: administrative replacement. */
export function runSupersedeCommand(runId: string, byRunId: string, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const result = runSupersede(repoRoot, runId, byRunId);
  console.log(`Recorded: run ${result.byRunId} supersedes run ${result.supersededRunId} (administrative replacement - no ancestry, no evidence inheritance, no verdict rewrite).`);
  return 0;
}

interface RunShowTask {
  taskId: string;
  status: string;
  attempt: number;
  failure?: { code?: string; message?: string };
}

/**
 * The incident surface (specs/run-incident-surface): live-run observability
 * and the spec context, rendered from the existing record. Receipts: two
 * independent investigators hand-rolled state.json probes (one guessing the
 * field shape wrong - failureReason does not exist), grep'd events for
 * refusals, read pending requests for ages, and cross-referenced criterion
 * IDs to spec text by hand while spec-snapshot.yaml sat in the run dir
 * unrendered. One command answers all of it; nothing is recorded anew.
 */
function renderIncidentSurface(repoRoot: string, runDir: string, runId: string, state: { status?: string; tasks?: Record<string, RunShowTask> }): void {
  console.log(`Run ${runId}: status ${state.status ?? "unknown"} (live - no summary yet)`);
  console.log("");
  console.log("Tasks:");
  const tasks = Object.values(state.tasks ?? {}).sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (tasks.length === 0) console.log("  (no tasks recorded)");
  for (const t of tasks) {
    const failure = t.status === "failed" && t.failure ? ` - ${t.failure.code ?? "TASK_FAILED"}: ${(t.failure.message ?? "").slice(0, 100)}` : "";
    console.log(`  ${t.taskId.padEnd(6)} ${t.status} (attempt ${t.attempt})${failure}`);
  }
  console.log("");
  console.log("Pending harness requests:");
  const pendingDir = path.join(repoRoot, ".spc", "harness", "pending");
  let printed = false;
  if (existsSync(pendingDir)) {
    for (const f of readdirSync(pendingDir).sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        const req = JSON.parse(readFileSync(path.join(pendingDir, f), "utf8")) as { id?: string; runId?: string; createdAt?: string; expiresAt?: string };
        if (req.runId !== runId || !req.id || !req.createdAt || !req.expiresAt) continue;
        const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(req.createdAt)) / 60000));
        const windowMin = Math.round((Date.parse(req.expiresAt) - Date.now()) / 60000);
        console.log(`  ${req.id}  age ${ageMin}m, window ${windowMin >= 0 ? `${windowMin}m left` : "ELAPSED"}`);
        printed = true;
      } catch {
        // unreadable request file: contributes nothing
      }
    }
  }
  if (!printed) console.log("  (no pending harness requests)");
  console.log("");
  console.log("Failure events (oldest first):");
  const FAILURE_EVENTS = new Set(["TASK_FAILED", "TASK_SUBMISSION_REFUSED", "TASK_STAGE_REJECTED"]);
  let sawEvent = false;
  try {
    for (const line of readFileSync(path.join(runDir, "events.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; timestamp?: string; payload?: { taskId?: string; code?: string; error?: { code?: string } } };
        if (!e.type || !FAILURE_EVENTS.has(e.type)) continue;
        const code = e.payload?.error?.code ?? e.payload?.code ?? "";
        const at = (e.timestamp ?? "").replace("T", " ").slice(0, 19);
        console.log(`  ${at}  ${e.type}  ${e.payload?.taskId ?? "?"}${code ? `  ${code}` : ""}`);
        sawEvent = true;
      } catch {
        // malformed line: contributes nothing
      }
    }
  } catch {
    // no events file
  }
  if (!sawEvent) console.log("  (none)");
  console.log("");
}

function renderSpecSection(repoRoot: string, runDir: string, specIdFromState: string | undefined): void {
  let meta: { specId?: string; specDigest?: string } = {};
  try {
    meta = JSON.parse(readFileSync(path.join(runDir, "metadata.json"), "utf8")) as typeof meta;
  } catch {
    // no metadata: fall back to the state's specId
  }
  const specId = meta.specId ?? specIdFromState;
  let snapshotText: string | null = null;
  try {
    snapshotText = readFileSync(path.join(runDir, "spec-snapshot.yaml"), "utf8");
  } catch {
    // no snapshot
  }
  if (!specId || snapshotText === null) {
    console.log(`Spec: ${specId ?? "unknown"} (snapshot absent)`);
    return;
  }
  const compiled = compileSpecSource(snapshotText, "spec-snapshot.yaml");
  const snapshotDigest = compiled.ok && compiled.ir ? compiled.ir.digest : "unknown";
  // Drift badge: the live spec file vs what this run executed.
  const liveFile = findSpecFileForRun(repoRoot, specId);
  let drift = "absent";
  if (liveFile) {
    const live = compileSpecFile(liveFile);
    drift = live.ok && live.ir && live.ir.digest === snapshotDigest ? "matched" : "drifted";
  }
  const badge =
    drift === "matched"
      ? "matched (the live spec file still says what this run executed)"
      : drift === "drifted"
        ? "DRIFTED (the live spec file differs from the executed snapshot)"
        : "absent (no live spec file matches this run's spec id)";
  console.log(`Spec: ${specId}  digest ${snapshotDigest.slice(0, 16)}  drift: ${badge}`);
  if (compiled.ok && compiled.ir) {
    const state: { requirements?: Record<string, { status?: string }> } = (() => {
      try {
        return JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")) as { requirements?: Record<string, { status?: string }> };
      } catch {
        return {};
      }
    })();
    for (const p of compiled.ir.properties) {
      const status = state.requirements?.[p.id]?.status ?? "unevaluated";
      console.log(`  ${p.id}  ${status}  - ${p.statement.replace(/\s+/g, " ").slice(0, 80)}`);
      if (status !== "satisfied" && status !== "waived") {
        for (const c of p.acceptance) {
          const demand =
            c.type === "command" ? c.command
            : c.type === "file" ? `file ${c.path} (${Object.entries(c.assert).map(([k, v]) => `${k}: ${v}`).join(", ")})`
            : c.type === "suite" ? `suite ${c.ref}`
            : `${c.type} criterion`;
          console.log(`    ${c.id}: ${demand}`);
        }
      }
    }
  }
  console.log("");
}

export function runShow(runId: string, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const runsDir = path.join(repoRoot, ".spc", "runs");
  const view = loadRunView(runsDir, runId);
  if (!view) {
    throw new SpcError("RUN_NOT_FOUND", `run ${runId} not found under ${runsDir}`);
  }
  const runDir = path.join(runsDir, runId);
  const summaryFile = path.join(runDir, "summary.md");
  if (existsSync(summaryFile)) {
    console.log(readFileSync(summaryFile, "utf8"));
  } else {
    renderIncidentSurface(repoRoot, runDir, runId, view.state as never);
  }
  // The spec section renders for live AND finalized runs (drift and
  // criterion demands are post-mortem questions too).
  renderSpecSection(repoRoot, runDir, view.state.specId);
  const supersededBy = supersededByLookup(runsDir, runId);
  if (supersededBy) {
    console.log(`\nSuperseded by ${supersededBy} (administrative replacement; this run's records are kept, never inherited)`);
  }
  console.log(`\nRun directory: ${runDir}`);
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

/** `spc run cancel <runId>` - honest execution control (specs/apply-ownership, AO-003). */
export function runCancel(runId: string, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const result = cancelRun(repoRoot, runId);
  // The sanctioned kill must not orphan: retire this run's stamped
  // pendings into stale/ so no agent ever answers a dead run again
  // (idempotent - cancelRun already retired during its grace wait).
  const retired = new HarnessStore(repoRoot).expireForRun(runId);
  // Honest reporting: success only when the owner verifiably stopped and
  // state was reconciled; INCOMPLETE is INCOMPLETE, never "cancelled".
  if (result.status === "cancelled") {
    console.log(`Run ${runId}: cancelled. ${result.detail}`);
  } else {
    console.error(`Run ${runId}: cancellation INCOMPLETE. ${result.detail}`);
  }
  if (retired.length > 0) {
    console.log(`Retired ${retired.length} harness request(s) into stale/: ${retired.join(", ")}`);
  }
  console.log(`Run directory: ${path.join(repoRoot, ".spc", "runs", runId)}`);
  return result.status === "cancelled" ? 0 : 1;
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
