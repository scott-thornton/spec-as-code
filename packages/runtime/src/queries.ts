import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SpcError } from "@spc/core";
import type { Config, Event, Evidence, FollowUp, RequirementState, RunState, SpecIR } from "@spc/schema";
import type { LLMProvider } from "@spc/llm";
import { currentBranch, currentRevision, git, statusPorcelain } from "@spc/repo";
import { renderRunSummary } from "@spc/renderer";
import { evaluateProperty } from "@spc/verifier";
import { EventStore } from "./events.js";
import { spcPaths } from "./paths.js";
import { listRunIds, loadRunMeta, newRunId, RUNTIME_ERROR, type RunMeta } from "./run.js";
import { applyEvent, initialState, persistState } from "./state.js";
import { EvidenceStore, FollowupStore } from "./stores.js";
import { writeSpecSnapshot, findSpecSource } from "./snapshot.js";
import { attestRecords } from "./attestation.js";
import { verifyStandalone } from "./verify.js";

export interface RunView {
  meta: RunMeta;
  state: RunState;
  followups: FollowUp[];
  evidence: Evidence[];
}

export function loadRunView(runsDir: string, runId: string): RunView | null {
  const meta = loadRunMeta(runsDir, runId);
  if (!meta) return null;
  const dir = path.join(runsDir, runId);
  const stateFile = path.join(dir, "state.json");
  const state: RunState = existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, "utf8")) as RunState)
    : initialState(meta, null);
  const followups = new FollowupStore(path.join(dir, "followups.json"));
  followups.load();
  const evidence = new EvidenceStore(path.join(dir, "evidence.jsonl"));
  evidence.load();
  return { meta, state, followups: [...followups.all()], evidence: [...evidence.all()] };
}

/** Runs of this spec whose records fail to load: corruption must be
 *  VISIBLE in the normal views, never silently skipped (run-mvix4mfx). */
export function integrityFailuresForSpec(runsDir: string, specId: string): { runId: string; error: string }[] {
  const failures: { runId: string; error: string }[] = [];
  for (const runId of listRunIds(runsDir)) {
    const meta = loadRunMeta(runsDir, runId);
    if (!meta || meta.specId !== specId) continue;
    try {
      loadRunView(runsDir, runId);
    } catch (e) {
      failures.push({ runId, error: (e as Error).message.split("\n")[0] ?? String(e) });
    }
  }
  return failures;
}

