import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { HarnessStore, checkJsonSchema, claimCandidate, requestState, saveCandidate } from "@spc/llm-harness";
import type { HarnessAnswer, HarnessRequest } from "@spc/llm-harness";
import { gitOk, observeRepository } from "@spc/repo";
import { enforceProtectedPaths, enforceWriteScope, executorResultSchema, runCommand, stageChanges } from "@spc/executor";
import { plannerOutputSchema } from "@spc/planner";
import { verifyCriterion } from "@spc/verifier";
import { prepareDisposableWorktree } from "@spc/runtime";
import { loadRepoConfig, resolveAllSpecs, resolveRepoRoot } from "../context.js";

/**
 * Authoritative answer schemas by request schemaName: agent validate
 * checks drafts with the same zod schemas the runtime enforces, so a
 * draft that would be refused never validates OK. Unknown schema names
 * keep the JSON-Schema shadow check.
 */
const AUTHORITATIVE_SCHEMAS = {
  PlannerOutput: plannerOutputSchema,
  ExecutorResult: executorResultSchema,
} as const;

/**
 * `spc agent` - the harness-side half of the harness provider: the external
 * agent (a coding harness or a human) inspects pending model requests and
 * answers them, with the JSON Schema embedded in each request.
 */

function storeFor(cwd?: string): { repoRoot: string; store: HarnessStore } {
  const repoRoot = resolveRepoRoot(cwd);
  return { repoRoot, store: new HarnessStore(repoRoot) };
}

/** Read per-request preflight counts from the informational record. */
function readPreflightCounts(repoRoot: string): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    const lines = readFileSync(path.join(repoRoot, ".spc", "harness", "preflights.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as { id?: string };
        if (rec.id) counts.set(rec.id, (counts.get(rec.id) ?? 0) + 1);
      } catch {
        // malformed line: informational record only, skip it
      }
    }
  } catch {
    // absent: no preflights recorded yet
  }
  return counts;
}

/** Draft digests on record per request id: a preflight counts for the
 *  guard only when it was recorded for THIS exact answer value. */
function readPreflightDigests(repoRoot: string): Map<string, Set<string>> {
  const digests = new Map<string, Set<string>>();
  try {
    const lines = readFileSync(path.join(repoRoot, ".spc", "harness", "preflights.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as { id?: string; draftDigest?: string };
        if (rec.id && rec.draftDigest) {
          const set = digests.get(rec.id) ?? new Set<string>();
          set.add(rec.draftDigest);
          digests.set(rec.id, set);
        }
      } catch {
        // malformed line: informational record only, skip
      }
    }
  } catch {
    // absent: no preflights recorded yet
  }
  return digests;
}

/** Digest of the actual submitted answer value - computed identically at
 *  dry-run record time and respond check time, never over a staged or
 *  intermediate representation that can diverge from what is submitted. */
