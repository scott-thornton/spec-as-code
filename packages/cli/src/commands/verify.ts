import path from "node:path";
import { appendFileSync } from "node:fs";
import { statusPorcelain } from "@spc/repo";
import { renderGithubAnnotations, renderGithubSummary } from "@spc/renderer";
import { createVerifyRun, inPlaceHandoffWarning } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveAllSpecs, resolveRepoRoot } from "../context.js";

/**
 * `spc verify [specFile]`: verify desired state against the current
 * tree. With no file, verifies EVERY spec under specs/ and exits
 * worst-of (0 only when every spec passes); an explicit file verifies
 * exactly that spec.
 */
export async function runVerify(
  specFile: string | undefined,
  cwd?: string,
  format: "text" | "github" | "json" = "text",
): Promise<number> {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadRepoConfig(repoRoot);
  const provider = await createProvider(config, repoRoot);
  const specs = resolveAllSpecs(path.join(repoRoot, "specs"), specFile ?? undefined);
  const multi = specs.length > 1;
  if (format === "text" && statusPorcelain(repoRoot).dirty) {
    console.log("note: working tree is dirty; verification runs against the current state as-is");
  }

  let worst = 0;
  const jsonReports: unknown[] = [];
  for (const { ir } of specs) {
    const handoff = inPlaceHandoffWarning(path.join(repoRoot, ".spc", "runs"), ir.spec.metadata.id, repoRoot);
    if (handoff && format === "text") console.log(handoff);
    const report = await createVerifyRun({ repoRoot, specIr: ir, config, provider });
    const ok = report.states.every((s) => s.status === "satisfied" || s.status === "waived");
    if (!ok) worst = 1;

    if (format === "json") {
      jsonReports.push({
        spec: ir.spec.metadata.id,
        runId: report.runId,
        properties: report.states.map((s) => ({
          id: s.propertyId,
          status: s.status,
          ...(s.reason ? { reason: s.reason } : {}),
        })),
        followups: report.followups
          .filter((f) => f.status === "open")
          .map((f) => ({ id: f.id, type: f.type, blocking: f.blocking, title: f.title })),
      });
    } else if (format === "github") {
      // CI mode: annotations on stdout, Markdown block into the step summary.
      if (multi) console.log(`::group::spec ${ir.spec.metadata.id}`);
      for (const line of renderGithubAnnotations(ir, report.states)) {
        console.log(line);
      }
      const summary = renderGithubSummary({ specIr: ir, states: report.states, runId: report.runId });
      const stepSummary = process.env.GITHUB_STEP_SUMMARY;
      if (stepSummary) {
        appendFileSync(stepSummary, `${summary}\n`, "utf8");
      } else {
        console.log("");
        console.log(summary.trimEnd());
      }
      if (multi) console.log("::endgroup::");
    } else {
      if (multi) console.log(`Spec: ${ir.spec.metadata.id}`);
      console.log(`Verification run: ${report.runId}`);
      console.log("");
      for (const s of report.states) {
        console.log(`  ${s.status.padEnd(12)} ${s.propertyId}${s.reason ? ` - ${s.reason}` : ""}`);
      }
      const open = report.followups.filter((f) => f.status === "open");
      if (open.length > 0) {
        console.log("");
        console.log("Follow-ups created:");
        for (const f of open) console.log(`  ${f.blocking ? "[blocking] " : ""}${f.id} ${f.title}`);
      }
      if (multi) console.log("");
    }
  }
  if (format === "json") {
    console.log(JSON.stringify(multi ? jsonReports : jsonReports[0], null, 2));
  }

  return worst;
}
