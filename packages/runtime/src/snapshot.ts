import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SpecIR } from "@spc/schema";
import type { spcPaths } from "./paths.js";
import { compileSpecFile } from "@spc/repo";

/** Locate the spec file whose compiled id matches, best-effort. */
export function findSpecSource(specsDir: string, specId: string): string | null {
  if (!readdirSync(specsDir)) return null;
  for (const f of readdirSync(specsDir)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const file = `${specsDir}/${f}`;
    try {
      const compiled = compileSpecFile(file);
      if (compiled.ok && compiled.ir && compiled.ir.spec.metadata.id === specId) return readFileSync(file, "utf8");
    } catch {
      // unreadable candidate: skip
    }
  }
  return null;
}

/**
 * Freeze the spec a run obligated against: source text + compiled
 * digest in the run directory, written at creation - so historical
 * audit and bundle export can always reconstruct the contract even
 * after the spec is amended (the known export gap).
 */
export function writeSpecSnapshot(
  paths: ReturnType<typeof spcPaths>,
  runId: string,
  specIr: SpecIR,
  specSource: string,
  now: () => string = () => new Date().toISOString(),
): void {
  const header = [
    "# spc frozen spec snapshot - reconstructible record of what this run obligated against",
    `# digest: ${specIr.digest}`,
    `# frozenAt: ${now()}`,
    "The frozen spec source follows verbatim.",
    "",
  ].join("\n");
  writeFileSync(path.join(paths.runDir(runId), "spec-snapshot.yaml"), header + specSource, "utf8");
}
