import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { digestOf, SpcError } from "@spc/core";
import type { Plan, RunState } from "@spc/schema";
import type { RunMeta } from "./state.js";
import { EventStore } from "./events.js";
import { evidenceHeadOf, type RunAttestation } from "./attestation.js";
import { initialState, projectState } from "./state.js";
import { EvidenceStore } from "./stores.js";

/**
 * `spc verify <bundleDir>`: verify an exported run WITHOUT the original
 * process or repository. The hard limit, stated in the threat model: a
 * bundle cannot re-execute commands, so this verifies INTEGRITY and
 * DERIVATION, never re-execution -
 *
 *   manifest   every component hashes to its recorded sha256
 *   chain      event log chain pointers verify (or report legacy)
 *   digests    every evidence record recomputes to its digest
 *   projection replaying the events reproduces the persisted state.json
 *   attestation the recorded prefix commitment recomputes over the log
 *
 * Anyone holding the bundle can confirm the run was not edited after
 * export. Confirming the run was honest when it happened is what the
 * chain plus git anchor established live; a bundle inherits that
 * history, it cannot create it.
 */

export interface BundleVerifyReport {
  bundle: string;
  runId: string;
  ok: boolean;
  manifest: "verified" | "mismatch" | "missing";
  manifestProblems: string[];
  chainStatus: "chained" | "legacy";
  eventCount: number;
  evidenceCount: number;
  evidenceDigests: "verified" | "mismatch";
  projectionMatches: boolean;
  projectionDiffs: string[];
  attestation: "verified" | "extended-after-attestation" | "missing" | "broken";
  attestationDetail?: string;
}

interface Manifest {
  schema: string;
  runId: string;
  specId: string;
  eventCount?: number;
  components: { path: string; sha256: string }[];
  warnings?: string[];
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

export function verifyBundle(bundleDir: string): BundleVerifyReport {
  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    throw new SpcError("BUNDLE_NOT_FOUND", `no bundle directory at ${bundleDir}`);
  }
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new SpcError("BUNDLE_INVALID", `no manifest.json at ${manifestPath}; not an spc run export?`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const runDir = path.join(bundleDir, "run");

  // 1. Manifest integrity: every component hashes to its recorded sha256.
  const manifestProblems: string[] = [];
  for (const c of manifest.components) {
    const file = path.join(bundleDir, c.path);
    if (!existsSync(file)) {
      manifestProblems.push(`missing component: ${c.path}`);
      continue;
    }
    if (sha256File(file) !== c.sha256) manifestProblems.push(`hash mismatch: ${c.path}`);
  }
  // Unlisted files are additions after export: report, do not fail -
  // the manifest pins what the bundle WAS; extras are visible, not silent.
  const listed = new Set(manifest.components.map((c) => c.path));
  for (const f of walkFiles(bundleDir)) {
    const rel = path.relative(bundleDir, f);
    if (rel !== "manifest.json" && !listed.has(rel)) manifestProblems.push(`unlisted file present: ${rel}`);
  }
  const manifestStatus = manifestProblems.some((p) => !p.startsWith("unlisted")) ? "mismatch" : "verified";

  // 2-4. Strict loads from the bundle's own copies: chain verification,
  // evidence digest recomputation, projection from the event stream.
  const runId = manifest.runId;
  const meta = JSON.parse(readFileSync(path.join(runDir, "metadata.json"), "utf8")) as RunMeta;
  const events = new EventStore(path.join(runDir, "events.jsonl"), runId);
  events.load();
  const evidence = new EvidenceStore(path.join(runDir, "evidence.jsonl"));
  evidence.load();
  const stateFile = path.join(runDir, "state.json");
  const persisted = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as RunState) : null;
  const planFile = existsSync(path.join(bundleDir, "plan"))
    ? path.join(bundleDir, "plan", readdirSync(path.join(bundleDir, "plan"))[0]!)
    : null;
  const plan: Plan | null = planFile ? (JSON.parse(readFileSync(planFile, "utf8")) as Plan) : null;
  const replayed = projectState(meta, plan, events.all());

