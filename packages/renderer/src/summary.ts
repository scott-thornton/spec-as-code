import type { Evidence, FollowUp, RunState, SpecIR } from "@spc/schema";
import { evidenceTrustLabel } from "@spc/schema";

export interface SummaryInput {
  specIr: SpecIR;
  runState: RunState;
  followups: FollowUp[];
  evidence: Evidence[];
  diffStat?: string;
  changedFileCount?: number;
}

/** Completion report (run summary). Markdown view; state files are canonical. */
export function renderRunSummary(input: SummaryInput): string {
  const { specIr, runState, followups, evidence } = input;
  const lines: string[] = [];
  lines.push(`# Run ${runState.runId}`, "");
  lines.push(`- **Spec:** ${specIr.spec.metadata.id} (\`${specIr.digest}\`)`);
  lines.push(`- **Result:** ${runState.status}`);
  if (runState.baseRevision) lines.push(`- **Base revision:** \`${runState.baseRevision.slice(0, 12)}\``);
  if (runState.resultRevision) lines.push(`- **Result revision:** \`${runState.resultRevision.slice(0, 12)}\``);
  if (runState.branch) lines.push(`- **Branch:** \`${runState.branch}\``);
  if (runState.worktree) lines.push(`- **Worktree:** \`${runState.worktree}\``);
  lines.push("");

  const counts = new Map<string, number>();
  for (const p of specIr.properties) {
    const s = runState.requirements[p.id]?.status ?? "unknown";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  lines.push("## Requirements", "");
  for (const [status, n] of [...counts.entries()].sort()) {
    lines.push(`- ${n} ${status}`);
  }
  lines.push("");

  lines.push("## Requirement evidence", "");
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  for (const p of specIr.properties) {
    const state = runState.requirements[p.id];
    const evs = (state?.evidenceIds ?? [])
      .map((id) => evidenceById.get(id))
      .filter((e): e is Evidence => e !== undefined);
    const provenance = evs.length > 0 ? evs.map((e) => `${evidenceTrustLabel(e.kind)}:${e.outcome}`).join(", ") : "no evidence";
    lines.push(`- **${p.id}** — ${state?.status ?? "unknown"} (${provenance})`);
  }
  lines.push("");

  if (input.changedFileCount !== undefined || input.diffStat) {
    lines.push("## Changes", "");
    if (input.changedFileCount !== undefined) lines.push(`- ${input.changedFileCount} files changed`);
    if (input.diffStat) lines.push("", "```", input.diffStat, "```");
    lines.push("");
  }

  lines.push("## Statistics", "");
  lines.push(`- Model calls: ${runState.modelCalls}`);
  lines.push(`- Replans: ${runState.replans}`);
  lines.push("");

  const open = followups.filter((f) => f.status === "open");
  const resolved = followups.filter((f) => f.status === "resolved");
  lines.push("## Follow-ups", "");
  if (open.length === 0 && resolved.length === 0) lines.push("None.");
  for (const f of open) lines.push(`- **OPEN** ${f.id}: ${f.title}${f.blocking ? " *(blocking)*" : ""}`);
  for (const f of resolved) {
    lines.push(`- ~~${f.id}: ${f.title}~~ — resolved${f.resolution?.optionId ? ` (${f.resolution.optionId})` : ""}`);
  }
  lines.push("");

  const weak = specIr.properties.filter((p) => runState.requirements[p.id]?.weakEvidence);
  if (weak.length > 0) {
    lines.push("## Remaining risk", "");
    for (const p of weak) lines.push(`- ${p.id} verified by non-deterministic evidence only`);
    lines.push("");
  }
  return lines.join("\n");
}
