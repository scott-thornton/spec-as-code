import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSpecSource, formatDiagnostics, hasErrors, validatePlan, SpcError } from "@spc/core";
import type { Plan } from "@spc/schema";
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
    console.log(`\nBLOCKING follow-up drafted by planner: ${f.type} — ${f.title}\n  ${f.description}`);
  }
  if (blocking.length > 0) {
    console.log("\nspc apply will be blocked until these are resolved.");
  }
  return 0;
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
  return 0;
}

/** `spc plan show [file]` */
export function runPlanShow(planFileArg: string | undefined): number {
  const repoRoot = resolveRepoRoot();
  const paths = spcPaths(repoRoot);
  const file = planFileArg ?? latestPlan(paths);
  const plan = loadPlanFile(file);
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
