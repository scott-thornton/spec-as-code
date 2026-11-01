import type { DesiredProperty } from "@spc/schema";

/**
 * Suite-reference resolution (specs/suite-references): a {type: suite,
 * ref} criterion normalizes into the EXISTING command representation
 * BEFORE the evaluator sees it - command = the suite's current
 * definition, expected exit 0, no per-spec timeout (the invocation
 * default applies, so two references to one suite always resolve to
 * the identical complete execution descriptor and the memo/cache see
 * them as the same command). The suite id and digest travel as
 * provenance metadata into the criterion's evidence payload - suite
 * identity (which battery was referenced) stays distinct from
 * execution identity (which physical run produced the result). There
 * is no second execution pathway: policy, approval,
 * environment-readiness, memo and cache lookup all see an ordinary
 * command criterion.
 */

export interface SuiteProvenance {
  suite: string;
  suiteDigest: string;
}

/** The registry shape the verifier consumes (loader: @spc/repo loadSuiteRegistry). */
export type SuiteRegistryEntry = { id: string; command: string; digest: string; title?: string };
export type SuiteRegistry = ReadonlyMap<string, SuiteRegistryEntry>;

function suiteUnknown(ref: string, criterionId: string): Error {
  const e = new Error(`criterion ${criterionId} references suite "${ref}" which is not defined under suites/`);
  (e as Error & { code?: string }).code = "SPC_SUITE_UNKNOWN";
  return e;
}

/**
 * Normalize every suite criterion in the property set to its command
 * form against the frozen registry. Throws SPC_SUITE_UNKNOWN naming the
 * ref and criterion when a reference resolves to nothing - an unknown
 * reference is a compile error, never a silent no-op.
 */
export function normalizeSuiteCriteria(
  properties: DesiredProperty[],
  suites: SuiteRegistry,
): { properties: DesiredProperty[]; provenance: Map<string, SuiteProvenance> } {
  const provenance = new Map<string, SuiteProvenance>();
  const normalized = properties.map((property) => {
    if (!property.acceptance.some((c) => c.type === "suite")) return property;
    const acceptance = property.acceptance.map((criterion) => {
      if (criterion.type !== "suite") return criterion;
      const def = suites.get(criterion.ref);
      if (!def) throw suiteUnknown(criterion.ref, criterion.id);
      provenance.set(criterion.id, { suite: def.id, suiteDigest: def.digest });
      return {
        id: criterion.id,
        type: "command" as const,
        command: def.command,
        expect: { exitCode: 0 },
      };
    });
    return { ...property, acceptance };
  });
  return { properties: normalized, provenance };
}
