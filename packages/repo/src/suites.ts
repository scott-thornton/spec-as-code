import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { suiteFileSchema, type SuiteFile } from "@spc/schema";

/**
 * The suite registry (specs/suite-references): suites/*.yaml beside
 * specs/ are named command batteries - repository facts, version
 * controlled, schema-validated, NOT spec-owned. A criterion references
 * one by id and resolution normalizes it to the suite's CURRENT
 * command at verify time, so the digest recorded in evidence describes
 * what was used and never pins the spec. The loader is deliberately
 * whole-directory and loud: a malformed file or duplicate id fails the
 * invocation naming the offender, because a silently-ignored battery
 * is worse than a failed one.
 */

export interface SuiteDefinition {
  id: string;
  title: string;
  command: string;
  /** Digest of the definition (id + title + command) - provenance, not a pin. */
  digest: string;
  /** The file the definition was loaded from, for diagnostics. */
  file: string;
}

function suiteError(code: string, message: string): Error {
  const e = new Error(message);
  (e as Error & { code?: string }).code = code;
  return e;
}

export function suiteDigestOf(def: { id: string; title: string; command: string }): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify({ id: def.id, title: def.title, command: def.command }), "utf8").digest("hex");
}

/**
 * Load every suite under <root>/suites/*.yaml. Absent directory = an
 * empty registry (suite discovery is additive). Throws SPC_SUITE_INVALID
 * naming the file on a malformed definition and SPC_SUITE_DUPLICATE
 * naming both files on a duplicate id.
 */
export function loadSuiteRegistry(root: string): Map<string, SuiteDefinition> {
  const registry = new Map<string, SuiteDefinition>();
  const dir = path.join(root, "suites");
  if (!existsSync(dir)) return registry;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const file = path.join(dir, entry);
    let parsed: unknown;
    try {
      parsed = YAML.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw suiteError("SPC_SUITE_INVALID", `suite file ${path.relative(root, file)} is not valid YAML: ${(e as Error).message}`);
    }
    const result = suiteFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw suiteError("SPC_SUITE_INVALID", `suite file ${path.relative(root, file)} is invalid: ${issues}`);
    }
    const def = result.data;
    const prior = registry.get(def.metadata.id);
    if (prior) {
      throw suiteError(
        "SPC_SUITE_DUPLICATE",
        `duplicate suite id "${def.metadata.id}" defined in both ${prior.file} and ${path.relative(root, file)}`,
      );
    }
    registry.set(def.metadata.id, {
      id: def.metadata.id,
      title: def.metadata.title,
      command: def.command,
      digest: suiteDigestOf({ id: def.metadata.id, title: def.metadata.title, command: def.command }),
      file: path.relative(root, file),
    });
  }
  return registry;
}
