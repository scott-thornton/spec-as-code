import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSpecSource, formatDiagnostics, hasErrors, validatePlan, SpcError } from "@spc/core";
import { globMatchAny } from "@spc/core";
import { listMatchingFiles } from "@spc/repo";
import type { Plan, SpecIR, Task } from "@spc/schema";
import { generatePlan } from "@spc/planner";
import { observeRepository, readExcerpt } from "@spc/repo";
import { renderPlan } from "@spc/renderer";
import {
  approvePlan,
  loadConfig,
  loadPlanFile,
  newPlanId,
  spcPaths,
} from "@spc/runtime";
import { compileSpecFile, createProvider, resolveRepoRoot } from "../context.js";

function loadSpecIrForPlan(specFile: string) {
  const result = compileSpecFile(specFile);
  if (!result.ok || !result.ir) {
    console.log(formatDiagnostics(result.diagnostics, new Map([[specFile, readFileSync(specFile, "utf8")]])));
    throw new SpcError("SPEC_INVALID", `spec ${specFile} failed validation`);
  }
  return result.ir;
}

function findSpecForPlan(repoRoot: string, plan: Plan) {
  const specsDir = path.join(repoRoot, "specs");
  for (const entry of readdirSync(specsDir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const file = path.join(specsDir, entry);
    const r = compileSpecSource(readFileSync(file, "utf8"), file);
    if (r.ok && r.ir?.spec.metadata.id === plan.spec.id) return { file, ir: r.ir };
  }
  return null;
}

function latestPlan(paths: ReturnType<typeof spcPaths>): string {
  if (!existsSync(paths.plansDir)) throw new SpcError("PLAN_NOT_FOUND", `no plans directory at ${paths.plansDir}`);
  const plans = readdirSync(paths.plansDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".approved.json"))
    .sort();
  if (plans.length === 0) throw new SpcError("PLAN_NOT_FOUND", `no plans under ${paths.plansDir}`);
  return path.join(paths.plansDir, plans[plans.length - 1]!);
}

/** `spc plan <spec-file>`: observe, generate, validate, repair, persist. */
export async function runPlan(specFile: string): Promise<number> {
  const repoRoot = resolveRepoRoot(path.dirname(path.resolve(specFile)));
  const ir = loadSpecIrForPlan(specFile);
  const config = loadConfig(path.join(repoRoot, ".spc", "config.yaml"));
  const provider = await createProvider(config, repoRoot);
  if (!provider) {
    throw new SpcError(
      "NO_PROVIDER",
      'planning requires an LLM provider; configure provider.name in .spc/config.yaml (e.g. "fake" with a script for deterministic runs, or "openai")',
    );
  }

  const snapshot = observeRepository(repoRoot, ir);
  if (snapshot.dirty) {
    console.log("note: repository is dirty; the plan records the current state as-is");
  }
  const excerpts = snapshot.relevantArtifacts
    .slice(0, 6)
    .map((a) => ({ path: a.path, content: readExcerpt(repoRoot, a.path, 4096) ?? "" }));

  const paths = spcPaths(repoRoot);
  mkdirSync(paths.plansDir, { recursive: true });
  const planId = newPlanId(paths.plansDir);

  const result = await generatePlan({
    specIr: ir,
    snapshot,
    excerpts,
    provider,
    planId,
    onUsage: () => {},
  });
  if (!result.plan) {
    console.log(formatDiagnostics(result.diagnostics));
    console.log(`\nPlan generation failed after ${result.attempts} attempt(s).`);
    return 1;
  }

  writeFileSync(paths.planFile(planId), JSON.stringify(result.plan, null, 2), "utf8");
  const blocking = (result.plan.followups ?? []).filter((f) => f.blocking);
  console.log(renderPlan(result.plan, ir));
  console.log(`Persisted: ${path.relative(process.cwd(), paths.planFile(planId))}`);
  console.log(`Planner attempts: ${result.attempts}`);
  for (const f of blocking) {
    console.log(`\nBLOCKING follow-up drafted by planner: ${f.type} - ${f.title}\n  ${f.description}`);
  }
  if (blocking.length > 0) {
    console.log("\nspc apply will be blocked until these are resolved.");
  }
  return 0;
}

/**
 * PLAN-SHARED-ORACLE: sequential tasks writing the same paths whose
 * satisfied properties share a discriminating command criterion. Every
 * intermediate task is unverifiable by construction - the shared oracle
 * stays red until the last task lands, so mid-sequence preflights
 * whisper. Advise merging or re-slicing by verification boundary.
 */
/**
 * LINT-PLAN-TARGET-GAP: the advisory join between a task's intent
 * prose and its declared targets. Three apply attempts in the
 * 2026-10-23/24 programme were refused OUT_OF_SCOPE_WRITE because the
 * intent named files the targets omitted - the accurate representation
 * and the enforced representation disagreed, and nothing joined them.
 * Prose never manufactures certainty: a bare basename matching
 * multiple repository files stays silent; an absent path stays
 * silent; only an unambiguously resolvable, uncovered repository file
 * warns. Advisory - warnings never gate.
 */