export function latestRunViewForSpec(runsDir: string, specId: string): RunView | null {
  const views: RunView[] = [];
  for (const runId of listRunIds(runsDir)) {
    let view: RunView | null;
    try {
      view = loadRunView(runsDir, runId);
    } catch (e) {
      // A damaged log (chain break, torn records) must not brickwall
      // every spec-level operation: skip the unreadable run with a note,
      // so verify and status keep working while the run itself stays
      // individually inspectable - spc run show still refuses loudly.
      console.error(`note: skipping run ${runId} (unreadable: ${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    if (view && view.meta.specId === specId) views.push(view);
  }
  if (views.length === 0) return null;
  views.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : -1));
  return views[0]!;
}

/**
 * Phantom-drift guard: the latest run for this spec was an in-place
 * run-branch execution whose results branch is not merged into HEAD, so
 * verify/reconcile against the CURRENT tree will report the run's own
 * changes as missing. Returns the warning text, or null when the
 * situation does not apply (results merged, current-branch mode, or no
 * such run). A warning, never an error: verifying the base tree is
 * sometimes exactly what the caller means.
 */
export function inPlaceHandoffWarning(runsDir: string, specId: string, repoRoot: string): string | null {
  const view = latestRunViewForSpec(runsDir, specId);
  if (!view?.meta.branch || !view.meta.worktree || !view.meta.originalBranch) return null;
  try {
    if (path.resolve(view.meta.worktree) !== path.resolve(repoRoot)) return null;
    const head = currentBranch(repoRoot);
    if (head === view.meta.branch) return null;
    const merged = git(repoRoot, ["merge-base", "--is-ancestor", view.meta.branch, "HEAD"]).ok;
    if (merged) return null;
    return (
      `note: latest in-place run ${view.meta.runId} left its results on branch ${view.meta.branch} ` +
      `(unmerged); this command inspects the CURRENT tree (${head}), so the run's own changes may ` +
      `report as drift. Merge or check out ${view.meta.branch} first if that is what you meant to verify.`
    );
  } catch {
    return null;
  }
}

export function allOpenFollowups(runsDir: string): { runId: string; followup: FollowUp }[] {
  const out: { runId: string; followup: FollowUp }[] = [];
  for (const runId of listRunIds(runsDir)) {
    const store = new FollowupStore(path.join(runsDir, runId, "followups.json"));
    store.load();
    for (const f of store.open()) out.push({ runId, followup: f });
  }
  return out;
}

export interface ResolveFollowupOptions {
  repoRoot: string;
  runId: string;
  followupId: string;
  optionId?: string;
  note?: string;
  resolvedBy?: string;
  specIr: SpecIR;
  config: Config;
  now?(): string;
}

export interface ResolveFollowupResult {
  followup: FollowUp;
  propertyStates: RequirementState[];
}

/**
 * Resolving a follow-up is itself an event, and when the follow-up carries a
 * criterion it produces human evidence and re-derives property state.
 */
export function resolveFollowup(options: ResolveFollowupOptions): ResolveFollowupResult {
  const now = options.now ?? (() => new Date().toISOString());
  const paths = spcPaths(options.repoRoot);
  const dir = paths.runDir(options.runId);
  if (!existsSync(dir)) throw new SpcError(RUNTIME_ERROR, `run ${options.runId} not found`);

  const events = new EventStore(paths.eventsFile(options.runId), options.runId, now);
  events.load();
  const followups = new FollowupStore(paths.followupsFile(options.runId));
  followups.load();
  const evidence = new EvidenceStore(paths.evidenceFile(options.runId));
  evidence.load();

  const followup = followups.all().find((f) => f.id === options.followupId);
  if (!followup) throw new SpcError(RUNTIME_ERROR, `follow-up ${options.followupId} not found in run ${options.runId}`);
  if (followup.status === "resolved") {
    return { followup, propertyStates: [] };
  }
  if (followup.options && options.optionId && !followup.options.some((o) => o.id === options.optionId)) {
    throw new SpcError(
      RUNTIME_ERROR,
      `option "${options.optionId}" is not valid for ${followup.id}; valid options: ${followup.options.map((o) => o.id).join(", ")}`,
    );
  }

  const resolved = followups.resolve(
    options.followupId,
    {
      ...(options.optionId ? { optionId: options.optionId } : {}),
      ...(options.note ? { note: options.note } : {}),
      ...(options.resolvedBy ? { resolvedBy: options.resolvedBy } : {}),
    },
    now,
  );
  events.append("FOLLOWUP_RESOLVED", { followupId: resolved.id, optionId: options.optionId ?? null, note: options.note ?? null });

  const propertyStates: RequirementState[] = [];
  if (followup.criterionId && followup.propertyId) {
    const property = options.specIr.properties.find((p) => p.id === followup.propertyId);
    if (property) {
      const waive = options.optionId === "waive";
      const outcome = waive ? "supports" : options.optionId === "reject" ? "contradicts" : options.optionId === "confirm" ? "supports" : "inconclusive";
      evidence.add({
        id: `EV-${String(evidence.all().length + 1).padStart(4, "0")}`,
        runId: options.runId,
        criterionId: followup.criterionId,
        propertyRefs: [property.id],
        kind: "human",
        outcome,
        producer: { type: "human", ...(options.resolvedBy ? { identity: options.resolvedBy } : {}) },
        timestamp: now(),
        repositoryRevision: "post-run-resolution",
        payload: {
          followupId: resolved.id,
          optionId: options.optionId ?? null,
          ...(options.note ? { note: options.note } : {}),
          ...(waive ? { waive: true } : {}),
        },
      });
      const state = evaluateProperty(property, evidence.all(), {
        allowAgentOnly: options.config.verification.allowAgentOnlyMustRequirements,
        now,
      });
      events.append("EVIDENCE_RECORDED", {
        evidenceId: evidence.all()[evidence.all().length - 1]?.id,
        propertyRefs: [property.id],
        criterionId: followup.criterionId,
        kind: "human",
        outcome,
      });
      events.append("PROPERTY_VERIFIED", {
        propertyId: state.propertyId,
        status: state.status,
        evidenceIds: state.evidenceIds,
        ...(state.reason ? { reason: state.reason } : {}),
      });
      propertyStates.push(state);

      const stateFile = paths.stateFile(options.runId);
      if (existsSync(stateFile)) {
        const runState = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
        runState.requirements[state.propertyId] = state;
        persistState(stateFile, runState);
      }
    }
  }
  return { followup: resolved, propertyStates };
}

/** Plan approval marker for execution.requirePlanApproval. */
export function approvePlan(repoRoot: string, planId: string, by = "human"): void {
  const paths = spcPaths(repoRoot);
  if (!existsSync(paths.planFile(planId))) {
    throw new SpcError(RUNTIME_ERROR, `plan ${planId} not found under ${paths.plansDir}`);
  }
  writeFileSync(paths.planApprovalFile(planId), JSON.stringify({ planId, approvedBy: by, approvedAt: new Date().toISOString() }, null, 2), "utf8");
}

export interface StandaloneVerifyOptions {
  repoRoot: string;
  specIr: SpecIR;
  config: Config;
  provider: LLMProvider | null;
  now?(): string;
  /** Criteria execution root (temporary worktree for --run). */
  executionRoot?: string;
  /** Prepared-environment outcome for --run verification: recorded as
   *  evidence, and a failure classifies command criteria inconclusive. */
  prepareOutcome?: { mode: "installed" | "linked" | "none" | "failed"; exitCode?: number; detail?: string };
}

export interface StandaloneVerifyReport {
  runId: string;
  runDir: string;
  states: RequirementState[];
  followups: FollowUp[];
  evidenceCount: number;
}

/** `spc verify`: a verify-only run against the current working tree. */
/**
 * Walk the validated parentRunId chain from a run to its root, newest
 * first, cycle-guarded. Rendering uses this; it never creates lineage.
 */
export function resolveChain(runsDir: string, runId: string): { runId: string }[] {
  const out: { runId: string }[] = [{ runId }];
  const visited = new Set<string>([runId]);
  let cursor: string | undefined = runId;
  for (;;) {
    const metaFile = path.join(runsDir, cursor, "metadata.json");
    if (!existsSync(metaFile)) break;
    let parent: string | undefined;
    try {
      parent = (JSON.parse(readFileSync(metaFile, "utf8")) as { parentRunId?: string }).parentRunId;
    } catch {
      break;
    }
    if (!parent || visited.has(parent)) break;
    visited.add(parent);
    out.push({ runId: parent });
    cursor = parent;
  }
  return out;
}

/** Digest of the effective verification config: file bytes, or the
 *  canonical default when no config.yaml exists. Shared by run
 *  creation and freshness eligibility. */
export function configDigestOf(configPath: string, config?: unknown): string {
  const content = existsSync(configPath) ? readFileSync(configPath, "utf8") : JSON.stringify(config ?? {});
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

export async function createVerifyRun(options: StandaloneVerifyOptions): Promise<StandaloneVerifyReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const paths = spcPaths(options.repoRoot);
  const runId = `v-${newRunId().slice(4)}`;
  const runDir = paths.runDir(runId);
  mkdirSync(runDir, { recursive: true });
  {
    const source = findSpecSource(paths.specsDir, options.specIr.spec.metadata.id);
    if (source !== null) writeSpecSnapshot(paths, runId, options.specIr, source, now);
  }

  const { currentRevision, statusPorcelain } = await import("@spc/repo");
  const revision = currentRevision(options.repoRoot);
  const dirty = statusPorcelain(options.repoRoot).dirty;

  // configDigestOf is now the shared exported helper (freshness uses it
  // for cache eligibility); the call site passes the effective config.
  const meta: RunMeta = {
    runId,
    kind: "verify",
    specId: options.specIr.spec.metadata.id,
    specDigest: options.specIr.digest,
    configDigest: configDigestOf(paths.configPath, options.config),
    baseRevision: revision,
    createdAt: now(),
    // RunMeta gains configDigest formally in a follow-up amendment; the
    // cast carries it until then (out-of-scope write refused the interface
    // edit - enforcement held, plan targets were narrower than the need).
  } as RunMeta & { configDigest: string };
  writeFileSync(paths.metadataFile(runId), JSON.stringify(meta, null, 2), "utf8");

  const events = new EventStore(paths.eventsFile(runId), runId, now);
  events.append("RUN_CREATED", { runId, kind: "verify", specId: meta.specId, baseRevision: revision, dirty });
  events.append("SPEC_LOADED", { specId: meta.specId, digest: meta.specDigest });
  events.append("SPEC_VALIDATED", { digest: meta.specDigest });

  const evidence = new EvidenceStore(paths.evidenceFile(runId));
  const followups = new FollowupStore(paths.followupsFile(runId));
  let sweep: Awaited<ReturnType<typeof verifyStandalone>>;
  try {
  sweep = await verifyStandalone({
    repoRoot: options.repoRoot,
    ...(options.executionRoot ? { executionRoot: options.executionRoot } : {}),
    ...(options.prepareOutcome ? { prepareOutcome: options.prepareOutcome } : {}),
    specIr: options.specIr,
    runId,
    config: options.config,
    provider: options.provider,
    evidence,
    followups,
    events,
    revision,
    now,
  });
  } catch (e) {
    // A sweep killed by the harness response timeout must not leave a
    // half-written run (the CHK3555 field case: events and evidence but
    // no summary - a ghost in every later rendering). Finalize loudly.
    const code = (e as { code?: string }).code ?? "";
    if (!/HARNESS_RESPONSE_TIMEOUT/.test(code) && !/not answered with a valid value/.test((e as Error).message)) throw e;
    events.append("RUN_COMPLETED", { status: "timed_out", requirements: {} });
    const timedOutState = { ...initialState(meta, null), status: "timed_out" as const };
    writeFileSync(paths.stateFile(runId), JSON.stringify(timedOutState, null, 2), "utf8");
    writeFileSync(paths.summaryFile(runId), `# Run ${runId}: timed out\n\nKilled by the harness response timeout while awaiting an answer.\nPartial evidence is in evidence.jsonl; the pending request was\nexpired out of the live queue.\n`, "utf8");
    throw e;
  }

  const statesMap = new Map(sweep.states.map((s) => [s.propertyId, s]));
  const blocking = followups.openBlocking();
  const mustsOk = options.specIr.properties
    .filter((p) => p.priority === "must")
    .every((p) => {
      const s = statesMap.get(p.id);
      return s !== undefined && (s.status === "satisfied" || s.status === "waived");
    });
  const status = blocking.length > 0 ? "blocked" : mustsOk ? "succeeded" : "partially_satisfied";

  let state = initialState(meta, null);
  for (const e of events.all()) {
    state = applyEvent(state, e);
  }
  state = { ...state, status, requirements: { ...state.requirements, ...Object.fromEntries(sweep.states.map((s) => [s.propertyId, s])) } };
  events.append("RUN_COMPLETED", { status, requirements: Object.fromEntries(sweep.states.map((s) => [s.propertyId, s.status])) });
  persistState(paths.stateFile(runId), state);

  writeFileSync(
    paths.summaryFile(runId),
    renderRunSummary({ specIr: options.specIr, runState: state, followups: [...followups.all()], evidence: [...evidence.all()] }),
    "utf8",
  );
  // Verify runs are the evidence CI gates PRs on: they carry the same
  // prefix commitment as apply runs. No git anchor (no run branch).
  attestRecords({ runDir, runId, specId: meta.specId, status, events, evidence: [...evidence.all()], now });
  return { runId, runDir, states: sweep.states, followups: [...followups.all()], evidenceCount: evidence.all().length };
}
