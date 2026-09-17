import type { Evidence, FollowUp, RequirementState, RunState, SpecIR } from "@spc/schema";

/**
 * Machine-readable views for harness consumption (a coding agent driving
 * the CLI parses these instead of scraping human output). Plain JSON, one
 * shape per command, stable field names.
 */

export interface JsonStatus {
  spec: { id: string; title: string; digest: string };
  run: { id: string; status: string; resultRevision?: string } | null;
  properties: {
    id: string;
    kind: string;
    priority: string;
    category?: string;
    statement: string;
    status: string;
    reason?: string;
    weakEvidence?: boolean;
    evidence: { id: string; kind: string; outcome: string }[];
  }[];
  tasks: { status: string; count: number }[];
  followups: { id: string; runId: string; type: string; blocking: boolean; title: string; status: string }[];
}

export function jsonStatus(input: {
  specIr: SpecIR;
  runState: RunState | null;
  followups: FollowUp[];
  evidence: Evidence[];
}): string {
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]));
  const taskCounts = new Map<string, number>();
  for (const t of Object.values(input.runState?.tasks ?? {})) {
    taskCounts.set(t.status, (taskCounts.get(t.status) ?? 0) + 1);
  }
  const view: JsonStatus = {
    spec: {
      id: input.specIr.spec.metadata.id,
      title: input.specIr.spec.metadata.title,
      digest: input.specIr.digest,
    },
    run: input.runState
      ? {
          id: input.runState.runId,
          status: input.runState.status,
          ...(input.runState.resultRevision ? { resultRevision: input.runState.resultRevision } : {}),
        }
      : null,
    properties: input.specIr.properties.map((p) => {
      const state: RequirementState | undefined = input.runState?.requirements[p.id];
      return {
        id: p.id,
        kind: p.kind,
        priority: p.priority,
        ...(p.category ? { category: p.category } : {}),
        statement: p.statement,
        status: state?.status ?? "unknown",
        ...(state?.reason ? { reason: state.reason } : {}),
        ...(state?.weakEvidence ? { weakEvidence: true } : {}),
        evidence: (state?.evidenceIds ?? [])
          .map((id) => evidenceById.get(id))
          .filter((e): e is Evidence => e !== undefined)
          .map((e) => ({ id: e.id, kind: e.kind, outcome: e.outcome })),
      };
    }),
    tasks: [...taskCounts.entries()].sort().map(([status, count]) => ({ status, count })),
    followups: input.followups.map((f) => ({
      id: f.id,
      runId: f.runId,
      type: f.type,
      blocking: f.blocking,
      title: f.title,
      status: f.status,
    })),
  };
  return JSON.stringify(view, null, 2);
}

export function jsonDiff(specIr: SpecIR, runState: RunState | null): string {
  return JSON.stringify(
    {
      spec: { id: specIr.spec.metadata.id, digest: specIr.digest },
      properties: specIr.properties.map((p) => ({
        id: p.id,
        statement: p.statement,
        priority: p.priority,
        status: runState?.requirements[p.id]?.status ?? "unknown",
      })),
    },
    null,
    2,
  );
}

export function jsonFollowups(items: { runId: string; followup: FollowUp }[]): string {
  return JSON.stringify(
    items.map(({ runId, followup: f }) => ({
      id: f.id,
      runId,
      type: f.type,
      blocking: f.blocking,
      title: f.title,
      description: f.description,
      status: f.status,
      ...(f.propertyId ? { propertyId: f.propertyId } : {}),
      ...(f.command ? { command: f.command } : {}),
      ...(f.options ? { options: f.options.map((o) => o.id) } : {}),
    })),
    null,
    2,
  );
}

export function jsonSpecValidation(input: {
  ok: boolean;
  digest: string | null;
  diagnostics: { code: string; severity: string; message: string; loc?: { file: string; line: number; column: number } }[];
  propertyCount: number;
  mustCount: number;
}): string {
  return JSON.stringify(input, null, 2);
}