function findPlanTargetGaps(repoRoot: string, plan: Plan): string[] {
  const warnings: string[] = [];
  const intentPath = /([\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z]{1,8})|(\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml)\b)/g;
  for (const task of plan.tasks as (Task & { intent: string })[]) {
    const declared = [...(task.targets?.write ?? []), ...(task.targets?.read ?? [])];
    const seen = new Set<string>();
    for (const m of task.intent.matchAll(intentPath)) {
      const token = m[1] ?? m[2] ?? "";
      if (!token || seen.has(token)) continue;
      seen.add(token);
      let candidates: string[];
      if (token.includes("/")) {
        candidates = existsSync(path.join(repoRoot, token)) ? [token] : [];
      } else {
        candidates = listMatchingFiles(repoRoot, [`**/${token}`], 10);
      }
      // Ambiguous (multiple) or absent (zero): prose is not authority.
      if (candidates.length !== 1) continue;
      const file = candidates[0]!;
      if (declared.length > 0 && globMatchAny(declared, file)) continue;
      warnings.push(
        `task ${task.id}: intent names ${file}; declared targets do not cover it - add it to targets or reword the intent, or enforcement will refuse the write mid-apply (three incidents, 2026-10-23/24)`,
      );
    }
  }
  return warnings;
}

function findSharedOracleSlicing(plan: Plan, ir: SpecIR): string[] {
  const commandsOf = new Map<string, string[]>();
  for (const p of ir.properties) {
    const cmds = p.acceptance
      .filter((c) => c.type === "command" && c.discriminating === true && c.command !== undefined)
      .map((c) => (c as { command: string }).command);
    if (cmds.length > 0) commandsOf.set(p.id, cmds);
  }
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const dep of plan.tasks.find((t) => t.id === id)?.dependsOn ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      ancestors(dep, seen);
    }
    return seen;
  };
  const findings: string[] = [];
  for (const later of plan.tasks) {
    for (const earlier of plan.tasks) {
      if (later.id === earlier.id || !ancestors(later.id).has(earlier.id)) continue;
      const overlap = (earlier.targets?.write ?? []).filter((p) => (later.targets?.write ?? []).includes(p));
      if (overlap.length === 0) continue;
      const earlierCommands = (earlier.satisfies ?? []).flatMap((a) => commandsOf.get(a) ?? []);
      const shared = earlierCommands.filter((c) =>
        (later.satisfies ?? []).some((b) => (commandsOf.get(b) ?? []).includes(c)),
      );
      if (shared.length > 0) {
        findings.push(
          `tasks ${earlier.id} and ${later.id} write the same paths (${overlap.join(", ")}) while their satisfied properties share the command criterion "${shared[0]}"; every intermediate task is unverifiable by construction - merge into one task or re-slice by verification boundary`,
        );
      }
    }
  }
  return findings;
}

/** `spc plan validate [file]` */
export function runPlanValidate(planFileArg: string | undefined): number {
  const repoRoot = resolveRepoRoot();
  const paths = spcPaths(repoRoot);
  const file = planFileArg ?? latestPlan(paths);
  if (!existsSync(file)) {
    throw new SpcError("PLAN_NOT_FOUND", `plan file not found: ${file}`);
  }
  const plan = loadPlanFile(file);
  const spec = findSpecForPlan(repoRoot, plan);
  if (!spec) {
    throw new SpcError("SPEC_NOT_FOUND", `cannot find spec ${plan.spec.id} under ${path.join(repoRoot, "specs")}`);
  }
  const diagnostics = validatePlan(plan, spec.ir);
  if (hasErrors(diagnostics)) {
    console.log(formatDiagnostics(diagnostics));
    console.log("\nPlan invalid.");
    return 1;
  }
  console.log(`✓ plan ${plan.metadata.id} valid against spec ${plan.spec.id}`);
  for (const d of diagnostics) console.log(`warning ${d.code}: ${d.message}`);
  for (const finding of findSharedOracleSlicing(plan, spec.ir)) {
    console.log(`warning LINT-PLAN-SHARED-ORACLE: ${finding}`);
  }
  for (const gap of findPlanTargetGaps(repoRoot, plan)) {
    console.log(`warning LINT-PLAN-TARGET-GAP: ${gap}`);
  }
  return 0;
}


/** `spc plan show [file]` */
export function runPlanShow(planFileArg: string | undefined, format: "text" | "json" = "text"): number {
  const repoRoot = resolveRepoRoot();
  const paths = spcPaths(repoRoot);
  const file = planFileArg ?? latestPlan(paths);
  const plan = loadPlanFile(file);
  if (format === "json") {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const spec = findSpecForPlan(repoRoot, plan);
  console.log(renderPlan(plan, spec?.ir ?? null));
  return 0;
}

/** `spc plan approve <planId>` */
export function runPlanApprove(planId: string): number {
  const repoRoot = resolveRepoRoot();
  approvePlan(repoRoot, planId);
  console.log(`Plan ${planId} approved. spc apply will no longer require approval for it.`);
  return 0;
}
