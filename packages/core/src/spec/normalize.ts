import type {
  AcceptanceCriterion,
  Constraint,
  DesiredProperty,
  NormalizedSpec,
  Requirement,
  Spec,
} from "@spc/schema";

function sortUnique(list: readonly string[]): string[] {
  return [...new Set(list)].sort();
}

function normalizeCriterion(c: AcceptanceCriterion): AcceptanceCriterion {
  if (c.type === "command") {
    return { ...c, expect: { exitCode: c.expect?.exitCode ?? 0 } };
  }
  return c;
}

function toProperty(
  kind: "requirement" | "constraint",
  source: Requirement | Constraint,
): DesiredProperty {
  const scope = "scope" in source ? source.scope : undefined;
  return {
    kind,
    id: source.id,
    statement: source.statement,
    priority: source.priority ?? "must",
    ...(source.category ? { category: source.category } : {}),
    dependsOn: sortUnique(source.dependsOn ?? []),
    acceptance: (source.acceptance ?? []).map(normalizeCriterion),
    ...(scope ? { scope } : {}),
    ...(source.metadata ? { metadata: source.metadata } : {}),
  };
}

/**
 * Compiler normalization: apply defaults, sort and de-duplicate documented
 * set-like arrays, and fold requirements/constraints into the common
 * desired-property representation. Array order of requirements,
 * constraints, acceptance criteria and outOfScope is preserved.
 */
export function normalizeSpec(input: Spec): NormalizedSpec {
  return {
    ...input,
    requirements: input.requirements.map((r) => toProperty("requirement", r)),
    constraints: (input.constraints ?? []).map((c) => toProperty("constraint", c)),
    outOfScope: input.outOfScope ? [...input.outOfScope] : [],
  };
}
