import type { SpecIR } from "@spc/schema";

/** Generated Markdown is an output view; it is never parsed back. */

export function renderSpecMarkdown(ir: SpecIR): string {
  const s = ir.spec;
  const lines: string[] = [];
  lines.push(`# ${s.metadata.title}`, "");
  lines.push(`- **Spec:** \`${s.metadata.id}\``);
  lines.push(`- **Digest:** \`${ir.digest}\``);
  if (s.metadata.description) lines.push(`- **Description:** ${s.metadata.description}`);
  lines.push("", "## Goal", "", s.goal.trim(), "");

  lines.push("## Requirements", "");
  for (const r of s.requirements) {
    lines.push(`### ${r.id} (${r.priority}${r.category ? `, ${r.category}` : ""})`, "", r.statement, "");
    if (r.acceptance.length > 0) {
      lines.push("Acceptance criteria:", "");
      for (const c of r.acceptance) {
        lines.push(`- \`${c.id}\` (${c.type}): ${describeCriterion(c)}`);
      }
      lines.push("");
    }
  }
  if (s.constraints.length > 0) {
    lines.push("## Constraints", "");
    for (const c of s.constraints) {
      lines.push(`### ${c.id} (${c.priority}${c.category ? `, ${c.category}` : ""})`, "", c.statement, "");
      if (c.acceptance.length > 0) {
        for (const a of c.acceptance) lines.push(`- \`${a.id}\` (${a.type}): ${describeCriterion(a)}`);
        lines.push("");
      }
    }
  }
  const secrets = s.environment?.requiredSecrets ?? [];
  if (secrets.length > 0) {
    lines.push("## Required secrets", "");
    for (const name of secrets) lines.push(`- \`${name}\` (presence-checked only; values never read)`);
    lines.push("");
  }
  if (s.outOfScope.length > 0) {
    lines.push("## Out of scope", "", ...s.outOfScope.map((o) => `- ${o}`), "");
  }
  return lines.join("\n");
}

export function renderSpecText(ir: SpecIR): string {
  const s = ir.spec;
  const lines: string[] = [`Spec: ${s.metadata.id} (${s.metadata.title})`, `Digest: ${ir.digest}`, ""];
  const rows = ir.properties.map((p) => `${p.priority.padEnd(7)} ${p.id.padEnd(16)} ${p.statement}`);
  lines.push("Properties:", "", ...rows.map((r) => `  ${r}`), "");
  if (s.outOfScope.length > 0) lines.push("Out of scope:", "", ...s.outOfScope.map((o) => `  - ${o}`), "");
  return lines.join("\n");
}

function describeCriterion(c: { type: string; command?: string; path?: string; instruction?: string; expect?: { exitCode?: number } }): string {
  switch (c.type) {
    case "command":
      return `\`${c.command ?? ""}\` exits ${c.expect?.exitCode ?? 0}`;
    case "file":
      return `file \`${c.path ?? ""}\` matches assertions`;
    case "agent":
    case "human":
      return `${c.type} review - ${c.instruction ?? ""}`;
    default:
      return c.type;
  }
}
