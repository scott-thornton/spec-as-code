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
}

/** Digest committing to the ordered evidence list: ids and digests. */
export function evidenceHeadOf(evidence: readonly Evidence[]): string {
  return digestOf(evidence.map((e) => ({ id: e.id, digest: e.digest })));
}

export function attestRun(ctx: RunContext, status: RunStatus, resultRevision?: string): RunAttestation {
  const eventCount = ctx.events.length;
  const eventChainHead = ctx.events.chainHead() ?? "sha256:" + "0".repeat(64);
  const evidenceHead = evidenceHeadOf([...ctx.evidence.all()]);
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
  };
  writeFileSync(path.join(ctx.paths.runDir(ctx.meta.runId), "attestation.json"), JSON.stringify(attestation, null, 2) + "\n", "utf8");
  ctx.events.append("RUN_ATTESTED", { ...attestation });

  // Git anchor: an empty commit on the run branch carrying the
  // commitment. Opt-in - in current-branch in-place mode it is skipped
  // to avoid surprise commits on the user's own branch.
  const inPlaceCurrent =
    ctx.config.execution.inPlace && ctx.config.execution.inPlaceBranch === "current";
  if (ctx.config.verification.attestInGit && ctx.worktreePath && !inPlaceCurrent) {
    commitEmpty(ctx.worktreePath, `spc: attest run ${ctx.meta.runId} (status ${status})`, {
      "SPC-Run-Id": ctx.meta.runId,
      "SPC-Attestation-Event-Count": String(eventCount),
      "SPC-Attestation-Event-Head": eventChainHead,
      "SPC-Attestation-Evidence-Head": evidenceHead,
    });
  } else if (ctx.config.verification.attestInGit && inPlaceCurrent) {
    ctx.log("attestation: recorded in run directory only (inPlaceBranch current would land an empty commit on your branch)");
  }
  return attestation;
}
