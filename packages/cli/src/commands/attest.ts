import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { SpcError } from "@spc/core";
import { EvidenceStore, createVerifyRun, spcPaths } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveAllSpecs, resolveRepoRoot } from "../context.js";
import { currentRevision } from "@spc/repo";

/**
 * `spc attest <propertyId> --by <name>` - the human tier's recording
 * ceremony. Every evidence kind has a producer except this one, and
 * agent-only should properties sat indeterminate forever (CHK3555's
 * DESIGN-001). Writes a human-review evidence record under a fresh
 * verify run and flips the property to satisfied with named provenance.
 * Read-only outside .spc.
 */
export async function runAttest(options: { propertyId: string; by: string; note?: string; cwd?: string }): Promise<number> {
  const repoRoot = resolveRepoRoot(options.cwd);
  const config = loadRepoConfig(repoRoot);
  const specs = resolveAllSpecs(path.join(repoRoot, "specs"));
  const owner = specs.find(({ ir }) => ir.properties.some((p) => p.id === options.propertyId));
  if (!owner) {
    throw new SpcError(
      "ATTEST_PROPERTY_NOT_FOUND",
      `no property ${options.propertyId} exists under ${path.join(repoRoot, "specs")}`,
    );
  }
  const provider = await createProvider(config, repoRoot);
  const report = await createVerifyRun({ repoRoot, specIr: owner.ir, config, provider });
  const paths = spcPaths(repoRoot);

  const evidence = new EvidenceStore(paths.evidenceFile(report.runId));
  evidence.load();
  evidence.add({
    id: `EV-HUMAN-${options.propertyId}`,
    runId: report.runId,
    propertyRefs: [options.propertyId],
    kind: "human",
    outcome: "supports",
    producer: { type: "human", identity: options.by },
    timestamp: new Date().toISOString(),
    repositoryRevision: currentRevision(repoRoot),
    payload: { instruction: "human attestation", note: options.note ?? "attested" },
  });

  const stateFile = paths.stateFile(report.runId);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
    requirements: Record<string, Record<string, unknown>>;
  };
  state.requirements[options.propertyId] = {
    ...state.requirements[options.propertyId],
    status: "satisfied",
    reason: `attested by ${options.by}: human-review evidence${options.note ? ` - ${options.note}` : ""}`,
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  console.log(`Attested ${options.propertyId} by ${options.by}${options.note ? `: ${options.note}` : ""}`);
  console.log(`Evidence: ${paths.evidenceFile(report.runId)}`);
  return 0;
}
