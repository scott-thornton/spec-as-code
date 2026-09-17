import type { Evidence, FollowUp, RequirementState, RequirementStatus, RunState, SpecIR } from "@spc/schema";
import { evidenceTrustLabel } from "@spc/schema";

/**
 * Status is requirement-oriented: task completion is secondary, property
 * satisfaction is primary, and evidence provenance stays visible.
 */

export interface StatusInput {
  specIr: SpecIR;
  runState: RunState | null;
  followups: FollowUp[];
  evidence: Evidence[];
}

const SYMBOLS: Record<RequirementStatus, string> = {
  satisfied: "✓",
  unsatisfied: "✗",
  indeterminate: "?",
  in_progress: "◐",
  unknown: "○",
  waived: "⊘",
};

function defaultState(propertyId: string): RequirementState {
  return { propertyId, status: "unknown", evidenceIds: [], updatedAt: "never" };
}

export function renderStatus(input: StatusInput): string {
  const { specIr, runState, followups, evidence } = input;
  const lines: string[] = [];
  lines.push(`Spec: ${specIr.spec.metadata.id} (${specIr.digest.slice(0, 14)}…)`);

  if (runState) {
    lines.push(`Run: ${runState.runId} — ${runState.status.replace("_", " ")}`);
    if (runState.resultRevision) lines.push(`Result revision: ${runState.resultRevision.slice(0, 12)}`);
  } else {
    lines.push("Run: none yet (all properties unknown)");
  }
  lines.push("");

  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  for (const priority of ["must", "should", "may"] as const) {
    const props = specIr.properties.filter((p) => p.priority === priority);
    if (props.length === 0) continue;
    lines.push(priority.toUpperCase(), "");
    for (const p of props) {
      const state = runState?.requirements[p.id] ?? defaultState(p.id);
      lines.push(`  ${SYMBOLS[state.status]} ${p.id} ${p.statement}`);
      if (state.reason) lines.push(`      ${state.reason}`);
      const evs = state.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((e): e is Evidence => e !== undefined);
      if (evs.length > 0) {
        const provenance = evs.map((e) => `${evidenceTrustLabel(e.kind)} ${e.outcome}`).join(", ");
        lines.push(`      evidence: ${provenance}`);
      }
    }
    lines.push("");
  }

  if (runState) {
    const counts = new Map<string, number>();
    for (const s of Object.values(runState.tasks)) {
      counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
    lines.push(`Tasks: ${summary || "none"}`);
  }
  const blocking = followups.filter((f) => f.blocking && f.status === "open");
  const nonBlocking = followups.filter((f) => !f.blocking && f.status === "open");
  lines.push(`Follow-ups: ${blocking.length} blocking, ${nonBlocking.length} non-blocking`);
  for (const f of [...blocking, ...nonBlocking]) {
    lines.push(`  ${f.blocking ? "!" : " "} ${f.id} ${f.title}`);
  }
  return lines.join("\n");
}

export interface DiffInput {
  specIr: SpecIR;
  runState: RunState | null;
}

/** Desired vs observed: the foundation for drift detection. */
export function renderDiff(input: DiffInput): string {
  const { specIr, runState } = input;
  const rows = specIr.properties.map((p) => {
    const state = runState?.requirements[p.id]?.status ?? "unknown";
    return { id: p.id, statement: p.statement, status: state };
  });
  const width = Math.max(...rows.map((r) => `${r.id} ${r.statement}`.length), 20);
  const lines = ["Desired".padEnd(width) + " Observed", ""];
  for (const r of rows) {
    lines.push(`${`${r.id} ${r.statement}`.padEnd(width)} ${SYMBOLS[r.status]} ${r.status}`);
  }
  return lines.join("\n");
}
