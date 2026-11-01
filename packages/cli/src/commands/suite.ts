import path from "node:path";
import { loadSuiteRegistry } from "@spc/repo";
import { resolveAllSpecs, resolveRepoRoot } from "../context.js";

/**
 * `spc suite validate|list` (specs/suite-references): suites/*.yaml are
 * repository facts - one definition, referenced by name, executed once
 * however many criteria demand it. validate is the registry's compile
 * check (named diagnostics on malformed files or duplicate ids); list
 * renders the registry with reference counts, so changing a battery
 * shows its blast radius during review.
 */

export function runSuiteValidate(cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  let registry;
  try {
    registry = loadSuiteRegistry(repoRoot);
  } catch (e) {
    const err = e as Error & { code?: string };
    console.error(`error ${err.code ?? "SPC_SUITE_INVALID"}: ${err.message}`);
    return 1;
  }
  if (registry.size === 0) {
    console.log(`registry valid: 0 suites (no suites/ directory or no definitions)`);
    return 0;
  }
  console.log(`registry valid: ${registry.size} suite${registry.size === 1 ? "" : "s"}`);
  for (const def of [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${def.id}  ${def.file}  ${def.digest.slice(0, 16)}`);
  }
  return 0;
}

/** Count {type: suite} criteria referencing each suite across specs/. */
function referenceCounts(repoRoot: string): Map<string, number> {
  const counts = new Map<string, number>();
  let specs;
  try {
    specs = resolveAllSpecs(path.join(repoRoot, "specs"));
  } catch {
    return counts;
  }
  for (const { ir } of specs) {
    for (const property of ir.properties) {
      for (const criterion of property.acceptance) {
        if (criterion.type === "suite") {
          counts.set(criterion.ref, (counts.get(criterion.ref) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

export function runSuiteList(cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  let registry;
  try {
    registry = loadSuiteRegistry(repoRoot);
  } catch (e) {
    const err = e as Error & { code?: string };
    console.error(`error ${err.code ?? "SPC_SUITE_INVALID"}: ${err.message}`);
    return 1;
  }
  const counts = referenceCounts(repoRoot);
  if (registry.size === 0) {
    console.log(`no suites defined under ${path.join(repoRoot, "suites")}`);
    return 0;
  }
  for (const def of [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const refs = counts.get(def.id) ?? 0;
    console.log(`${def.id.padEnd(24)} ${String(refs).padStart(3)} ref${refs === 1 ? "" : "s"}  ${def.title}`);
    console.log(`${"".padEnd(24)} ${def.command}`);
  }
  // Referenced-but-undefined ids surface here too: they are compile
  // errors at validate time, and listing them keeps the blast-radius
  // view honest.
  for (const [ref, count] of [...counts.entries()].sort()) {
    if (!registry.has(ref)) {
      console.log(`${ref.padEnd(24)} ${String(count).padStart(3)} refs  UNDEFINED - no suite file defines this id`);
    }
  }
  return 0;
}