function draftDigestOf(value: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** The answer's patch-op shape: null when it carries no patch ops. */
function patchShapeOf(value: unknown): { ops: number; files: number; chained: string[] } | null {
  if (typeof value !== "object" || value === null) return null;
  const changes = (value as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;
  const patches = changes.filter(
    (c): c is { op: string; path: string } =>
      typeof c === "object" && c !== null && (c as { op?: unknown }).op === "patch" && typeof (c as { path?: unknown }).path === "string",
  );
  if (patches.length === 0) return null;
  const byPath = new Map<string, number>();
  for (const p of patches) byPath.set(p.path, (byPath.get(p.path) ?? 0) + 1);
  const chained = [...byPath.entries()].filter(([, n]) => n > 1).map(([p]) => p);
  return { ops: patches.length, files: byPath.size, chained };
}

function ageOf(createdAt: string): string {
  const ms = Date.now() - Date.parse(createdAt);
  if (Number.isNaN(ms)) return "?";
  if (ms < 0) return "0s";
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** Duration over a positive quantity: never inverted, never negative -
 *  remaining windows and closed-ago spans are durations, not ages. */
function formatDuration(ms: number): string {
  if (Number.isNaN(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/**
 * Derived per-request state segment, shared by list, wait, and brief:
 * the queue's truth computed at read time, never persisted. This is the
 * surface where an orphan (answered long ago, window closed, nothing
 * consuming) becomes obvious in seconds.
 */
export function describeRequestState(request: HarnessRequest): string {
  const state = requestState(request);
  if (state === "unknown") return `window unknown (unstamped; age ${ageOf(request.createdAt)})`;
  if (state === "live") {
    const leftMs = Date.parse(request.expiresAt!) - Date.now();
    return `live (age ${ageOf(request.createdAt)}, ${formatDuration(leftMs)} left in window)`;
  }
  const closedMs = Date.now() - Date.parse(request.expiresAt!);
  return `elapsed (window closed ${formatDuration(closedMs)} ago)`;
}

export function runAgentList(cwd: string | undefined, format: "text" | "json"): number {
  const { repoRoot, store } = storeFor(cwd);
  const preflighted = readPreflightCounts(repoRoot);
  const pending = store.listPending();
  if (format === "json") {
    console.log(
      JSON.stringify(
        pending.map((r) => ({
          id: r.id,
          role: r.role,
          key: r.key,
          schemaName: r.schemaName,
          createdAt: r.createdAt,
          state: requestState(r),
          ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
          ...(store.getAnswer(r.id)?.answeredAt ? { answeredAt: store.getAnswer(r.id)!.answeredAt } : {}),
          ...(preflighted.get(r.id) ? { preflightCount: preflighted.get(r.id) } : {}),
          ...(r.lastError ? { lastError: r.lastError } : {}),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (pending.length === 0) {
    console.log("No pending harness requests.");
    return 0;
  }
  for (const r of pending) {
    const seen = preflighted.get(r.id) ?? 0;
    const answeredAt = store.getAnswer(r.id)?.answeredAt ?? null;
    const answered = answeredAt ? `  answered: yes (${answeredAt.slice(11, 16)} UTC)` : "  answered: no";
    const retry = r.lastError ? "  · retry needed" : "";
    console.log(`${r.id}  [${r.role}]  ${r.schemaName}  ${describeRequestState(r)}${answered}${retry}${seen > 0 ? `  preflighted ${seen}x` : ""}`);
    if (r.lastError) {
      console.log(`    retry needed - previous answer invalid: ${r.lastError.split("\n")[0]}`);
    }
  }
  console.log("\nInspect with:  spc agent show <id>");
  console.log("Answer with:   spc agent respond <id> --file <answer.json>");
  console.log("De-risk with:  spc agent validate <id> --file <draft.json>  |  spc agent dry-run <id> --file <draft.json>");
  return 1;
}

const SHOW_PARTS = ["system", "prompt", "schema", "payload", "json"] as const;
export type AgentShowPart = (typeof SHOW_PARTS)[number];

/** Extract the prompt's embedded JSON object (banner lines, then JSON). */
function extractPromptPayload(prompt: string): unknown {
  const start = prompt.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < prompt.length; i++) {
    const ch = prompt[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(prompt.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function runAgentShow(id: string, cwd: string | undefined, part?: AgentShowPart): number {
  const { store } = storeFor(cwd);
  const request = store.getRequest(id);
  if (!request) {
    throw new SpcError("HARNESS_REQUEST_NOT_FOUND", `no pending harness request with id ${id}`);
  }
  // Decomposition first: consumers should never hand-parse a request
  // blob (the first field run wrote a python script for exactly this).
  if (part === "system") {
    console.log(request.system);
    return 0;
  }
  if (part === "prompt") {
    console.log(request.prompt);
    return 0;
  }
  if (part === "schema") {
    console.log(JSON.stringify(request.jsonSchema, null, 2));
    return 0;
  }
  if (part === "payload") {
    const payload = extractPromptPayload(request.prompt);
    if (payload === null || typeof payload !== "object") {
      throw new SpcError("HARNESS_PROMPT_PAYLOAD", `the prompt for ${id} carries no parseable JSON object`);
    }
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  if (part === "json") {
    console.log(JSON.stringify(request, null, 2));
    return 0;
  }
  console.log(`=== SYSTEM ===\n${request.system}\n\n=== PROMPT ===\n${request.prompt}\n\n=== SCHEMA (${request.schemaName}) ===`);
  console.log(JSON.stringify(request.jsonSchema, null, 2));
  return 0;
}

/**
 * `spc agent wait` - block until a harness request appears, then print
 * it. The answering agent's loop becomes: answer, wait, answer - no
 * sleep-polling (the CHK3555 agent polled all day).
 */
export async function runAgentWait(options: { timeoutMs?: number; cwd?: string }): Promise<number> {
  const { store } = storeFor(options.cwd);
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = store.listPending();
    if (pending.length > 0) {
      for (const r of pending) {
        console.log(`${r.id}  [${r.role}]  ${r.schemaName}  ${describeRequestState(r)}`);
      }
      return 0;
    }
    if (Date.now() >= deadline) {
      console.error(`no harness request became pending within ${timeoutMs}ms`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function runAgentRespond(options: { id: string; file?: string; stdin?: boolean; by?: string; cwd?: string; fromCandidate?: string; noPreflight?: boolean }): number {
  const { repoRoot, store } = storeFor(options.cwd);
  if (options.fromCandidate) {
    if (options.file || options.stdin) {
      throw new SpcError("HARNESS_RESPOND_INPUT", "--from-candidate is mutually exclusive with --file/--stdin");
    }
    // Authority admits candidates: the claim is the atomic commit, and
    // its rejection semantics preserve the candidate for a successor.
    const claim = claimCandidate(store, options.fromCandidate, options.id);
    if (!claim.ok) {
      console.log(`claim rejected: ${claim.code} - ${claim.detail}`);
      return 1;
    }
    console.log(`Claimed ${options.fromCandidate} into ${claim.answer.id} (lineage: composed off the clock, admitted now).`);
    console.log(`Answered ${claim.answer.id}. The waiting spc process will pick it up within a second or two.`);
    return 0;
  }
  let raw: string;
  if (options.file) {
    raw = readFileSync(path.resolve(process.cwd(), options.file), "utf8");
  } else if (options.stdin) {
    raw = readFileSync(0, "utf8");
  } else {
    throw new SpcError("HARNESS_RESPOND_INPUT", "pass --file <answer.json> or --stdin");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new SpcError("HARNESS_RESPOND_INPUT", `answer is not valid JSON: ${(e as Error).message}`);
  }
  // Rehearsal friction (risk-scoped, escapable): the empirically top
  // staging refusal is chained ops on one path composed without
  // rehearsal. A preflight counts only when it was recorded for THIS
  // exact answer (draft-digest identity); --no-preflight pushes
  // through, but the advice still teaches.
  const shape = patchShapeOf(value);
  const rehearsed = readPreflightDigests(repoRoot).get(options.id)?.has(draftDigestOf(value)) ?? false;
  const advice =
    shape && !rehearsed
      ? `note: no preflight on record for ${options.id} matches this answer (${shape.ops} ops across ${shape.files} file(s)${shape.chained.length > 0 ? `, ${shape.chained.length} chained on one path` : ""}); de-risk with: spc agent dry-run ${options.id} --file <draft> --gates`
      : null;
  if (shape && shape.chained.length > 0 && !rehearsed && !options.noPreflight) {
    console.log(`PREFLIGHT_ADVISABLE: ${options.id} would receive ${shape.ops} ops with ${shape.chained.length} chained on one path, and no dry-run preflight matches this exact answer.`);
    console.log(`Chained ops whose digests do not compose are the top staging refusal - a dry-run costs minutes, a staging refusal costs the task attempt.`);
    console.log(`Rehearse: spc agent dry-run ${options.id} --file <draft> --gates  (follow: spc use-skill rehearse)`);
    console.log(`Submit anyway: add --no-preflight`);
    if (advice) console.log(advice);
    return 1;
  }
  let answer: HarnessAnswer;
  try {
    answer = store.answer(options.id, value, options.by);
  } catch (e) {
    const message = (e as Error).message;
    // The store's refusal is the instruction: print it, exit attention.
    if (message.startsWith("REQUEST_")) {
      console.log(message);
      return 1;
    }
    throw e;
  }
  console.log(`Answered ${answer.id}. The waiting spc process will pick it up within a second or two.`);
  console.log("If the answer fails schema validation, the request reappears in spc agent list with feedback.");
  // Nudge, never gate: the preflight record exists precisely so the
  // cheap check is the habitual one.
  if (advice) console.log(advice);
  else if ((readPreflightCounts(repoRoot).get(answer.id) ?? 0) === 0) {
    console.log(`note: no preflight on record for ${answer.id}; de-risk next time with: spc agent dry-run ${answer.id} --file <draft> --gates`);
  }
  return 0;
}

/**
 * `spc agent save-candidate`: persist an immutable portable candidate
 * composed against a request's recorded premises (pending OR stale -
 * composing against an expired request is legal; the candidate confers
 * no authority until a live successor claims it). Executors only.
 */
export function runAgentSaveCandidate(options: { file: string; request: string; by?: string; cwd?: string }): number {
  const { store } = storeFor(options.cwd);
  const raw = readFileSync(path.resolve(process.cwd(), options.file), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new SpcError("HARNESS_RESPOND_INPUT", `answer is not valid JSON: ${(e as Error).message}`);
  }
  try {
    const candidate = saveCandidate(store, value, options.request, options.by);
    console.log(`${candidate.id}  composed against ${options.request} (role executor; fingerprint: task, schema, base revision, write scope, config).`);
    console.log("The candidate confers no authority: a LIVE successor request admits it via `spc agent respond <id> --from-candidate " + candidate.id + "`.");
    return 0;
  } catch (e) {
    const message = (e as Error).message;
    console.log(message.startsWith("CANDIDATE_") ? message : `error: ${message}`);
    return 1;
  }
}

/**
 * Preflight: check a draft answer against the pending request's JSON
 * Schema BEFORE submitting, so schema problems cost a local command
 * instead of a submit-requeue-regenerate round trip. Advisory - the
 * authoritative check remains the runtime's zod validation.
 */
export function runAgentValidate(options: { id: string; file: string; cwd?: string }): number {
  const { store } = storeFor(options.cwd);
  const request = store.getRequest(options.id);
  if (!request) {
    throw new SpcError("HARNESS_REQUEST_NOT_FOUND", `no pending harness request with id ${options.id}`);
  }
  const raw = readFileSync(path.resolve(process.cwd(), options.file), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new SpcError("HARNESS_RESPOND_INPUT", `answer is not valid JSON: ${(e as Error).message}`);
  }
  const issues = checkJsonSchema(request.jsonSchema, value);
  if (issues.length === 0) {
    // The shadow is lossy (zod refinements do not serialize); for known
    // schema names the authoritative zod parse is the final word, so a
    // draft the runtime would requeue never validates OK. Shadow issues
    // keep their familiar phrasing and print first.
    const authoritative = AUTHORITATIVE_SCHEMAS[request.schemaName as keyof typeof AUTHORITATIVE_SCHEMAS];
    if (authoritative) {
      const parsed = authoritative.safeParse(value);
      if (!parsed.success) {
        console.error(`${parsed.error.issues.length} schema issue(s) [authoritative zod] - the JSON-Schema shadow passed but the runtime would requeue these:`);
        for (const issue of parsed.error.issues.slice(0, 20)) {
          console.error(`  ${issue.path.join(".")}: ${issue.message}`);
        }
        return 1;
      }
    }
    console.log(`OK: answer satisfies the ${request.schemaName} schema. Submit with:`);
    console.log(`  spc agent respond ${request.id} --file ${options.file}`);
    return 0;
  }
  console.error(`${issues.length} schema issue(s) - fix before submitting (a submit would requeue with the same errors):`);
  for (const issue of issues.slice(0, 20)) {
    console.error(`  ${issue.path}: ${issue.message}`);
  }
  return 1;
}
/**
 * Composition-time preflight: stage the draft answer's changes in a
 * throwaway worktree checked out at the base the request was composed
 * from, run the task's deterministic criteria there with the ordinary
 * verification machinery, report outcomes - never write the real tree,
 * never gate submission. A bad answer costs thirty seconds here instead
 * of a task retry in the run. Field agents shadow-built this three
 * times before it existed, and kept hand-rehearsing on the live tree
 * (CHK3643) until it could bind to the request base and run with real
 * dependencies too.
 */
export async function runAgentDryRun(options: { id: string; file: string; gates?: string[] | boolean; cwd?: string }): Promise<number> {
  const { repoRoot, store } = storeFor(options.cwd);
  const request = store.getRequest(options.id);
  if (!request) {
    throw new SpcError("HARNESS_REQUEST_NOT_FOUND", `no pending harness request with id ${options.id}`);
  }
  const payload = extractPromptPayload(request.prompt);
  if (!payload || typeof payload !== "object") {
    throw new SpcError("HARNESS_PROMPT_PAYLOAD", `the prompt for ${options.id} carries no parseable JSON object`);
  }
  const raw = readFileSync(path.resolve(process.cwd(), options.file), "utf8");
  let draft: Record<string, unknown>;
  try {
    draft = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new SpcError("HARNESS_RESPOND_INPUT", `draft is not valid JSON: ${(e as Error).message}`);
  }

// Informational record: one line per preflight, so rehearsal stops
  // hiding in /tmp and whoever works the queue can see it. Never
  // evidence, never state - a verifier must never read this file.
  const preflightsFile = path.join(repoRoot, ".spc", "harness", "preflights.jsonl");
  const recordPreflight = (rec: {
    staged: number;
    refusals: string[];
    criteria: { pass: number; total: number };
    gates: Record<string, number> | null;
  }) => {
    mkdirSync(path.dirname(preflightsFile), { recursive: true });
    // draftDigest binds the record to THIS draft value: the rehearse
    // guard accepts a preflight only when what was rehearsed is what
    // gets submitted.
    appendFileSync(preflightsFile, JSON.stringify({ id: options.id, at: new Date().toISOString(), draftDigest: draftDigestOf(draft), ...rec }) + "\n", "utf8");
  };

  // Schema first: an invalid draft requeues at submit with the same
  // errors - surface them here for the price of a local command.
  const schemaIssues = checkJsonSchema(request.jsonSchema, draft);
  if (schemaIssues.length > 0) {
    console.log(`${schemaIssues.length} schema issue(s) in the draft (a submit would requeue with the same errors):`);
    for (const issue of schemaIssues.slice(0, 20)) {
      console.log(`  ${issue.path}: ${issue.message}`);
    }
    recordPreflight({ staged: 0, refusals: [], criteria: { pass: 0, total: 0 }, gates: null });
    return 1;
  }

  const config = loadRepoConfig(repoRoot);

  // The base the request was composed from: staging must bind to the
  // excerpts the drafter read, not to whatever the live tree looks like
  // now. No revision in the payload (older requests) falls back to HEAD.
  const baseRevision = (payload as { repository?: { revision?: string } }).repository?.revision;

  const worktree = path.join(repoRoot, ".spc", "worktrees", `dryrun-${options.id.replace(/[^a-zA-Z0-9@.-]/g, "_")}`);
  try {
    gitOk(repoRoot, ["worktree", "remove", "--force", worktree]);
  } catch {
    // absent - fine
  }
  gitOk(repoRoot, ["worktree", "add", "--detach", worktree, baseRevision ?? "HEAD"]);
  try {
    console.log(`Preflight for ${options.id} (advisory - never evidence, never gates)`);
    console.log(
      `Base: ${baseRevision ? `request revision ${baseRevision.slice(0, 10)}` : "HEAD"} (throwaway worktree)`,
    );

    // A bare worktree has no installed dependencies: package-resolving
    // commands either fail or - worse - exit 0 on cache luck. Link the
    // repo's own install so criteria and gates run against the real
    // thing; when the repo has none, say so instead of guessing.
    const prepared = prepareDisposableWorktree(repoRoot, worktree);
    if (prepared.mode === "installed") console.log(`Dependencies: pnpm install --frozen-lockfile --offline exit ${prepared.exitCode}`);
    if (prepared.mode === "failed") {
      console.log(`Dependencies: pnpm install --frozen-lockfile --offline exit ${prepared.exitCode ?? "signal"}`);
      if (prepared.detail) console.log(`  ${prepared.detail}`);
    }
    if (prepared.mode === "none") {
      console.log("Dependencies: none linked (repo root has no node_modules); package commands may not be executable");
    }

    // Stage in memory first - against the BASE worktree, not the live
    // tree - so digests bind to the request base. An unstagedable change
    // set is the one hard failure; the applicator's refusal code says why.
    const staged = stageChanges(worktree, (draft.changes ?? []) as never);
    if (!staged.ok) {
      console.error(staged.message);
      recordPreflight({ staged: 0, refusals: [], criteria: { pass: 0, total: 0 }, gates: null });
      return 1;
    }

    // Predict what apply would refuse, with the same enforcement
    // functions apply uses - a refusal here costs a local command
    // instead of a task retry. A request that declares no write targets
    // (legacy fixtures) cannot be scope-predicted; say so rather than
    // fabricate a refusal.
    const task = (payload as { task?: { targets?: { write?: string[] } } }).task;
    const writePatterns = task?.targets?.write ?? (payload as { allowedWritePaths?: string[] }).allowedWritePaths ?? [];
    const stagedPaths = [...staged.writes.map((w) => w.path), ...staged.deletes];
    const violations = [
      ...(writePatterns.length > 0 ? enforceWriteScope(writePatterns, stagedPaths) : []),
      ...enforceProtectedPaths(config.verification.protectedPaths, stagedPaths),
    ];
    if (writePatterns.length === 0 && stagedPaths.length > 0) {
      console.log('Enforcement: write scope unknown (request carries no declared write targets); scope not predicted');
    }
    if (violations.length > 0) {
      for (const v of violations) {
        console.log(`  PREDICTED REFUSAL at apply: ${v.code} - ${v.reason}`);
      }
      console.log('Fix the draft and preflight again; apply would refuse this answer.');
      recordPreflight({ staged: staged.writes.length, refusals: violations.map((v) => v.code), criteria: { pass: 0, total: 0 }, gates: null });
      return 1;
    }
    if (writePatterns.length > 0) {
      console.log('Enforcement: no refusals predicted (write scope, protected paths)');
    }

    for (const w of staged.writes) {
      mkdirSync(path.join(worktree, path.dirname(w.path)), { recursive: true });
      writeFileSync(path.join(worktree, w.path), w.content, "utf8");
    }
    for (const p of staged.deletes) rmSync(path.join(worktree, p), { force: true });

    console.log(`Staged: ${staged.writes.length} staged write(s), ${staged.deletes.length} delete(s)`);

    // Cold-worktree build: per-package criteria compile against their
    // dependencies' dist artifacts, which exist in a warm in-place tree
    // but not in a fresh checkout. One topological build of the staged
    // tree makes every criterion self-sufficient. Advisory - a failed
    // prepare is reported, criteria still run and speak for themselves.
    const prepareCmd = observeRepository(repoRoot, null).commands.build;
    if (prepareCmd) {
      const run = await runCommand(prepareCmd, {
        cwd: worktree,
        timeoutMs: 180_000,
        maxOutputBytes: config.execution.maxOutputBytes,
        commandsConfig: config.commands,
      });
      if (!run.allowed) {
        console.log(`Preparing: ${prepareCmd} denied by command policy; criteria needing built artifacts may fail`);
      } else if (run.timedOut) {
        console.log(`Preparing: ${prepareCmd} timed out (180s); criteria needing built artifacts may fail`);
      } else {
        console.log(`Preparing: ${prepareCmd} exit ${run.exitCode}`);
      }
    }

    // Find the task's properties in the repo's compiled spec.
    const specId = (payload as { spec?: { id?: string } }).spec?.id;
    const specs = resolveAllSpecs(path.join(repoRoot, "specs"));
    const spec = specId ? specs.find((s) => s.ir.spec.metadata.id === specId) : undefined;
    const relevant = ((payload as { relevantProperties?: { id: string }[] }).relevantProperties ?? []).map((p) => p.id);
    const properties = (spec?.ir.properties ?? []).filter((p) => relevant.includes(p.id));

    const commandRuns = new Map();
    let criteriaPassed = 0;
    let criteriaTotal = 0;
    for (const property of properties) {
      for (const criterion of property.acceptance) {
        if (criterion.type !== "file" && criterion.type !== "command") continue;
        const result = await verifyCriterion(criterion as never, property as never, {
          runId: "dryrun",
          cwd: worktree,
          repositoryRevision: "staged",
          config,
          provider: null,
          commandRuns,
        });
        criteriaTotal += 1;
        if (result.evidence.outcome === "supports") criteriaPassed += 1;
        const p = result.evidence.payload as Record<string, unknown>;
        const shape = p.failureShape ? ` [${p.failureShape}]` : "";
        const detail =
          result.evidence.outcome === "supports"
            ? "pass"
            : `${result.evidence.outcome}${shape}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""}`;
        console.log(`  ${criterion.id}  ${detail}`);
      }
    }
    // Repo gates on request: the commands the root manifest declares
    // (test/build/lint/typecheck), run inside the same worktree against
    // the staged tree and linked dependencies. Advisory like everything
    // else here - a failing gate is a report line, never an exit code;
    // the run's own verification stays authoritative. Tight budget: a
    // preflight that outlives its usefulness is a preflight nobody runs.
    let gateResults: Record<string, number> | null = null;
    if (options.gates !== undefined && options.gates !== false) {
      gateResults = {};
      const declared: Record<string, string> = observeRepository(repoRoot, null).commands;
      const names = Array.isArray(options.gates) ? options.gates : Object.keys(declared);
      console.log('Gates (advisory):');
      if (names.length === 0) console.log('  (this repo declares no test/build/lint/typecheck commands)');
      for (const name of names) {
        const command = declared[name];
        if (!command) {
          console.log(`  ${name}  not declared by this repo's root manifest`);
          continue;
        }
        const run = await runCommand(command, {
          cwd: worktree,
          timeoutMs: 60_000,
          maxOutputBytes: config.execution.maxOutputBytes,
          commandsConfig: config.commands,
        });
        if (!run.allowed) {
          console.log(`  ${name}  denied by command policy (${run.deniedReason ?? 'denied'})`);
          continue;
        }
        if (run.timedOut) {
          console.log(`  ${name}  timed out (60s budget)`);
          continue;
        }
        console.log(`  ${name}  exit ${run.exitCode}`);
        gateResults[name] = run.exitCode ?? -1;
      }
    }

    recordPreflight({ staged: staged.writes.length, refusals: [], criteria: { pass: criteriaPassed, total: criteriaTotal }, gates: gateResults });
    console.log("Advisory only - the run's own verification remains authoritative. The working tree was not modified.");
    return 0;
  } finally {
    try {
      gitOk(repoRoot, ["worktree", "remove", "--force", worktree]);
    } catch {
      // best effort cleanup
    }
  }
}
