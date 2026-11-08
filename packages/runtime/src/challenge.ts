import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSpecFile, createWorktree, removeWorktree } from "@spc/repo";
import { stageChanges } from "@spc/executor";
import { acquireHostAdmission, classifyChallenge, type ChallengeOutcome } from "@spc/verifier";
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
 * prepare itself rides host admission too (CHAL-C01): it is the
 * heaviest subprocess a challenge spawns, and a refusal or an
 * environment failure makes the leg inconclusive - never a wait,
 * never a laundered criterion verdict. The outcome records to
 * .spc/challenges/ - never the run store - and both worktrees are
 * cleaned on every exit path.
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
  /** Command execution identities observed by this leg (empty when the criterion never executed). */
  executionIds: string[];
  /** Digest of the compiled criterion this leg actually challenged (present when the criterion executed; per-leg because a mutation may target the spec itself). */
  criterionDigest?: string;
}

export interface ChallengeResult {
  outcome: ChallengeOutcome;
  baseline: ChallengeLegResult;
  mutation: ChallengeLegResult;
  record: Record<string, unknown>;
}

/** The cold prepare outcome. ok=false is an ENVIRONMENT verdict
 *  (admission refused, install failure, spawn kill) - the leg becomes
 *  inconclusive, never a criterion verdict. buildFailed=true with
 *  ok=true is the DESIGNED detection surface: build diagnostics ride
 *  the pipeline output, and the inaugural fixture's TS4104 fails
 *  exactly this way. */
export interface PrepareResult {
  output: string;
  /** Host admission refused - another fresh verification subprocess holds the host. */
  refused: boolean;
  /** The environment prepared (a nonzero build exit can still be ok - see buildFailed). */
  ok: boolean;
  /** The build exited nonzero; its diagnostics are part of the captured output. */
  buildFailed: boolean;
  /** Which stage failed when ok is false. */
  failureStage?: "install" | "build";
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

function sh(cwd: string, cmd: string, args: string[]): { output: string; status: number | null; error: boolean } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300_000 });
  return {
    output: `$ ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}`,
    status: r.status,
    error: Boolean(r.error),
  };
}

/** The cold prepare: install (when a package root exists) + forced build with ALL incremental state invalidated. Output captured, never silent. Admits on the host lock (CHAL-C01): a refusal is a named inconclusive, never a wait. */
export function coldPrepare(worktree: string): PrepareResult {
  if (!existsSync(path.join(worktree, "package.json"))) {
    return { output: "(no package root - prepare skipped)", refused: false, ok: true, buildFailed: false };
  }
  // NOTE: when a challenge executes INSIDE a criteria command (the
  // CHAL-004-A oracle runs `spc challenge` under the executor, which
  // holds the host admission for the whole command), this inner
  // acquire avoids self-refusal only because the test setups pin
  // SPC_ADMISSION_LOCK per worker and the spawned CLI inherits it -
  // removing that pin flips the inaugural oracle red (delta review).
  const admission = acquireHostAdmission();
  if (!admission) {
    return {
      output: "$ pnpm install --frozen-lockfile --offline\nadmission refused: another fresh verification subprocess holds the host - refuse, never wait",
      refused: true,
      ok: false,
      buildFailed: false,
    };
  }
  try {
    const install = sh(worktree, "pnpm", ["install", "--frozen-lockfile", "--offline"]);
    let out = install.output;
    if (install.error || install.status !== 0) {
      return { output: out, refused: false, ok: false, buildFailed: false, failureStage: "install" };
    }
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
    const build = sh(worktree, "pnpm", ["-r", "run", "build"]);
    out += build.output;
    // A killed build is an environment failure, not the designed
    // detection surface: r.error covers spawn failure and the 300s
    // timeout, but an EXTERNAL signal kill (host OOM) leaves status
    // null with no error - only a clean nonzero EXIT with captured
    // diagnostics counts as buildFailed (adversarial delta review).
    if (build.error || build.status === null) {
      return { output: out, refused: false, ok: false, buildFailed: false, failureStage: "build" };
    }
    return { output: out, refused: false, ok: true, buildFailed: build.status !== 0 };
  } finally {
    admission.release();
  }
}

