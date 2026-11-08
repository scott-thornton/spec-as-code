import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSpecFile, createWorktree, removeWorktree } from "@spc/repo";
import { stageChanges } from "@spc/executor";
import { classifyChallenge, type ChallengeOutcome } from "@spc/verifier";
import { verifyProperties } from "./verify.js";
import { EventStore } from "./events.js";
import { EvidenceStore, FollowupStore } from "./stores.js";
import { loadConfig } from "./run.js";
import { spcPaths } from "./paths.js";

/**
 * The challenge engine (specs/criterion-challenge, CHAL-001/CHAL-005):
 * falsify an acceptance criterion with a committed negative fixture.
 * Two disposable git worktrees from one base revision - a pristine
 * baseline and a mutated artifact - each run a PIPELINE the runner
 * owns: a cold prepare (dependency install when a package root
 * exists; a forced build with ALL incremental state invalidated -
 * existing criteria redirect their build prefix to /dev/null and tsc
 * diagnostics ride stdout, so the signature would be invisible
 * through the criterion command alone), then the criterion through
 * the frozen criteria executor (host admission, timeout
 * classification, evidence shape - inherited by construction). The
 * outcome records to .spc/challenges/ - never the run store - and
 * both worktrees are cleaned on every exit path.
 *
 * Fixture format (challenges/<name>.yaml): metadata.id,
 * criterion.{spec,criterionId}, expectedSignature, provenance.*, and
 * opsJson - the mutation as an applicator-native change-ops JSON
 * array (single-quoted) on its own line.
 */

export interface ChallengeFixture {
  id: string;
  criterion: { spec: string; criterionId: string };
  mutation: { ops: unknown[] };
  expectedSignature: string;
  provenance: { introduced: string; caught: string; diagnostic: string };
  digest: string;
}

export interface ChallengeLegResult {
  outcome: "supports" | "contradicts" | "inconclusive";
  shape?: string;
  output: string;
  revision: string;
}

export interface ChallengeResult {
  outcome: ChallengeOutcome;
  baseline: ChallengeLegResult;
  mutation: ChallengeLegResult;
  record: Record<string, unknown>;
}


/** Resolve a spec id to its FILE PATH under specs/ (compiles each candidate). */
function specPathFor(specsDir: string, specId: string): string | null {
  if (!existsSync(specsDir)) return null;
  for (const f of readdirSync(specsDir).sort()) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const file = path.join(specsDir, f);
    try {
      const compiled = compileSpecFile(file);
      if (compiled.ok && compiled.ir && compiled.ir.spec.metadata.id === specId) return file;
    } catch {
      // unreadable candidate: skip
    }
  }
  return null;
}

function fixtureFile(repoRoot: string, name: string): string {
  return path.join(repoRoot, "challenges", `${name}.yaml`);
}

