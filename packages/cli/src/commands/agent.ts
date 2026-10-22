import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { HarnessStore, checkJsonSchema } from "@spc/llm-harness";
import { gitOk, observeRepository } from "@spc/repo";
import { enforceProtectedPaths, enforceWriteScope, runCommand, stageChanges } from "@spc/executor";
import { verifyCriterion } from "@spc/verifier";
import { loadRepoConfig, resolveAllSpecs, resolveRepoRoot } from "../context.js";

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
  const ageOf = (createdAt: string): string => {
    const ms = Date.now() - Date.parse(createdAt);
    if (Number.isNaN(ms)) return "?";
    const m = Math.floor(ms / 60000);
    if (m < 1) return `${Math.floor(ms / 1000)}s`;
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h`;
  };
  for (const r of pending) {
    const seen = preflighted.get(r.id) ?? 0;
    console.log(`${r.id}  [${r.role}]  ${r.schemaName}  age ${ageOf(r.createdAt)}${seen > 0 ? `  preflighted ${seen}x` : ""}`);
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
        const ms = Date.now() - Date.parse(r.createdAt);
        const m = Math.floor(ms / 60000);
        const age = m < 1 ? `${Math.floor(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
        console.log(`${r.id}  [${r.role}]  ${r.schemaName}  age ${age}`);
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

export function runAgentRespond(options: { id: string; file?: string; stdin?: boolean; by?: string; cwd?: string }): number {
  const { store } = storeFor(options.cwd);
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
  const answer = store.answer(options.id, value, options.by);
  console.log(`Answered ${answer.id}. The waiting spc process will pick it up within a second or two.`);
  console.log("If the answer fails schema validation, the request reappears in spc agent list with feedback.");
  return 0;
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
    appendFileSync(preflightsFile, JSON.stringify({ id: options.id, at: new Date().toISOString(), ...rec }) + "\n", "utf8");
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
    const depsSource = path.join(repoRoot, "node_modules");
    if (existsSync(depsSource) && !existsSync(path.join(worktree, "node_modules"))) {
      symlinkSync(depsSource, path.join(worktree, "node_modules"), "dir");
    }
    if (!existsSync(path.join(worktree, "node_modules"))) {
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
