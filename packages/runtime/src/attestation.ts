import { writeFileSync } from "node:fs";
import path from "node:path";
import { digestOf } from "@spc/core";
import { commitEmpty } from "@spc/repo";
import type { Evidence, RunStatus } from "@spc/schema";
import type { EventStore } from "./events.js";
import type { EvidenceStore } from "./stores.js";
import type { RunContext } from "./apply.js";

/**
 * Prefix attestation (IDEAS 3a): at run completion, commit to what the
 * run was - events 1..N with chain head H_N, evidence head E_N, result
 * revision R, status S. Later legitimate events (followup resolutions)
 * extend the chain without invalidating this commitment: extension is
 * not rewriting.
 *
 * The commitment is written to attestation.json in the run directory and
 * recorded as RUN_ATTESTED (which itself extends the chain, after the
 * prefix it covers). Git anchoring (verification.attestInGit) adds an
 * empty commit on the run branch carrying the commitment as trailers -
 * content addressing then protects the anchored heads against any
 * attacker who can rewrite the log but not git history.
 */

export interface RunAttestation {
  schema: "spc-run-attestation/1";
  runId: string;
  specId: string;
  status: RunStatus;
  eventCount: number;
  eventChainHead: string;
  evidenceHead: string;
  resultRevision?: string;
  attestedAt: string;
  /**
   * Identity of the git anchor commit when one was created. Replay reads
   * it back - and also finds anchors independently by scanning history,
   * so a forger cannot hide behind a stripped field.
   */
  gitAnchor?: { ref: string; commit: string };
}

/** Digest committing to the ordered evidence list: ids and digests. */
export function evidenceHeadOf(evidence: readonly Evidence[]): string {
  return digestOf(evidence.map((e) => ({ id: e.id, digest: e.digest })));
}

export function attestRun(ctx: RunContext, status: RunStatus, resultRevision?: string): RunAttestation {
  const eventCount = ctx.events.length;
  const eventChainHead = ctx.events.chainHead() ?? "sha256:" + "0".repeat(64);
  const evidenceHead = evidenceHeadOf([...ctx.evidence.all()]);
  // Git anchor: an empty commit on the run branch carrying the
  // commitment. Opt-in - in current-branch in-place mode it is skipped
  // to avoid surprise commits on the user's own branch. The commit is
  // created BEFORE the attestation is written so the record can carry
  // the anchor's identity for replay to read back.
  const inPlaceCurrent =
    ctx.config.execution.inPlace && ctx.config.execution.inPlaceBranch === "current";
  let gitAnchor: { ref: string; commit: string } | undefined;
  if (ctx.config.verification.attestInGit && ctx.worktreePath && !inPlaceCurrent) {
    const branch = ctx.worktreeBranch ?? ctx.meta.branch;
    const commit = commitEmpty(ctx.worktreePath, `spc: attest run ${ctx.meta.runId} (status ${status})`, {
      "SPC-Run-Id": ctx.meta.runId,
      "SPC-Attestation-Event-Count": String(eventCount),
      "SPC-Attestation-Event-Head": eventChainHead,
      "SPC-Attestation-Evidence-Head": evidenceHead,
    });
    gitAnchor = { ref: `refs/heads/${branch}`, commit };
  } else if (ctx.config.verification.attestInGit && inPlaceCurrent) {
    ctx.log("attestation: recorded in run directory only (inPlaceBranch current would land an empty commit on your branch)");
  }
  const attestation = {
    schema: "spc-run-attestation/1" as const,
    runId: ctx.meta.runId,
    specId: ctx.meta.specId,
    status,
    eventCount,
    eventChainHead,
    evidenceHead,
    ...(resultRevision ? { resultRevision } : {}),
    attestedAt: ctx.now(),
    ...(gitAnchor ? { gitAnchor } : {}),
  };
  writeFileSync(path.join(ctx.paths.runDir(ctx.meta.runId), "attestation.json"), JSON.stringify(attestation, null, 2) + "\n", "utf8");
  ctx.events.append("RUN_ATTESTED", { ...attestation });
  return attestation;
}

/**
 * Slim attestation for flows without a RunContext (standalone verify,
 * cancellation): same prefix commitment, no git anchor (verify runs
 * have no run branch). Written AFTER the terminal event so the
 * commitment covers the complete execution prefix.
 */
export function attestRecords(input: {
  runDir: string;
  runId: string;
  specId: string;
  status: RunStatus;
  events: EventStore;
  evidence: readonly Evidence[];
  now: () => string;
}): RunAttestation {
  const eventCount = input.events.length;
  const eventChainHead = input.events.chainHead() ?? "sha256:" + "0".repeat(64);
  const evidenceHead = evidenceHeadOf(input.evidence);
  const attestation: RunAttestation = {
    schema: "spc-run-attestation/1",
    runId: input.runId,
    specId: input.specId,
    status: input.status,
    eventCount,
    eventChainHead,
    evidenceHead,
    attestedAt: input.now(),
  };
  writeFileSync(path.join(input.runDir, "attestation.json"), JSON.stringify(attestation, null, 2) + "\n", "utf8");
  input.events.append("RUN_ATTESTED", { ...attestation });
  return attestation;
}
