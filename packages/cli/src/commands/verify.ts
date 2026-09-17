import path from "node:path";
import { appendFileSync } from "node:fs";
import { statusPorcelain } from "@spc/repo";
import { renderGithubAnnotations, renderGithubSummary } from "@spc/renderer";
import { createVerifyRun } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveRepoRoot, resolveSpec } from "../context.js";

/** `spc verify [specFile]`: verify desired state against the current tree. */
export async function runVerify(
  specFile: string | undefined,
  cwd?: string,
  format: "text" | "github" = "text",
): Promise<number> {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadRepoConfig(repoRoot);
  const provider = await createProvider(config, repoRoot);
  const { ir } = resolveSpec(path.join(repoRoot, "specs"), specFile ?? undefined);
  if (format === "text" && statusPorcelain(repoRoot).dirty) {
    console.log("note: working tree is dirty; verification runs against the current state as-is");
  }
  const report = await createVerifyRun({ repoRoot, specIr: ir, config, provider });

  if (format === "github") {
    // CI mode: annotations on stdout, Markdown block into the step summary.
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
  } else {
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
  }

  return report.states.every((s) => s.status === "satisfied" || s.status === "waived") ? 0 : 1;
}
