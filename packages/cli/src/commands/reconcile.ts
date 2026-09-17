import path from "node:path";
import { reconcile } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveRepoRoot, resolveSpec } from "../context.js";

/** `spc reconcile [specFile] [--apply]`: verify, then plan the next transition. */
export async function runReconcile(specFile: string | undefined, options: { apply?: boolean; cwd?: string }): Promise<number> {
  const repoRoot = resolveRepoRoot(options.cwd);
  const config = loadRepoConfig(repoRoot);
  const { ir } = resolveSpec(path.join(repoRoot, "specs"), specFile ?? undefined);

  const result = await reconcile({
    repoRoot,
    specIr: ir,
    config,
    ...(options.apply ? { apply: true } : {}),
    deps: {
      providerFactory: async () => createProvider(config, repoRoot),
      log: (line) => console.log(line),
    },
  });

  console.log("");
  if (result.inSync) {
    console.log(`Reconciled: ${ir.spec.metadata.id} is satisfied by the current tree.`);
    return 0;
  }
  console.log("Drifted properties:");
  for (const d of result.drifted) {
    console.log(`  ${d.status.padEnd(12)} ${d.propertyId}${d.reason ? ` - ${d.reason}` : ""}`);
  }
  if (result.applied) {
    console.log("");
    console.log(`Reconciliation applied: run ${result.applied.runId} - ${result.applied.status.replace("_", " ")}`);
    for (const r of result.applied.requirements) {
      console.log(`  ${r.status.padEnd(12)} ${r.propertyId}`);
    }
    return result.applied.status === "succeeded" ? 0 : 1;
  }
  console.log("");
  console.log(`Next transition planned: ${result.planId}`);
  console.log(`  review: node dist/main.js plan show ${path.relative(process.cwd(), result.planFile ?? "")}`);
  console.log("  apply:  re-run with --apply, or `spc apply`");
  return 1;
}
