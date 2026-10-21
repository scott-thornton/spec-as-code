import path from "node:path";
import { renderDiff, renderStatus } from "@spc/renderer";
import { jsonDiff, jsonStatus } from "./json-views.js";
import { latestRunViewForSpec, loadRunView, resolveChain } from "@spc/runtime";
import { resolveAllSpecs, resolveRepoRoot } from "../context.js";

/**
 * `spc status [specFile]` - requirement-oriented view of the latest run.
 * With no file, every spec under specs/ gets a section (multi-spec is
 * the normal state); an explicit file selects one.
 */
export function runStatus(specFile: string | undefined, cwd?: string, format: "text" | "json" = "text", runId?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const runsDir = path.join(repoRoot, ".spc", "runs");
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
    if (runId !== undefined) {
      // Single-run view: honest historical inspection, no aggregation.
      const singleView = loadRunView(runsDir, runId);
      if (!singleView) {
        console.error(`no run ${runId} under ${runsDir}`);
        return 2;
      }
      console.log(`Run ${runId} (single-run view):`);
      console.log(renderStatus({ specIr: ir, runState: singleView.state ?? null, followups: singleView.followups ?? [], evidence: singleView.evidence ?? [] }));
      continue;
    }
    if (view === null) {
      if (multi) { console.log(`### ${ir.spec.metadata.id}`); console.log(""); }
      console.log(`Effective chain status: no run recorded for this spec (0/${ir.properties.filter((pp) => pp.priority === "must").length} must established)`);
      console.log("");
      console.log(renderStatus({ specIr: ir, runState: null, followups: [], evidence: [] }));
      continue;
    }
    const chain = resolveChain(runsDir, view.meta.runId);
    const inherited = Object.values(view.state?.requirements ?? {}).filter((r) => (r.reason ?? "").includes("established by prior run")).length;
    const musts = ir.properties.filter((p) => p.priority === "must");
    const mustsOk = musts.filter((p) => {
      const r = view.state?.requirements?.[p.id];
      return r?.status === "satisfied" || r?.status === "waived";
    }).length;
    const unresolved = musts.length - mustsOk;
    if (multi) { console.log(`### ${ir.spec.metadata.id}`); console.log(""); }
    console.log(`Effective chain status (${chain.length} linked run${chain.length > 1 ? "s" : ""}, head ${view.meta.runId}):`);
    console.log(`  ${mustsOk}/${musts.length} must satisfied | newly satisfied in head: ${mustsOk - inherited} | inherited from chain: ${inherited} | unresolved: ${unresolved}`);
    console.log("");
    console.log(
      renderStatus({
        specIr: ir,
        runState: view.state ?? null,
        followups: view.followups ?? [],
        evidence: view.evidence ?? [],
      }),
    );
  }
  if (format === "json") {
    console.log(JSON.stringify(multi ? jsonViews : jsonViews[0], null, 2));
  }
  // Exit reflects the effective verdict across all rendered specs.
  let worst = 0;
  for (const { ir } of specs) {
    const view = latestRunViewForSpec(runsDir, ir.spec.metadata.id);
    const musts = ir.properties.filter((p) => p.priority === "must");
    const ok = musts.every((p) => {
      const r = view?.state?.requirements?.[p.id];
      return r?.status === "satisfied" || r?.status === "waived";
    });
    if (!ok) worst = 1;
  }
  return worst;
}

/** `spc diff [specFile]` - desired vs observed (every spec when bare). */
export function runDiff(specFile: string | undefined, cwd?: string, format: "text" | "json" = "text"): number {
  const repoRoot = resolveRepoRoot(cwd);
  const runsDir = path.join(repoRoot, ".spc", "runs");
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
