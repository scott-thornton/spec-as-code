import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { digestOf } from "@spc/core";
import type { Plan, RunState } from "@spc/schema";
import { EventStore } from "./events.js";
import { loadRunMeta, RUNTIME_ERROR } from "./run.js";
import { SpcError } from "@spc/core";
import { initialState, projectState } from "./state.js";
import { EvidenceStore } from "./stores.js";
import { evidenceHeadOf, type RunAttestation } from "./attestation.js";

/**
 * `spc run replay`: reconstruct what the run believed at each transition
 * and verify the derived state still follows from the event stream.
 * Strict by construction - the loaders underneath fail closed on
 * corrupted or schema-invalid interior records and verify every chain
 * pointer - then checks two more things:
 *
 * 1. projection: replaying events must reproduce the persisted
 *    state.json (a mismatch means state or log was edited after the
 *    fact, or the projection is stale).
 * 2. attestation: if the run attested its prefix, recompute the heads
 *    over events 1..N and compare; events appended after N are reported
 *    as legitimate post-run extension, not tampering.
 */

export interface ReplayReport {
  runId: string;
  ok: boolean;
  eventCount: number;
  chainStatus: "chained" | "legacy";
  evidenceCount: number;
  projectionMatches: boolean;
  projectionDiffs: string[];
  attestation: "verified" | "extended-after-attestation" | "missing" | "broken";
  attestationDetail?: string;
}

function stateDiffs(persisted: RunState, replayed: RunState): string[] {
  const diffs: string[] = [];
  if (persisted.status !== replayed.status) diffs.push(`status: persisted ${persisted.status}, replayed ${replayed.status}`);
  if (persisted.resultRevision !== replayed.resultRevision) diffs.push(`resultRevision: persisted ${persisted.resultRevision ?? "-"}, replayed ${replayed.resultRevision ?? "-"}`);
  if (persisted.modelCalls !== replayed.modelCalls) diffs.push(`modelCalls: persisted ${persisted.modelCalls}, replayed ${replayed.modelCalls}`);
  if (persisted.replans !== replayed.replans) diffs.push(`replans: persisted ${persisted.replans}, replayed ${replayed.replans}`);
  for (const id of new Set([...Object.keys(persisted.tasks), ...Object.keys(replayed.tasks)])) {
    const a = persisted.tasks[id];
    const b = replayed.tasks[id];
    if (!a || !b || a.status !== b.status || a.attempt !== b.attempt) {
      diffs.push(`task ${id}: persisted ${a ? `${a.status}/${a.attempt}` : "absent"}, replayed ${b ? `${b.status}/${b.attempt}` : "absent"}`);
    }
  }
  for (const id of new Set([...Object.keys(persisted.requirements), ...Object.keys(replayed.requirements)])) {
    const a = persisted.requirements[id];
    const b = replayed.requirements[id];
    if (!a || !b || a.status !== b.status) {
      diffs.push(`requirement ${id}: persisted ${a?.status ?? "absent"}, replayed ${b?.status ?? "absent"}`);
    }
  }
  return diffs;
}

export function replayRun(runsDir: string, runId: string, plan: Plan | null): ReplayReport {
  const meta = loadRunMeta(runsDir, runId);
  if (!meta) {
    throw new SpcError(RUNTIME_ERROR, `no run ${runId} under ${runsDir}`);
  }
  const dir = path.join(runsDir, runId);

  // Strict loads: corrupted interior lines, broken chain pointers and
  // digest mismatches all throw from here.
  const events = new EventStore(path.join(dir, "events.jsonl"), runId);
  events.load();
  const evidence = new EvidenceStore(path.join(dir, "evidence.jsonl"));
  evidence.load();

  const replayed = projectState(meta, plan, events.all());
  const stateFile = path.join(dir, "state.json");
  let projectionMatches = true;
  let projectionDiffs: string[] = [];
  if (existsSync(stateFile)) {
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
    projectionDiffs = stateDiffs(persisted, replayed);
    projectionMatches = projectionDiffs.length === 0;
  } else {
    projectionDiffs = ["state.json missing; replayed state is the only projection"];
  }

  // Prefix attestation check.
  let attestation: ReplayReport["attestation"] = "missing";
  let attestationDetail: string | undefined;
  const attestationFile = path.join(dir, "attestation.json");
  if (existsSync(attestationFile)) {
    const recorded = JSON.parse(readFileSync(attestationFile, "utf8")) as RunAttestation;
    const all = events.all();
    const prefix = all.slice(0, recorded.eventCount);
    if (prefix.length < recorded.eventCount) {
      attestation = "broken";
      attestationDetail = `attested ${recorded.eventCount} events but the log holds ${all.length}`;
    } else {
      const headAtN = prefix.length > 0 ? digestOf(prefix[prefix.length - 1]!) : "sha256:" + "0".repeat(64);
      const evHead = evidenceHeadOf([...evidence.all()]);
      if (headAtN !== recorded.eventChainHead || evHead !== recorded.evidenceHead) {
        attestation = "broken";
        attestationDetail = "recomputed heads over the attested prefix do not match the recorded commitment";
      } else if (all.length > recorded.eventCount) {
        const extensions = all.slice(recorded.eventCount);
        if (extensions.every((e) => e.type === "RUN_ATTESTED")) {
          // The attestation event itself extends the chain after the
          // prefix it covers; that is completion, not extension.
          attestation = "verified";
          attestationDetail = "prefix commitment intact; RUN_ATTESTED event(s) extend the chain";
        } else {
          attestation = "extended-after-attestation";
          attestationDetail = `${all.length - recorded.eventCount} legitimate post-attestation event(s); prefix commitment intact`;
        }
      } else {
        attestation = "verified";
      }
    }
  }

  const ok = projectionMatches && attestation !== "broken";
  return {
    runId,
    ok,
    eventCount: events.length,
    chainStatus: events.chainStatus ?? "legacy",
    evidenceCount: evidence.all().length,
    projectionMatches,
    projectionDiffs,
    attestation,
    ...(attestationDetail ? { attestationDetail } : {}),
  };
}
