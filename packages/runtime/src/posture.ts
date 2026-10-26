import { readFileSync } from "node:fs";
import path from "node:path";
import { git, statusPorcelain } from "@spc/repo";
import type { SpecIR } from "@spc/schema";
import { listRunIds, loadRunMeta } from "./run.js";
import { loadRunView, configDigestOf } from "./queries.js";

/**
 * Derived spec posture (spec-posture ruling, 2026-10-26): the
 * lifecycle is a REPORTING VOCABULARY computed from the run records
 * and the shared tracked-drift predicate - never persisted, never an
 * event, never enforcement. The ruling's central distinction: a RUN
 * establishes what its evidence supports; its KIND determines which
 * operational optimizations may reuse it. Any latest valid
 * digest-matching run establishes posture; verify-kind remains a
 * cache-eligibility requirement only (freshnessCheck's).
 *
 * Evaluation order is fixed: unverified (no valid run for the current
 * digest - a successor digest never inherits its predecessor's
 * posture), then active (unresolved musts - unresolved work takes
 * precedence over staleness), then the drift predicate against the
 * run's evidence anchor deciding stale versus standing.
 */

export type SpecPosture = "standing" | "active" | "unverified" | "stale";

export interface PostureResult {
  posture: SpecPosture;
  reason: string;
}

export interface DriftResult {
  drifted: boolean;
  reason?: string;
}

/**
 * The shared tracked-drift predicate: have the tracked inputs moved
 * since the anchor revision? Dirty working tree, missing anchor,
 * config digest change, broken ancestry, or any tracked diff. This is
 * FRESHNESS - what the evidence describes versus what the tree is now.
 * Cache ELIGIBILITY (freshnessCheck) adds its own requirements on top
 * (verify-kind, clean verified tree); the two must never be conflated
 * - a run can establish fresh evidence without being reusable as a
 * cache hit, and treating the latter as the former would make green
 * apply runs read unverified.
 */
export function trackedDrift(repoRoot: string, anchorRevision: string | null | undefined, expectedConfigDigest?: string): DriftResult {
  if (!anchorRevision) return { drifted: true, reason: "evidence anchor revision is not recorded" };
  if (statusPorcelain(repoRoot).dirty) return { drifted: true, reason: "working tree is dirty" };
  const configPath = path.join(repoRoot, ".spc", "config.yaml");
  if (expectedConfigDigest && expectedConfigDigest !== configDigestOf(configPath)) {
    return { drifted: true, reason: "config changed since the run executed" };
  }
  const ancestor = git(repoRoot, ["merge-base", "--is-ancestor", anchorRevision, "HEAD"]);
  if (!ancestor.ok) return { drifted: true, reason: "evidence anchor is not an ancestor of HEAD" };
  const diff = git(repoRoot, ["diff", "--name-only", `${anchorRevision}..HEAD`]);
  if (!diff.ok) return { drifted: true, reason: "git comparison failed" };
  if (diff.stdout.trim() !== "") return { drifted: true, reason: "tracked changes since the evidence anchor" };
  return { drifted: false };
}

export function postureFor(specIr: SpecIR, runsDir: string, repoRoot: string): PostureResult {
  // Newest-first valid (loadable) runs for THIS digest only: a
  // successor digest never inherits its predecessor's posture.
  const candidates = listRunIds(runsDir)
    .map((id) => ({ id, meta: loadRunMeta(runsDir, id) }))
    .filter((x) => x.meta && x.meta.specId === specIr.spec.metadata.id && x.meta.specDigest === specIr.digest)
    .sort((a, b) => ((a.meta!.createdAt ?? "") < (b.meta!.createdAt ?? "") ? 1 : -1));
  let latest: { id: string; state: { requirements?: Record<string, { status?: string }>; resultRevision?: string } } | null = null;
  let latestMeta: ReturnType<typeof loadRunMeta> = null;
  for (const c of candidates) {
    try {
      const view = loadRunView(runsDir, c.id);
      if (!view) continue; // no records at all: not a valid run
      latest = { id: c.id, state: view.state as never };
      latestMeta = c.meta;
      break;
    } catch {
      // corrupt records are not valid runs: skipped, not evidence
    }
  }
  if (!latest || !latestMeta) {
    return { posture: "unverified", reason: "no valid run for the current digest" };
  }

  const musts = specIr.properties.filter((p) => p.priority === "must");
  const unresolved = musts.filter((p) => {
    const s = latest!.state.requirements?.[p.id]?.status;
    return s !== "satisfied" && s !== "waived";
  });
  if (unresolved.length > 0) {
    return {
      posture: "active",
      reason: `unresolved work: ${unresolved.length} must propert${unresolved.length === 1 ? "y" : "ies"} not satisfied - takes precedence over staleness`,
    };
  }

  // Green: freshness against the run's evidence anchor. A verify run's
  // evidence binds to its base revision (and is unreconstructable if
  // recorded against a dirty tree); an apply run's binds to the
  // result revision it verified.
  if (latestMeta.kind === "verify") {
    const eventsFile = path.join(runsDir, latest.id, "events.jsonl");
    try {
      const first = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean)[0];
      const firstEvent = first ? (JSON.parse(first) as { type?: string; payload?: { dirty?: boolean } }) : null;
      if (firstEvent?.type !== "RUN_CREATED" || firstEvent.payload?.dirty !== false) {
        return { posture: "stale", reason: "evidence recorded against a dirty tree - freshness cannot be established" };
      }
    } catch {
      return { posture: "stale", reason: "run events unreadable - freshness cannot be established" };
    }
  }
  const anchor = latestMeta.kind === "apply" ? (latest.state.resultRevision ?? latestMeta.baseRevision) : latestMeta.baseRevision;
  const drift = trackedDrift(repoRoot, anchor, latestMeta.configDigest);
  if (drift.drifted) {
    return { posture: "stale", reason: drift.reason ?? "tracked inputs have drifted" };
  }
  return { posture: "standing", reason: `all musts green at ${(anchor ?? "?").slice(0, 12)}; tracked inputs unchanged` };
}
