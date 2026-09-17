import path from "node:path";
import { renderDiff, renderStatus } from "@spc/renderer";
import { latestRunViewForSpec } from "@spc/runtime";
import { resolveRepoRoot, resolveSpec } from "../context.js";

/** `spc status [specFile]` — requirement-oriented view of the latest run. */
export function runStatus(specFile: string | undefined, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const { ir } = resolveSpec(path.join(repoRoot, "specs"), specFile ?? undefined);
  const view = latestRunViewForSpec(path.join(repoRoot, ".spc", "runs"), ir.spec.metadata.id);
  console.log(
    renderStatus({
      specIr: ir,
      runState: view?.state ?? null,
      followups: view?.followups ?? [],
      evidence: view?.evidence ?? [],
    }),
  );
  return 0;
}

/** `spc diff [specFile]` — desired vs observed. */
export function runDiff(specFile: string | undefined, cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const { ir } = resolveSpec(path.join(repoRoot, "specs"), specFile ?? undefined);
  const view = latestRunViewForSpec(path.join(repoRoot, ".spc", "runs"), ir.spec.metadata.id);
  console.log(renderDiff({ specIr: ir, runState: view?.state ?? null }));
  return 0;
}