function scalar(text: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(text);
  if (!m) return undefined;
  const v = m[1]!.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

export function loadChallengeFixture(repoRoot: string, name: string): ChallengeFixture {
  const file = fixtureFile(repoRoot, name);
  if (!existsSync(file)) {
    throw new Error(`unknown challenge fixture: challenges/${name}.yaml does not exist`);
  }
  const text = readFileSync(file, "utf8");
  const id = scalar(text, "id");
  const spec = scalar(text, "spec");
  const criterionId = scalar(text, "criterionId");
  const expectedSignature = scalar(text, "expectedSignature");
  const opsRaw = scalar(text, "opsJson");
  if (!id || !spec || !criterionId || !expectedSignature || !opsRaw) {
    throw new Error(`malformed challenge fixture ${file}: id, spec, criterionId, expectedSignature, and opsJson are required`);
  }
  let ops: unknown[];
  try {
    ops = JSON.parse(opsRaw) as unknown[];
  } catch {
    throw new Error(`malformed challenge fixture ${file}: opsJson is not a valid JSON array`);
  }
  if (!Array.isArray(ops)) {
    throw new Error(`malformed challenge fixture ${file}: opsJson is not an array`);
  }
  return {
    id,
    criterion: { spec, criterionId },
    mutation: { ops },
    expectedSignature,
    provenance: {
      introduced: scalar(text, "introduced") ?? "",
      caught: scalar(text, "caught") ?? "",
      diagnostic: scalar(text, "diagnostic") ?? "",
    },
    digest: "sha256:" + createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

export function challengeRecordPath(repoRoot: string, name: string): string {
  return path.join(repoRoot, ".spc", "challenges", `${name}.json`);
}

function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300_000 });
  return `$ ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/** The cold prepare: install (when a package root exists) + forced build with ALL incremental state invalidated. Output captured, never silent. */
function coldPrepare(worktree: string): string {
  if (!existsSync(path.join(worktree, "package.json"))) return "(no package root - prepare skipped)";
  let out = sh(worktree, "pnpm", ["install", "--frozen-lockfile", "--offline"]);
  // Invalidate ALL incremental build state (the patch-fresh-build
  // doctrine): stale tsbuildinfo masked the original defect.
  const invalidate = (dir: string): void => {
    const skip = new Set(["node_modules", ".git", "dist"]);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) invalidate(full);
      else if (entry.name.endsWith(".tsbuildinfo")) rmSync(full, { force: true });
    }
  };
  invalidate(worktree);
  out += sh(worktree, "pnpm", ["-r", "run", "build"]);
  return out;
}

interface CriterionRun {
  outcome: "supports" | "contradicts" | "inconclusive";
  shape?: string;
  output: string;
}

/** Execute the single frozen criterion in the worktree through the criteria executor. */
async function runCriterion(worktree: string, specId: string, criterionId: string): Promise<CriterionRun> {
  const specFile = specPathFor(path.join(worktree, "specs"), specId) ?? path.join(worktree, "specs", `${specId}.yaml`);
  const compiled = compileSpecFile(specFile);
  if (!compiled.ok || !compiled.ir) throw new Error(`challenge criterion spec ${specFile} does not compile: ${JSON.stringify(compiled.diagnostics).slice(0, 600)}`);
  const property = compiled.ir.properties.find((p) => p.acceptance.some((c) => c.id === criterionId));
  if (!property) throw new Error(`challenge criterion ${criterionId} not found in ${specFile}`);
  const acceptance = property.acceptance.filter((c) => c.id === criterionId);

  const now = () => new Date().toISOString();
  const scratch = path.join(os.tmpdir(), `spc-chal-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const events = new EventStore(path.join(scratch, "events.jsonl"), "challenge", now);
    const evidence = new EvidenceStore(path.join(scratch, "evidence.jsonl"));
    const followups = new FollowupStore(path.join(scratch, "followups.json"));
    const config = loadConfig(spcPaths(worktree).configPath);
    const sweep = await verifyProperties({
      properties: [{ ...property, acceptance }],
      runId: "challenge",
      cwd: worktree,
      revision: "challenge",
      config,
      provider: null,
      events,
      evidence,
      followups,
    });
    const state = sweep.states[0];
    const records = [...evidence.all()];
    const ev = records.find((r) => r.criterionId === criterionId) ?? records[0];
    const payload = (ev?.payload ?? {}) as Record<string, unknown>;
    const outcome =
      state?.status === "satisfied" ? "supports" : state?.status === "unsatisfied" ? "contradicts" : "inconclusive";
    // The pipeline output for a leg: command stdout/stderr/reason when
    // present, else the whole evidence payload serialized (file criteria
    // carry their observations structurally - path, checks, observed).
    const textual = [payload["stdout"], payload["stderr"], payload["reason"]]
      .filter((v) => typeof v === "string")
      .join("\n");
    const output = textual.trim() !== "" ? textual : JSON.stringify(payload);
    return { outcome, shape: payload["failureShape"] as string | undefined, output };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Apply mutation ops through the applicator's exact semantics; a non-applying mutation is a named refusal.
 *  Fixture patch ops are anchor-based (replayable across revisions): the
 *  engine binds each op's baseDigest to THIS worktree's file content at
 *  apply time - the applicator's digest validation then holds exactly
 *  (anchor gone or content moved -> not applicable -> inconclusive). */
function applyMutation(worktree: string, rawOps: unknown[]): { ok: boolean; detail: string } {
  const ops = rawOps.map((o) => {
    const op = o as { op?: string; path?: string; baseDigest?: string };
    if (op && op.op === "patch" && op.path !== undefined && op.baseDigest === undefined) {
      try {
        const content = readFileSync(path.join(worktree, op.path), "utf8");
        return { ...op, baseDigest: "sha256:" + createHash("sha256").update(content, "utf8").digest("hex") };
      } catch {
        return o; // unreadable target: the applicator names it
      }
    }
    return o;
  });
  const staged = stageChanges(worktree, ops as never);
  if (!staged.ok) return { ok: false, detail: `${staged.code}: ${staged.message}` };
  for (const w of staged.writes) {
    mkdirSync(path.dirname(path.join(worktree, w.path)), { recursive: true });
    writeFileSync(path.join(worktree, w.path), w.content, "utf8");
  }
  for (const d of staged.deletes) rmSync(path.join(worktree, d), { force: true });
  return { ok: true, detail: `${staged.writes.length} write(s), ${staged.deletes.length} delete(s)` };
}

export async function runChallenge(repoRoot: string, name: string): Promise<ChallengeResult> {
  const fixture = loadChallengeFixture(repoRoot, name);
  const baseRevision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const worktreesDir = path.join(repoRoot, ".spc", "worktrees");

  let baselineWt: string | null = null;
  let mutationWt: string | null = null;
  try {
    baselineWt = createWorktree(repoRoot, fixture.criterion.spec, `${name}--baseline`, worktreesDir).path;
    mutationWt = createWorktree(repoRoot, fixture.criterion.spec, `${name}--mutation`, worktreesDir).path;

    // Baseline pipeline: cold prepare + frozen criterion, pristine.
    const baselinePrepare = coldPrepare(baselineWt);
    const baselineRun = await runCriterion(baselineWt, fixture.criterion.spec, fixture.criterion.criterionId);
    const baseline: ChallengeLegResult = {
      ...baselineRun,
      output: baselinePrepare + "\n" + baselineRun.output,
      revision: baseRevision,
    };

    // Mutation pipeline: apply the ops, cold prepare, criterion.
    const applied = applyMutation(mutationWt, fixture.mutation.ops);
    let mutation: ChallengeLegResult;
    if (!applied.ok) {
      mutation = { outcome: "inconclusive", output: `mutation not applicable: ${applied.detail}`, revision: baseRevision };
    } else {
      const mutationPrepare = coldPrepare(mutationWt);
      const mutationRun = await runCriterion(mutationWt, fixture.criterion.spec, fixture.criterion.criterionId);
      mutation = {
        ...mutationRun,
        output: mutationPrepare + "\n" + mutationRun.output,
        revision: baseRevision,
      };
    }

    const signaturePresent = mutation.output.includes(fixture.expectedSignature);
    const outcome = classifyChallenge({
      baseline: baseline.outcome,
      mutation: mutation.outcome,
      signaturePresent,
      baselineShape: baseline.shape,
      mutationShape: mutation.shape,
    });

    const record: Record<string, unknown> = {
      fixture: fixture.id,
      fixtureDigest: fixture.digest,
      criterion: fixture.criterion,
      outcome,
      baseline: { outcome: baseline.outcome, revision: baseline.revision, ...(baseline.shape ? { failureShape: baseline.shape } : {}) },
      mutation: { outcome: mutation.outcome, revision: mutation.revision, ...(mutation.shape ? { failureShape: mutation.shape } : {}) },
      signaturePresent,
      expectedSignature: fixture.expectedSignature,
      ...(signaturePresent
        ? { signatureLine: mutation.output.split("\n").find((l) => l.includes(fixture.expectedSignature)) ?? "" }
        : {}),
      provenance: fixture.provenance,
      timestamp: new Date().toISOString(),
    };
    mkdirSync(path.join(repoRoot, ".spc", "challenges"), { recursive: true });
    writeFileSync(challengeRecordPath(repoRoot, name), JSON.stringify(record, null, 2), "utf8");

    return { outcome, baseline, mutation, record };
  } finally {
    if (baselineWt) removeWorktree(repoRoot, baselineWt);
    if (mutationWt) removeWorktree(repoRoot, mutationWt);
  }
}
