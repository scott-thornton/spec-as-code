import type { RequirementState, SpecIR } from "@spc/schema";

/**
 * CI output for `spc verify --format github` (§81): workflow annotations on
 * stdout plus a Markdown block for $GITHUB_STEP_SUMMARY. Unsatisfied
 * must-properties are errors; indeterminate and non-must failures surface as
 * warnings. Review becomes partially requirement-oriented.
 */

export function renderGithubAnnotations(specIr: SpecIR, states: readonly RequirementState[]): string[] {
  const byId = new Map(states.map((s) => [s.propertyId, s]));
  const lines: string[] = [];
  for (const p of specIr.properties) {
    const state = byId.get(p.id);
    if (!state || state.status === "satisfied" || state.status === "waived") continue;
    const level = state.status === "unsatisfied" && p.priority === "must" ? "error" : "warning";
    const title = `spc: ${p.id} ${state.status}`;
    const detail = state.reason ? ` (${state.reason})` : "";
    lines.push(`::${level} title=${JSON.stringify(title)}::${p.id} ${p.statement}${detail}`);
  }
  return lines;
}

export function renderGithubSummary(input: { specIr: SpecIR; states: readonly RequirementState[]; runId: string }): string {
  const byId = new Map(input.states.map((s) => [s.propertyId, s]));
  const lines: string[] = [];
  lines.push(`### spc verification — ${input.specIr.spec.metadata.id}`, "");
  lines.push(`Run \`${input.runId}\` · digest \`${input.specIr.digest.slice(0, 19)}…\``, "");
  lines.push("| Property | Priority | Observed | Evidence |", "| --- | --- | --- | --- |");
  for (const p of input.specIr.properties) {
    const state = byId.get(p.id);
    lines.push(
      `| ${p.id} | ${p.priority} | ${state?.status ?? "unknown"} | ${state?.evidenceIds.length ?? 0} record(s) |`,
    );
  }
  lines.push("");
  const failed = input.states.filter((s) => s.status === "unsatisfied").length;
  const indeterminate = input.states.filter((s) => s.status === "indeterminate").length;
  lines.push(
    failed > 0 || indeterminate > 0
      ? `**${failed} unsatisfied, ${indeterminate} indeterminate** — see annotations and \`spc status\`.`
      : "All properties satisfied.",
  );
  lines.push("");
  return lines.join("\n");
}
