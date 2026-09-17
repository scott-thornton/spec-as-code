import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import type { Config, Event, Evidence, FollowUp, RequirementState, RunState, SpecIR } from "@spc/schema";
import type { LLMProvider } from "@spc/llm";
import { currentRevision, statusPorcelain } from "@spc/repo";
import { renderRunSummary } from "@spc/renderer";
import { evaluateProperty } from "@spc/verifier";
import { EventStore } from "./events.js";
import { spcPaths } from "./paths.js";
import { listRunIds, loadRunMeta, newRunId, RUNTIME_ERROR, type RunMeta } from "./run.js";
import { applyEvent, initialState, persistState } from "./state.js";
import { EvidenceStore, FollowupStore } from "./stores.js";
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

export function latestRunViewForSpec(runsDir: string, specId: string): RunView | null {
  const views: RunView[] = [];
  for (const runId of listRunIds(runsDir)) {
    const view = loadRunView(runsDir, runId);
    if (view && view.meta.specId === specId) views.push(view);
  }
  if (views.length === 0) return null;
  views.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : -1));
  return views[0]!;
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
}

export interface StandaloneVerifyReport {
  runId: string;
  runDir: string;
  states: RequirementState[];
  followups: FollowUp[];
  evidenceCount: number;
}

/** `spc verify`: a verify-only run against the current working tree. */
export async function createVerifyRun(options: StandaloneVerifyOptions): Promise<StandaloneVerifyReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const paths = spcPaths(options.repoRoot);
  const runId = `v-${newRunId().slice(4)}`;
  const runDir = paths.runDir(runId);
  mkdirSync(runDir, { recursive: true });

  const { currentRevision, statusPorcelain } = await import("@spc/repo");
  const revision = currentRevision(options.repoRoot);
  const dirty = statusPorcelain(options.repoRoot).dirty;

  const meta: RunMeta = {
    runId,
    kind: "verify",
    specId: options.specIr.spec.metadata.id,
    specDigest: options.specIr.digest,
    baseRevision: revision,
    createdAt: now(),
  };
  writeFileSync(paths.metadataFile(runId), JSON.stringify(meta, null, 2), "utf8");

  const events = new EventStore(paths.eventsFile(runId), runId, now);
  events.append("RUN_CREATED", { runId, kind: "verify", specId: meta.specId, baseRevision: revision, dirty });
  events.append("SPEC_LOADED", { specId: meta.specId, digest: meta.specDigest });
  events.append("SPEC_VALIDATED", { digest: meta.specDigest });

  const evidence = new EvidenceStore(paths.evidenceFile(runId));
  const followups = new FollowupStore(paths.followupsFile(runId));
  const sweep = await verifyStandalone({
    repoRoot: options.repoRoot,
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
  return { runId, runDir, states: sweep.states, followups: [...followups.all()], evidenceCount: evidence.all().length };
}
