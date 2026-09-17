import type { DesiredProperty, Evidence, RequirementState } from "@spc/schema";
import { isDeterministicCriterion } from "@spc/schema";

/**
 * Requirement satisfaction is DERIVED from evidence. Agent completion
 * claims are never sufficient. Uncertain evidence is never dressed up
 * as certainty.
 */

export interface EvaluationOptions {
  allowAgentOnly: boolean;
  inProgressPropertyIds?: ReadonlySet<string>;
  now?: () => string;
}

interface CriterionVerdict {
  criterionId: string;
  type: string;
  status: "pass" | "fail" | "indeterminate" | "unevaluated";
  evidenceId?: string;
  detail: string;
  deterministic: boolean;
}

function latestByCriterion(evidence: readonly Evidence[]): Map<string, Evidence> {
  const latest = new Map<string, Evidence>();
  for (const e of evidence) {
    if (e.criterionId === undefined) continue;
    const current = latest.get(e.criterionId);
    if (!current || e.timestamp >= current.timestamp) latest.set(e.criterionId, e);
  }
  return latest;
}

export function evaluateProperty(
  property: DesiredProperty,
  evidence: readonly Evidence[],
  options: EvaluationOptions,
): RequirementState {
  const now = (options.now ?? (() => new Date().toISOString()))();
  const relevant = evidence.filter((e) => e.propertyRefs.includes(property.id));
  const used: string[] = [];

  // Explicit human waiver.
  const waiver = relevant.find(
    (e) => e.kind === "human" && (e.payload as { waive?: boolean } | null)?.waive === true,
  );
  if (waiver) {
    return {
      propertyId: property.id,
      status: "waived",
      evidenceIds: [waiver.id],
      updatedAt: now,
      reason: "explicitly waived by human decision",
    };
  }

  const latest = latestByCriterion(relevant);
  const verdicts: CriterionVerdict[] = [];

  for (const criterion of property.acceptance) {
    const e = latest.get(criterion.id);
    if (!e) {
      verdicts.push({
        criterionId: criterion.id,
        type: criterion.type,
        status: "unevaluated",
        detail: "no evidence recorded",
        deterministic: isDeterministicCriterion(criterion),
      });
      continue;
    }
    used.push(e.id);
    if (e.outcome === "supports") {
      verdicts.push({
        criterionId: criterion.id,
        type: criterion.type,
        status: "pass",
        evidenceId: e.id,
        detail: `${e.kind} evidence supports`,
        deterministic: isDeterministicCriterion(criterion),
      });
    } else if (e.outcome === "contradicts") {
      verdicts.push({
        criterionId: criterion.id,
        type: criterion.type,
        status: "fail",
        evidenceId: e.id,
        detail: `${e.kind} evidence contradicts`,
        deterministic: isDeterministicCriterion(criterion),
      });
    } else {
      verdicts.push({
        criterionId: criterion.id,
        type: criterion.type,
        status: "indeterminate",
        evidenceId: e.id,
        detail: `${e.kind} evidence inconclusive`,
        deterministic: isDeterministicCriterion(criterion),
      });
    }
  }

  const fail = verdicts.find((v) => v.status === "fail");
  if (fail) {
    return {
      propertyId: property.id,
      status: "unsatisfied",
      evidenceIds: used,
      updatedAt: now,
      reason: `criterion ${fail.criterionId} contradicted (${fail.detail})`,
    };
  }

  const indeterminate = verdicts.find((v) => v.status === "indeterminate");
  if (indeterminate) {
    return {
      propertyId: property.id,
      status: "indeterminate",
      evidenceIds: used,
      updatedAt: now,
      reason: `criterion ${indeterminate.criterionId} inconclusive (${indeterminate.detail})`,
    };
  }

  const unevaluated = verdicts.find((v) => v.status === "unevaluated");
  if (unevaluated) {
    const inProgress = options.inProgressPropertyIds?.has(property.id) ?? false;
    return {
      propertyId: property.id,
      status: inProgress ? "in_progress" : "unknown",
      evidenceIds: used,
      updatedAt: now,
      reason: `criterion ${unevaluated.criterionId} not yet evaluated`,
    };
  }

  // Every criterion passes.
  const anyDeterministicPass = verdicts.some((v) => v.status === "pass" && v.deterministic);
  const anyAgentPass = verdicts.some((v) => v.status === "pass" && v.type === "agent");
  if (!anyDeterministicPass && anyAgentPass && !options.allowAgentOnly) {
    return {
      propertyId: property.id,
      status: "indeterminate",
      evidenceIds: used,
      updatedAt: now,
      reason: "verified only by agent evaluation; set verification.allowAgentOnlyMustRequirements to accept agent-only evidence",
      weakEvidence: true,
    };
  }
  return {
    propertyId: property.id,
    status: "satisfied",
    evidenceIds: used,
    updatedAt: now,
    ...(anyDeterministicPass ? {} : { weakEvidence: true }),
  };
}

/** Run-completion semantics: every must property satisfied or explicitly waived. */
export function mustPropertiesSatisfied(
  properties: readonly DesiredProperty[],
  states: ReadonlyMap<string, RequirementState>,
): boolean {
  return properties
    .filter((p) => p.priority === "must")
    .every((p) => {
      const s = states.get(p.id);
      return s !== undefined && (s.status === "satisfied" || s.status === "waived");
    });
}
