import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git, statusPorcelain } from "@spc/repo";
import type { SpecIR } from "@spc/schema";
import { listRunIds, loadRunMeta } from "./run.js";
import { configDigestOf, loadRunView } from "./queries.js";
import { trackedDrift } from "./posture.js";

export interface FreshnessResult {
  cached: boolean;
  priorRunId?: string;
  reason?: string;
}

/**
 * Conservative cached-verification eligibility (board-staleness spec,
 * 2026-10-24): a prior green result is reusable ONLY when the repository
 * has ZERO tracked changes since the verified base - because
 * scope.include is a write boundary, not a verification-dependency
 * declaration, file criteria may point anywhere, and command criteria
 * can read the whole repository. Every unestablishable condition fails
 * OPEN to verification: an unverified change can never inherit
 * verified status.
 */
export function freshnessCheck(repoRoot: string, specIr: SpecIR, runsDir: string): FreshnessResult {
  const verify = (reason: string): FreshnessResult => ({ cached: false, reason });
  try {
    if (statusPorcelain(repoRoot).dirty) return verify("working tree is dirty");

    const candidates = listRunIds(runsDir)
      .map((id) => ({ id, meta: loadRunMeta(runsDir, id) }))
      .filter((x) => x.meta && x.meta.kind === "verify" && x.meta.specId === specIr.spec.metadata.id)
      .sort((a, b) => ((a.meta!.createdAt ?? "") < (b.meta!.createdAt ?? "") ? 1 : -1));
    const prior = candidates[0];
    if (!prior?.meta) return verify("no prior verify run for this spec");
    const meta = prior.meta;

    if (meta.specDigest !== specIr.digest) return verify("spec changed since the prior run");
    if (!meta.configDigest || meta.configDigest !== configDigestOf(path.join(repoRoot, ".spc", "config.yaml"))) {
      return verify("config changed since the prior run");
    }
    if (!meta.baseRevision) return verify("prior run has no recorded base revision");

    // The prior run must be fully loadable: its records are the cache's
    // provenance, and corrupt logs make the whole result untrustworthy.
    try {
      loadRunView(runsDir, prior.id);
    } catch (e) {
      return verify(`prior run records failed to load (${(e as Error).message.split("\n")[0]})`);
    }

    // The prior run verified a CLEAN tree: the RUN_CREATED event's dirty
    // flag, read from the log itself.
    const eventsFile = path.join(runsDir, prior.id, "events.jsonl");
    if (!existsSync(eventsFile)) return verify("prior run events unreadable");
    const firstLine = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean)[0];
    const firstEvent = firstLine ? (JSON.parse(firstLine) as { type?: string; payload?: { dirty?: boolean } }) : null;
    if (firstEvent?.type !== "RUN_CREATED" || firstEvent.payload?.dirty !== false) {
      return verify("prior run verified a dirty tree");
    }

    // The existing board predicate: every current property satisfied or
    // waived in the prior run's state.
    const stateFile = path.join(runsDir, prior.id, "state.json");
    if (!existsSync(stateFile)) return verify("prior run state unreadable");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
      requirements?: Record<string, { status?: string }>;
    };
    const allHeld = specIr.properties.every((p) => {
      const s = state.requirements?.[p.id]?.status;
      return s === "satisfied" || s === "waived";
    });
    if (!allHeld) return verify("prior run did not satisfy every property");

    // Freshness proper, via the shared predicate (postureFor uses the
    // same function with run-kind-appropriate anchors): ancestry and
    // the zero-tracked-changes rule. Cache eligibility's own
    // conditions all ran above; this is drift, nothing else.
    const drift = trackedDrift(repoRoot, meta.baseRevision, meta.configDigest);
    if (drift.drifted) return verify(drift.reason ?? "tracked inputs have drifted since the prior base");

    return { cached: true, priorRunId: prior.id };
  } catch (e) {
    return verify(`eligibility check failed (${(e as Error).message.split("\n")[0]})`);
  }
}
