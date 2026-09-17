import { isDeterministicCriterion, type Plan, type SpecIR, type Task } from "@spc/schema";
import { error, type Diagnostic } from "../diagnostics.js";
import { findCycle, reachableFrom } from "../graph.js";
import { globToRegExp, isSafeRelativePath, normalizeRelPath, patternsOverlap } from "../glob.js";

/**
 * Deterministic semantic plan validation. A plan is only usable when this
 * passes with zero errors.
 */
export function validatePlan(plan: Plan, ir: SpecIR): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const tasks = plan.tasks;
  const byId = new Map<string, Task>();
  const propertyIds = new Set(ir.properties.map((p) => p.id));

  // SPC2001 - unique task ids.
  for (const t of tasks) {
    if (byId.has(t.id)) {
      diags.push(error("SPC2001", `duplicate task id ${t.id}.`));
    } else {
      byId.set(t.id, t);
    }
  }

  // SPC2002 - known dependencies.
  for (const t of tasks) {
    (t.dependsOn ?? []).forEach((dep) => {
      if (!byId.has(dep)) {
        diags.push(error("SPC2002", `task ${t.id} depends on unknown task ${dep}.`, undefined, [...byId.keys()].sort()));
      }
    });
  }

  // SPC2003 - acyclic graph.
  const edges = (id: string): string[] => byId.get(id)?.dependsOn ?? [];
  const cycle = findCycle(tasks.map((t) => t.id), edges);
  if (cycle) {
    diags.push(error("SPC2003", `task dependency cycle detected: ${cycle.join(" -> ")}.`));
  }

  // SPC2004 - known property references.
  for (const t of tasks) {
    for (const ref of [...(t.satisfies ?? []), ...(t.verifies ?? [])]) {
      if (!propertyIds.has(ref)) {
        diags.push(
          error("SPC2004", `task ${t.id} references unknown property ${ref}.`, undefined, [...propertyIds].sort()),
        );
      }
    }
  }

  // SPC2005 - must-property coverage via satisfies or verifies.
  // SPC2006 - must-property verification path.
  for (const p of ir.properties) {
    if (p.priority !== "must") continue;
    const satisfying = tasks.filter((t) => (t.satisfies ?? []).includes(p.id));
    const verifying = tasks.filter((t) => (t.verifies ?? []).includes(p.id));
    if (satisfying.length === 0 && verifying.length === 0) {
      diags.push(
        error(
          "SPC2005",
          `must-property ${p.id} (${p.statement}) is not addressed by any task (satisfies or verifies).`,
        ),
      );
    }
    const hasDeterministicCriterion = p.acceptance.some(isDeterministicCriterion);
    if (verifying.length === 0 && !hasDeterministicCriterion) {
      diags.push(
        error(
          "SPC2006",
          `must-property ${p.id} has no verification path: no verify task and no command/file acceptance criterion.`,
        ),
      );
    }
  }

  // SPC2007 - concurrent write conflicts without an ordering dependency.
  const writers = tasks.filter((t) => (t.targets?.write ?? []).length > 0);
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i]!;
      const b = writers[j]!;
      const overlap = (a.targets?.write ?? []).some((pa) =>
        (b.targets?.write ?? []).some((pb) => patternsOverlap(pa, pb)),
      );
      if (!overlap) continue;
      const aAfterB = reachableFrom(b.id, edges).has(a.id);
      const bAfterA = reachableFrom(a.id, edges).has(b.id);
      if (!aAfterB && !bAfterA) {
        diags.push(
          error(
            "SPC2007",
            `tasks ${a.id} and ${b.id} have overlapping write targets but no ordering dependency between them.`,
            undefined,
            [...(a.targets?.write ?? []), ...(b.targets?.write ?? [])].sort(),
          ),
        );
      }
    }
  }

  // SPC2008 / SPC2009 - plan/spec identity.
  if (plan.spec.id !== ir.spec.metadata.id) {
    diags.push(
      error("SPC2008", `plan references spec ${plan.spec.id} but was validated against ${ir.spec.metadata.id}.`),
    );
  }
  if (plan.spec.digest !== ir.digest) {
    diags.push(
      error("SPC2009", `plan records spec digest ${plan.spec.digest} but current spec digest is ${ir.digest}.`),
    );
  }

  // SPC2010 - inspect tasks never write.
  for (const t of tasks) {
    if (t.kind === "inspect" && (t.targets?.write ?? []).length > 0) {
      diags.push(error("SPC2010", `inspect task ${t.id} declares write targets; inspection is read-only.`));
    }
  }

  // SPC2011 - safe relative target patterns.
  for (const t of tasks) {
    for (const p of [...(t.targets?.read ?? []), ...(t.targets?.write ?? [])]) {
      const norm = normalizeRelPath(p);
      if (!isSafeRelativePath(norm) && norm !== "**") {
        diags.push(error("SPC2011", `task ${t.id} target "${p}" is not a safe relative path pattern.`));
        continue;
      }
      try {
        globToRegExp(norm);
      } catch {
        diags.push(error("SPC2011", `task ${t.id} target "${p}" is not a valid pattern.`));
      }
    }
  }

  return diags;
}
