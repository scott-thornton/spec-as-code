import type { Constraint, Priority, Requirement, Spec } from "@spc/schema";
import { error, warning, type Diagnostic, type SourceLocation } from "../diagnostics.js";
import { findCycle } from "../graph.js";

export type Locs = ReadonlyMap<string, SourceLocation>;

interface PropertySlot {
  base: "requirements" | "constraints";
  index: number;
  id: string;
  priority: Priority | undefined;
  kind: "requirement" | "constraint";
  dependsOn: string[];
  acceptanceCount: number;
}

function slots(spec: Spec): PropertySlot[] {
  const out: PropertySlot[] = [];
  spec.requirements.forEach((r: Requirement, i) =>
    out.push({
      base: "requirements",
      index: i,
      id: r.id,
      priority: r.priority,
      kind: "requirement",
      dependsOn: r.dependsOn ?? [],
      acceptanceCount: (r.acceptance ?? []).length,
    }),
  );
  (spec.constraints ?? []).forEach((c: Constraint, i) =>
    out.push({
      base: "constraints",
      index: i,
      id: c.id,
      priority: c.priority,
      kind: "constraint",
      dependsOn: c.dependsOn ?? [],
      acceptanceCount: (c.acceptance ?? []).length,
    }),
  );
  return out;
}

export function effectivePriority(slot: { priority: Priority | undefined; kind: string }): Priority {
  if (slot.priority !== undefined) return slot.priority;
  // Constraints default to must; requirements declare priority explicitly.
  return slot.kind === "constraint" ? "must" : "must";
}

/** Intra-file semantic checks: identity uniqueness, acceptance completeness. */
export function validateSpecLocal(spec: Spec, locs: Locs): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const props = slots(spec);

  // SPC1001 — duplicate property ids across requirements and constraints.
  const firstSeen = new Map<string, PropertySlot>();
  for (const p of props) {
    const prior = firstSeen.get(p.id);
    if (prior) {
      diags.push(
        error(
          "SPC1001",
          `duplicate property id ${p.id}: defined as a ${prior.kind} and again as a ${p.kind}.`,
          locs.get(`${p.base}.${p.index}.id`),
          [`first definition: ${prior.base}[${prior.index}]`],
        ),
      );
    } else {
      firstSeen.set(p.id, p);
    }
  }

  // SPC1001 (criteria) — duplicate acceptance criterion ids across the spec.
  const critSeen = new Set<string>();
  for (const p of props) {
    const list =
      p.base === "requirements"
        ? spec.requirements[p.index]?.acceptance
        : spec.constraints?.[p.index]?.acceptance;
    (list ?? []).forEach((c, ci) => {
      if (critSeen.has(c.id)) {
        diags.push(
          error(
            "SPC1001",
            `duplicate acceptance criterion id ${c.id} on property ${p.id}.`,
            locs.get(`${p.base}.${p.index}.acceptance.${ci}.id`),
          ),
        );
      } else {
        critSeen.add(c.id);
      }
    });
  }

  // SPC1004 / SPC1005 — acceptance completeness.
  for (const p of props) {
    const priority = effectivePriority(p);
    if (p.acceptanceCount === 0) {
      if (priority === "must") {
        diags.push(
          error(
            "SPC1004",
            `${p.kind} ${p.id} has priority "must" but no acceptance criteria; must-properties must be verifiable.`,
            locs.get(`${p.base}.${p.index}.id`),
          ),
        );
      } else {
        diags.push(
          warning(
            "SPC1005",
            `${p.kind} ${p.id} has priority "${priority}" and no acceptance criteria; it cannot be verified mechanically.`,
            locs.get(`${p.base}.${p.index}.id`),
          ),
        );
      }
    }
  }

  return diags;
}

/** Cross-reference checks: dependsOn resolution and cycles (run over the full composed property set). */
export function validateSpecCrossRefs(spec: Spec, locs: Locs): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const props = slots(spec);
  const ids = new Set(props.map((p) => p.id));

  // SPC1002 — unknown property dependencies.
  for (const p of props) {
    p.dependsOn.forEach((dep, di) => {
      if (!ids.has(dep)) {
        diags.push(
          error(
            "SPC1002",
            `Property ${p.id} references unknown dependency ${dep}.`,
            locs.get(`${p.base}.${p.index}.dependsOn.${di}`),
            [...ids].sort(),
          ),
        );
      }
    });
  }

  // SPC1003 — dependency cycles.
  const edges = (id: string): string[] => props.find((p) => p.id === id)?.dependsOn ?? [];
  const cycle = findCycle(props.map((p) => p.id), edges);
  if (cycle) {
    const start = props.find((p) => p.id === cycle[0]);
    diags.push(
      error(
        "SPC1003",
        `property dependency cycle detected: ${cycle.join(" -> ")}.`,
        start ? locs.get(`${start.base}.${start.index}`) : undefined,
      ),
    );
  }

  return diags;
}

export function validateSpecSemantics(spec: Spec, locs: Locs): Diagnostic[] {
  return [...validateSpecLocal(spec, locs), ...validateSpecCrossRefs(spec, locs)];
}
