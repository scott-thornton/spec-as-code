import path from "node:path";
import { renderDiff, renderStatus } from "@spc/renderer";
import { jsonDiff, jsonStatus } from "./json-views.js";
import { latestRunViewForSpec } from "@spc/runtime";
import { resolveAllSpecs, resolveRepoRoot } from "../context.js";

/**
 * `spc status [specFile]` - requirement-oriented view of the latest run.
 * With no file, every spec under specs/ gets a section (multi-spec is
 * the normal state); an explicit file selects one.
 */
export function runStatus(specFile: string | undefined, cwd?: string, format: "text" | "json" = "text"): number {
  const repoRoot = resolveRepoRoot(cwd);
  const specs = resolveAllSpecs(path.join(repoRoot, "specs"), specFile ?? undefined);
  const multi = specs.length > 1;
  const jsonViews: unknown[] = [];
  for (const { ir } of specs) {
    const view = latestRunViewForSpec(path.join(repoRoot, ".spc", "runs"), ir.spec.metadata.id);
    if (format === "json") {
      // jsonStatus returns a pre-serialized string; parse so multi-spec
      // wraps objects and single-spec output stays byte-identical.
      jsonViews.push(
        JSON.parse(
          jsonStatus({
            specIr: ir,
            runState: view?.state ?? null,
            followups: view?.followups ?? [],
            evidence: view?.evidence ?? [],
          }),
        ),
      );
      continue;
    }
    if (multi) {
      console.log(`### ${ir.spec.metadata.id}`);
      console.log("");
    }
    console.log(
      renderStatus({
        specIr: ir,
        runState: view?.state ?? null,
        followups: view?.followups ?? [],
        evidence: view?.evidence ?? [],
      }),
    );
  }
  if (format === "json") {
    console.log(JSON.stringify(multi ? jsonViews : jsonViews[0], null, 2));
  }
  return 0;
}

/** `spc diff [specFile]` - desired vs observed (every spec when bare). */
export function runDiff(specFile: string | undefined, cwd?: string, format: "text" | "json" = "text"): number {
  const repoRoot = resolveRepoRoot(cwd);
  const specs = resolveAllSpecs(path.join(repoRoot, "specs"), specFile ?? undefined);
  const multi = specs.length > 1;
  const jsonViews: unknown[] = [];
  for (const { ir } of specs) {
    const view = latestRunViewForSpec(path.join(repoRoot, ".spc", "runs"), ir.spec.metadata.id);
    if (format === "json") {
      jsonViews.push(JSON.parse(jsonDiff(ir, view?.state ?? null)));
      continue;
    }
    if (multi) {
      console.log(`### ${ir.spec.metadata.id}`);
      console.log("");
    }
    console.log(renderDiff({ specIr: ir, runState: view?.state ?? null }));
  }
  if (format === "json") {
    console.log(JSON.stringify(multi ? jsonViews : jsonViews[0], null, 2));
  }
  return 0;
}
