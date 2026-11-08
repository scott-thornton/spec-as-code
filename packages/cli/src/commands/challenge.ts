import path from "node:path";
import { runChallenge } from "@spc/runtime";
import { resolveRepoRoot } from "../context.js";

/**
 * `spc challenge <fixture>` (specs/criterion-challenge): falsify an
 * acceptance criterion with a committed negative fixture. Exit codes:
 * 0 discriminating, 1 non-discriminating (the verifier failed to
 * reject a known defect), 2 invalid-baseline / inconclusive / unknown
 * fixture (nothing proven). No confidence metric - the outcome is
 * sensitivity to the tested counterexample, nothing more.
 */
export async function runChallengeCommand(fixtureRef: string, cwd?: string): Promise<number> {
  const repoRoot = resolveRepoRoot(cwd);
  const name = fixtureRef
    .replace(/^challenges\//, "")
    .replace(/\.yaml$/, "");
  let result;
  try {
    result = await runChallenge(repoRoot, name);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  const p = result.record["provenance"] as Record<string, string> | undefined;
  console.log(`Challenge ${name}: ${result.outcome}`);
  console.log(`  criterion: ${JSON.stringify(result.record["criterion"])}`);
  console.log(`  baseline:  ${result.baseline.outcome}${result.baseline.shape ? ` (${result.baseline.shape})` : ""}`);
  console.log(`  mutation:  ${result.mutation.outcome}${result.mutation.shape ? ` (${result.mutation.shape})` : ""}`);
  console.log(`  signature: ${result.record["signaturePresent"] ? `detected (${result.record["expectedSignature"]})` : "absent"}`);
  const sigLine = result.record["signatureLine"];
  if (typeof sigLine === "string" && sigLine !== "") console.log(`    ${sigLine.trim().slice(0, 160)}`);
  if (p && (p.introduced || p.caught)) {
    console.log(`  provenance: introduced ${p.introduced || "?"} - caught ${p.caught || "?"} (${p.diagnostic || "archived defect"})`);
  }
  console.log(`Record: ${path.join(repoRoot, ".spc", "challenges", `${name}.json`)}`);
  if (result.outcome === "discriminating") return 0;
  if (result.outcome === "non-discriminating") return 1;
  return 2;
}