interface CriterionRun {
  outcome: "supports" | "contradicts" | "inconclusive";
  shape?: string;
  output: string;
  executionIds: string[];
  criterionDigest: string;
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
    // Command execution identities, collected before the scratch store
    // is deleted (CHAL-005: the record must trace to its executions).
    const executionIds = records
      .map((r) => (r.payload as Record<string, unknown>)["executionId"])
      .filter((v): v is string => typeof v === "string");
    // The challenged criterion definition, digest-pinned (CHAL-005): a
    // spec edit silently changes what was challenged unless the record
    // carries what ran. Per-leg: a mutation may target the spec itself.
    const criterionDigest =
      "sha256:" + createHash("sha256").update(JSON.stringify(acceptance[0]), "utf8").digest("hex");
    return { outcome, shape: payload["failureShape"] as string | undefined, output, executionIds, criterionDigest };
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

    // Baseline pipeline: cold prepare + frozen criterion, pristine. A
    // prepare that cannot run (admission refused, install failure,
    // spawn kill) makes the leg inconclusive - environment uncertainty
    // is never a criterion verdict (CHAL-002). A nonzero BUILD exit is
    // allowed and rides the output: the detection surface itself.
    const baselinePrepare = coldPrepare(baselineWt);
    let baseline: ChallengeLegResult;
    if (!baselinePrepare.ok) {
      baseline = {
        outcome: "inconclusive",
        ...(baselinePrepare.refused ? { shape: "admission-refused" } : {}),
        output: `${baselinePrepare.output}\n(prepare failed${baselinePrepare.failureStage ? ` at ${baselinePrepare.failureStage}` : ""}: the environment did not prepare - never a criterion verdict)`,
        revision: baseRevision,
        executionIds: [],
      };
    } else {
      const baselineRun = await runCriterion(baselineWt, fixture.criterion.spec, fixture.criterion.criterionId);
      baseline = {
        ...baselineRun,
        output: baselinePrepare.output + "\n" + baselineRun.output,
        revision: baseRevision,
      };
    }

    // Mutation pipeline: apply the ops, cold prepare, criterion.
    const applied = applyMutation(mutationWt, fixture.mutation.ops);
    let mutation: ChallengeLegResult;
    if (!applied.ok) {
      mutation = { outcome: "inconclusive", output: `mutation not applicable: ${applied.detail}`, revision: baseRevision, executionIds: [] };
    } else {
      const mutationPrepare = coldPrepare(mutationWt);
      if (!mutationPrepare.ok) {
        mutation = {
          outcome: "inconclusive",
          ...(mutationPrepare.refused ? { shape: "admission-refused" } : {}),
          output: `${mutationPrepare.output}\n(prepare failed${mutationPrepare.failureStage ? ` at ${mutationPrepare.failureStage}` : ""}: the environment did not prepare - never a criterion verdict)`,
          revision: baseRevision,
          executionIds: [],
        };
      } else {
        const mutationRun = await runCriterion(mutationWt, fixture.criterion.spec, fixture.criterion.criterionId);
        mutation = {
          ...mutationRun,
          output: mutationPrepare.output + "\n" + mutationRun.output,
          revision: baseRevision,
        };
      }
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
      baseline: {
        outcome: baseline.outcome,
        revision: baseline.revision,
        executionIds: baseline.executionIds,
        ...(baseline.criterionDigest ? { criterionDigest: baseline.criterionDigest } : {}),
        ...(baseline.shape ? { failureShape: baseline.shape } : {}),
      },
      mutation: {
        outcome: mutation.outcome,
        revision: mutation.revision,
        executionIds: mutation.executionIds,
        ...(mutation.criterionDigest ? { criterionDigest: mutation.criterionDigest } : {}),
        ...(mutation.shape ? { failureShape: mutation.shape } : {}),
      },
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
