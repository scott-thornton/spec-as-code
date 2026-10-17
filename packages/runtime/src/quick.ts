import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSpecSource, formatDiagnostics, hasErrors, SpcError, validatePlan } from "@spc/core";
import { generatePlan } from "@spc/planner";
import { commitAll, observeRepository, readExcerpt } from "@spc/repo";
import type { ApplyReport } from "./apply.js";
import { applyPlan } from "./apply.js";
import { loadConfig } from "./run.js";
import { newPlanId } from "./run.js";
import { spcPaths } from "./paths.js";
import type { LLMProvider, UsageRecord } from "@spc/llm";

/**
 * `spc quick` - a compressed SPC transaction, never a weaker safety
 * system. One intent, one human-authored gate (--verify: the single
 * thing the author must supply), one planner-derived task, executed
 * through the SAME machinery as any run: command policy, actual-diff
 * write scope, violation revert, evidence, chaining, attestation. The
 * synthesized spec is a real spec file (the contract layer); the plan is
 * a real plan file; the run leaves the normal audit trail. Quick means
 * less ceremony, never less evidence.
 *
 * Escalation is fail-closed by construction: a task whose actual delta
 * exceeds its declared write scope (or touches protected paths) fails
 * and reverts; quick then reports that the change exceeded quick shape
 * and should be authored as a full spec. It never silently absorbs.
 */
export interface QuickResult {
  specPath: string;
  report: ApplyReport;
  exceededQuickShape: boolean;
}

export async function runQuick(
  options: { repoRoot: string; intent: string; verifyCommand: string },
  deps: { providerFactory(): Promise<LLMProvider | null>; now?(): string; log?(line: string): void },
): Promise<QuickResult> {
  const paths = spcPaths(options.repoRoot);
  const config = loadConfig(paths.configPath);
  const provider = await deps.providerFactory();
  if (!provider) {
    throw new SpcError("NO_PROVIDER", "quick requires an LLM provider (planner + executor); configure provider.name in .spc/config.yaml");
  }

  // The ephemeral spec: one requirement, one gate the human authored.
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14).toLowerCase();
  const specId = `quick-${stamp}`;
  // JSON string quoting doubles as YAML double-quoted scalars, so the
  // intent and command survive colons, hashes and bare-keyword values.
  const intent = JSON.stringify(options.intent.replace(/\n/g, " "));
  const specYaml = [
    "apiVersion: spc.dev/v1alpha1",
    "kind: Spec",
    "metadata:",
    `  id: ${specId}`,
    "  title: Quick transaction",
    `goal: ${intent}`,
    "requirements:",
    "  - id: QUICK-001",
    `    statement: ${intent}`,
    "    priority: must",
    "    acceptance:",
    "      - id: QUICK-001-A",
    "        type: command",
    `        command: ${JSON.stringify(options.verifyCommand)}`,
    "",
  ].join("\n");
  const compiled = compileSpecSource(specYaml, `specs/${specId}.yaml`);
  if (!compiled.ok || !compiled.ir) {
    throw new SpcError("SPEC_INVALID", `quick spec failed to compile:\n${formatDiagnostics(compiled.diagnostics)}`);
  }
  mkdirSync(paths.specsDir, { recursive: true });
  const specPath = path.join(paths.specsDir, `${specId}.yaml`);
  writeFileSync(specPath, specYaml, "utf8");
  // The synthesized spec is a real contract in the contract layer: land
  // it as its own commit (with provenance trailers) so the run starts
  // from a clean tree and the quick spec has ordinary history.
  commitAll(options.repoRoot, `spc: quick spec ${specId}`, {
    "SPC-Quick-Spec": specId,
    "SPC-Spec-Digest": compiled.ir.digest,
  });

  // Plan through the normal machinery: the planner derives the task and
  // its provisional write scope; the delta check will enforce it.
  const snapshot = observeRepository(options.repoRoot, compiled.ir, deps.now ?? (() => new Date().toISOString()));
  const excerpts = snapshot.relevantArtifacts
    .slice(0, 6)
    .map((a) => ({ path: a.path, content: readExcerpt(options.repoRoot, a.path, 4096) ?? "" }));
  const planId = newPlanId(paths.plansDir);
  mkdirSync(paths.plansDir, { recursive: true });
  const usage: UsageRecord[] = [];
  const result = await generatePlan({
    specIr: compiled.ir,
    snapshot,
    excerpts,
    provider,
    planId,
    onUsage: (r) => usage.push(r),
  });
  if (!result.plan) {
    throw new SpcError("PLAN_INVALID", `quick planning failed:\n${formatDiagnostics(result.diagnostics)}`);
  }
  const diagnostics = validatePlan(result.plan, compiled.ir);
  if (hasErrors(diagnostics)) {
    throw new SpcError("PLAN_INVALID", `quick plan failed validation:\n${formatDiagnostics(diagnostics)}`);
  }
  writeFileSync(paths.planFile(planId), JSON.stringify(result.plan, null, 2), "utf8");
  (deps.log ?? (() => {}))(`quick: spec ${specPath}, plan ${planId}`);

  const report = await applyPlan(
    { repoRoot: options.repoRoot, planFile: paths.planFile(planId) },
    { providerFactory: async () => provider, ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}) },
  );

  // Fail-closed escalation signal: scope or verification failure means
  // the change exceeded quick shape - author a full spec.
  const scopeFailure = Object.values(readStateTasks(paths.runDir(report.runId))).some(
    (t) => t.failure?.code === "OUT_OF_SCOPE_WRITE" || t.failure?.code === "PROTECTED_PATH_WRITE",
  );
  const exceededQuickShape = scopeFailure || report.status === "failed" || report.status === "blocked";
  if (exceededQuickShape) {
    (deps.log ?? (() => {}))(
      "quick: this change exceeded quick shape (scope violation, failure or block). Author a full spec for it; nothing was silently absorbed.",
    );
  }
  return { specPath, report, exceededQuickShape };
}

function readStateTasks(runDir: string): Record<string, { failure?: { code?: string } }> {
  const state = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")) as { tasks?: Record<string, { failure?: { code?: string } }> };
  return state.tasks ?? {};
}
