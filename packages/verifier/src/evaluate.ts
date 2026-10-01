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
  /** Enforce the red -> green flip for criteria marked discriminating. */
  requireRedPhase?: boolean;
}

interface CriterionVerdict {
  criterionId: string;
  type: string;
  status: "pass" | "fail" | "indeterminate" | "unevaluated";
  evidenceId?: string;
  detail: string;
  deterministic: boolean;
  redPhase?: "flipped" | "passed_at_base" | "no_red_evidence";
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

function isDiscriminating(c: DesiredProperty["acceptance"][number]): boolean {
  return (c.type === "command" || c.type === "file") && c.discriminating === true;
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

  // Result-tree evidence only: red-phase records describe the base
  // revision and must never stand in for the current state.
  const latest = latestByCriterion(relevant.filter((e) => e.phase !== "red"));
  const latestRed = options.requireRedPhase
    ? latestByCriterion(relevant.filter((e) => e.phase === "red"))
    : new Map<string, Evidence>();
  const verdicts: CriterionVerdict[] = [];

  for (const criterion of property.acceptance) {
    const e = latest.get(criterion.id);
    let verdict: CriterionVerdict;
    if (!e) {
      verdict = {
        criterionId: criterion.id,
        type: criterion.type,
        status: "unevaluated",
        detail: "no evidence recorded",
        deterministic: isDeterministicCriterion(criterion),
      };
    } else if (e.outcome === "supports") {
      verdict = {
        criterionId: criterion.id,
        type: criterion.type,
        status: "pass",
        evidenceId: e.id,
        detail: `${e.kind} evidence supports`,
        deterministic: isDeterministicCriterion(criterion),
      };
    } else if (e.outcome === "contradicts") {
      verdict = {
        criterionId: criterion.id,
        type: criterion.type,
        status: "fail",
        evidenceId: e.id,
        detail: `${e.kind} evidence contradicts`,
        deterministic: isDeterministicCriterion(criterion),
      };
    } else {
      verdict = {
        criterionId: criterion.id,
        type: criterion.type,
        status: "indeterminate",
        evidenceId: e.id,
        detail: `${e.kind} evidence inconclusive`,
        deterministic: isDeterministicCriterion(criterion),
      };
    }
    if (e) used.push(e.id);
    // Red-phase flip rule: a discriminating criterion's pass is earned
    // only by a demonstrated red -> green flip. A criterion that already
    // supported at the base revision tests nothing about this change.
    if (options.requireRedPhase && isDiscriminating(criterion) && verdict.status === "pass") {
      const red = latestRed.get(criterion.id);
      if (!red) {
        verdict = {
          ...verdict,
          status: "indeterminate",
          detail: "no red-phase evidence recorded; the criterion must fail at the run's base revision",
          redPhase: "no_red_evidence",
        };
      } else if (red.outcome === "supports") {
        verdict = {
          ...verdict,
          status: "indeterminate",
          detail: "criterion passed at base revision; it does not discriminate this change",
          redPhase: "passed_at_base",
        };
      } else {
        verdict = { ...verdict, redPhase: "flipped" };
      }
    }
    verdicts.push(verdict);
  }

  // Property-level red-phase summary: the worst per-criterion state wins,
  // so decorative criteria surface even when others flipped cleanly.
  let redPhase: CriterionVerdict["redPhase"];
  if (options.requireRedPhase && property.acceptance.some(isDiscriminating)) {
    redPhase = verdicts.some((v) => v.redPhase === "passed_at_base")
      ? "passed_at_base"
      : verdicts.some((v) => v.redPhase === "no_red_evidence")
        ? "no_red_evidence"
        : "flipped";
  }
  const redPhaseField = redPhase ? { redPhase } : {};

  const fail = verdicts.find((v) => v.status === "fail");
  if (fail) {
    return {
      propertyId: property.id,
      status: "unsatisfied",
      evidenceIds: used,
      updatedAt: now,
      reason: `criterion ${fail.criterionId} contradicted (${fail.detail})`,
      ...redPhaseField,
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
      ...redPhaseField,
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
      ...redPhaseField,
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
      ...redPhaseField,
    };
  }
  return {
    propertyId: property.id,
    status: "satisfied",
    evidenceIds: used,
    updatedAt: now,
    ...(anyDeterministicPass ? {} : { weakEvidence: true }),
    ...redPhaseField,
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