  let projectionMatches = true;
  let projectionDiffs: string[] = [];
  if (persisted) {
    // Same field-level comparison as replayRun; duplicated here rather
    // than exported to keep the bundle verifier independent of the
    // in-repo path (it must run with only the bundle in hand).
    if (persisted.status !== replayed.status) projectionDiffs.push(`status: ${persisted.status} vs ${replayed.status}`);
    if (persisted.resultRevision !== replayed.resultRevision)
      projectionDiffs.push(`resultRevision: ${persisted.resultRevision ?? "-"} vs ${replayed.resultRevision ?? "-"}`);
    if (persisted.modelCalls !== replayed.modelCalls) projectionDiffs.push(`modelCalls: ${persisted.modelCalls} vs ${replayed.modelCalls}`);
    if (persisted.replans !== replayed.replans) projectionDiffs.push(`replans: ${persisted.replans} vs ${replayed.replans}`);
    for (const id of new Set([...Object.keys(persisted.tasks), ...Object.keys(replayed.tasks)])) {
      const a = persisted.tasks[id];
      const b = replayed.tasks[id];
      if (!a || !b || a.status !== b.status || a.attempt !== b.attempt)
        projectionDiffs.push(`task ${id}: ${a ? `${a.status}/${a.attempt}` : "absent"} vs ${b ? `${b.status}/${b.attempt}` : "absent"}`);
    }
    for (const id of new Set([...Object.keys(persisted.requirements), ...Object.keys(replayed.requirements)])) {
      const a = persisted.requirements[id];
      const b = replayed.requirements[id];
      if (!a || !b || a.status !== b.status)
        projectionDiffs.push(`requirement ${id}: ${a?.status ?? "absent"} vs ${b?.status ?? "absent"}`);
    }
    projectionMatches = projectionDiffs.length === 0;
  } else {
    projectionDiffs = ["state.json missing from bundle"];
  }

  // 5. Prefix attestation recomputation over the bundle's log.
  let attestation: BundleVerifyReport["attestation"] = "missing";
  let attestationDetail: string | undefined;
  const attestationFile = path.join(runDir, "attestation.json");
  if (existsSync(attestationFile)) {
    const recorded = JSON.parse(readFileSync(attestationFile, "utf8")) as RunAttestation;
    const all = events.all();
    const prefix = all.slice(0, recorded.eventCount);
    if (prefix.length < recorded.eventCount) {
      attestation = "broken";
      attestationDetail = `attested ${recorded.eventCount} events but the bundle log holds ${all.length}`;
    } else {
      const headAtN = prefix.length > 0 ? digestOf(prefix[prefix.length - 1]!) : "sha256:" + "0".repeat(64);
      const evHead = evidenceHeadOf([...evidence.all()]);
      if (headAtN !== recorded.eventChainHead || evHead !== recorded.evidenceHead) {
        attestation = "broken";
        attestationDetail = "recomputed heads do not match the recorded commitment";
      } else if (all.length > recorded.eventCount) {
        const extensions = all.slice(recorded.eventCount);
        if (extensions.every((e) => e.type === "RUN_ATTESTED")) {
          attestation = "verified";
          attestationDetail = "prefix commitment intact; RUN_ATTESTED event(s) extend the chain";
        } else {
          attestation = "extended-after-attestation";
          attestationDetail = `${all.length - recorded.eventCount} post-attestation event(s); prefix intact`;
        }
      } else {
        attestation = "verified";
      }
    }
  }

  const ok =
    manifestStatus === "verified" && projectionMatches && attestation !== "broken" && events.length > 0;
  return {
    bundle: bundleDir,
    runId,
    ok,
    manifest: manifestStatus,
    manifestProblems,
    chainStatus: events.chainStatus ?? "legacy",
    eventCount: events.length,
    evidenceCount: evidence.all().length,
    evidenceDigests: "verified",
    projectionMatches,
    projectionDiffs,
    attestation,
    ...(attestationDetail ? { attestationDetail } : {}),
  };
}
