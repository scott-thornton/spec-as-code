import path from "node:path";
import { statusPorcelain } from "@spc/repo";
import { createVerifyRun } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveRepoRoot, resolveSpec } from "../context.js";

/** `spc verify [specFile]`: verify desired state against the current tree. */
export async function runVerify(specFile: string | undefined, cwd?: string): Promise<number> {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadRepoConfig(repoRoot);
  const provider = await createProvider(config, repoRoot);
  const { ir } = resolveSpec(path.join(repoRoot, "specs"), specFile ?? undefined);
  if (statusPorcelain(repoRoot).dirty) {
    console.log("note: working tree is dirty; verification runs against the current state as-is");
  }
  const report = await createVerifyRun({ repoRoot, specIr: ir, config, provider });
  console.log(`Verification run: ${report.runId}`);
  console.log("");
  for (const s of report.states) {
    console.log(`  ${s.status.padEnd(12)} ${s.propertyId}${s.reason ? ` — ${s.reason}` : ""}`);
  }
  const open = report.followups.filter((f) => f.status === "open");
  if (open.length > 0) {
    console.log("");
    console.log("Follow-ups created:");
    for (const f of open) console.log(`  ${f.blocking ? "[blocking] " : ""}${f.id} ${f.title}`);
  }
  return report.states.every((s) => s.status === "satisfied" || s.status === "waived") ? 0 : 1;
}
