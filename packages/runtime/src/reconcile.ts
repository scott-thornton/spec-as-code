import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import type { SpecIR } from "@spc/schema";
import type { LLMProvider } from "@spc/llm";
import { generatePlan } from "@spc/planner";
import { observeRepository, readExcerpt } from "@spc/repo";
import { spcPaths } from "./paths.js";
import { newPlanId } from "./run.js";
import { applyPlan, type ApplyReport } from "./apply.js";
import { createVerifyRun } from "./queries.js";

/**
 * `spc reconcile` (§77/§96): verify desired state against the current tree,
 * and when properties have drifted, derive the next transition (a fresh plan
 * from the current revision). Applying is opt-in (`--apply`); by default the
 * human reviews the generated plan and runs `spc apply`.
 */

export interface DriftedProperty {
  propertyId: string;
  status: string;
  reason?: string;
}

export interface ReconcileResult {
  verifyRunId: string;
  inSync: boolean;
  drifted: DriftedProperty[];
  planId?: string;
  planFile?: string;
  applied?: ApplyReport;
}

export interface ReconcileDeps {
  providerFactory(): Promise<LLMProvider | null>;
  log?(line: string): void;
}

export async function reconcile(options: {
  repoRoot: string;
  specIr: SpecIR;
  config: import("@spc/schema").Config;
  apply?: boolean;
  deps: ReconcileDeps;
}): Promise<ReconcileResult> {
  const log = options.deps.log ?? (() => {});
  const verify = await createVerifyRun({
    repoRoot: options.repoRoot,
    specIr: options.specIr,
    config: options.config,
    provider: await options.deps.providerFactory(),
  });

  const drifted: DriftedProperty[] = verify.states
    .filter((s) => s.status !== "satisfied" && s.status !== "waived")
    .map((s) => ({
      propertyId: s.propertyId,
      status: s.status,
      ...(s.reason ? { reason: s.reason } : {}),
    }));

  if (drifted.length === 0) {
    log(`In sync: every property of ${options.specIr.spec.metadata.id} is satisfied in the current tree.`);
    return { verifyRunId: verify.runId, inSync: true, drifted: [] };
  }

  log(
    `Drift detected (${drifted.length} propert${drifted.length === 1 ? "y" : "ies"}): ` +
      drifted.map((d) => `${d.propertyId}=${d.status}`).join(", "),
  );

  const provider = await options.deps.providerFactory();
  if (!provider) {
    throw new SpcError(
      "NO_PROVIDER",
      'reconciliation requires an LLM provider to plan the next transition; configure provider.name in .spc/config.yaml',
    );
  }

  // Observe the CURRENT tree (not any cached snapshot) and plan from here.
  const snapshot = observeRepository(options.repoRoot, options.specIr);
  const paths = spcPaths(options.repoRoot);
  mkdirSync(paths.plansDir, { recursive: true });
  const planId = newPlanId(paths.plansDir);
  const generated = await generatePlan({
    specIr: options.specIr,
    snapshot,
    excerpts: snapshot.relevantArtifacts
      .slice(0, 6)
      .map((a) => ({ path: a.path, content: readExcerpt(options.repoRoot, a.path, 4096) ?? "" })),
    provider,
    planId,
  });
  if (!generated.plan) {
    throw new SpcError(
      "RECONCILE_PLAN_FAILED",
      `planning the next transition failed: ${generated.diagnostics.map((d) => d.message).join("; ")}`,
    );
  }
  const planFile = paths.planFile(planId);
  writeFileSync(planFile, JSON.stringify(generated.plan, null, 2), "utf8");
  log(`Planned next transition: ${planId} (${path.relative(process.cwd(), planFile)})`);

  if (!options.apply) {
    log("Review it with `spc plan show`, then run `spc apply` (or re-run with --apply).");
    return { verifyRunId: verify.runId, inSync: false, drifted, planId, planFile };
  }

  const applied = await applyPlan({ repoRoot: options.repoRoot, planFile }, {
    providerFactory: options.deps.providerFactory,
    log,
  });
  return { verifyRunId: verify.runId, inSync: false, drifted, planId, planFile, applied };
}
