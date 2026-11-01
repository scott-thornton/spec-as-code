import { readFileSync } from "node:fs";
import { formatDiagnostics } from "@spc/core";
import { renderSpecMarkdown, renderSpecText } from "@spc/renderer";
import { jsonSpecValidation } from "./json-views.js";
import { compileSpecFile, loadRepoConfig, resolveRepoRoot } from "../context.js";
import { lintSpec } from "./lint.js";
import { loadSuiteRegistry, type SuiteDefinition } from "@spc/repo";

function sourceOf(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** `spc spec validate <file>` - compiler-quality diagnostics + digest. */
export function runSpecValidate(file: string, format: "text" | "json" = "text", showCommands = false): number {
  const result = compileSpecFile(file);
  if (format === "json") {
    const ok = result.ok && result.ir !== null;
    console.log(
      jsonSpecValidation({
        ok,
        digest: result.ir?.digest ?? null,
        diagnostics: result.diagnostics.map((d) => ({
          code: d.code,
          severity: d.severity,
          message: d.message,
          ...(d.loc ? { loc: d.loc } : {}),
        })),
        propertyCount: result.ir?.properties.length ?? 0,
        mustCount: result.ir?.properties.filter((p) => p.priority === "must").length ?? 0,
      }),
    );
    return ok ? 0 : 1;
  }
  const sources = new Map([[file, sourceOf(file)]]);
  if (result.diagnostics.length > 0) {
    console.log(formatDiagnostics(result.diagnostics, sources));
    console.log();
  }
  if (!result.ok || !result.ir) {
    const errors = result.diagnostics.filter((d) => d.severity === "error").length;
    console.log(`Spec invalid: ${errors} error(s).`);
    return 1;
  }
  // Repository-aware suite validation (specs/suite-references): a
  // suite reference that names no suite in the registry is a compile
  // error here - a typo'd ref must never reach verification.
  let suites: Map<string, SuiteDefinition> | null = null;
  try {
    suites = loadSuiteRegistry(resolveRepoRoot());
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(`error ${err.code ?? "SPC_SUITE_INVALID"}: ${err.message}`);
    return 1;
  }
  const unknownRefs: string[] = [];
  for (const property of result.ir.properties) {
    for (const criterion of property.acceptance) {
      if (criterion.type === "suite" && !suites.has(criterion.ref)) {
        unknownRefs.push(`${criterion.id} references suite "${criterion.ref}" which is not defined under suites/`);
      }
    }
  }
  if (unknownRefs.length > 0) {
    for (const line of unknownRefs) console.log(`error SPC_SUITE_UNKNOWN: ${line}`);
    console.log();
    console.log(`Spec invalid: ${unknownRefs.length} unknown suite reference(s).`);
    return 1;
  }
  // Static lint warnings fold into validate; NOTHING executes here -
  // gates read. Dynamic checks live only in `spc spec lint`.
  const config = loadRepoConfig(resolveRepoRoot());
  const lint = lintSpec(result.ir, config, sources.get(file) ?? "", { suites });
  if (lint.length > 0) {
    console.log();
    for (const w of lint) console.log(`lint warning: ${w.rule} ${w.target}: ${w.message}`);
  }
  const propertyCount = result.ir.properties.length;
  const mustCount = result.ir.properties.filter((p) => p.priority === "must").length;
  console.log(`✓ schema valid`);
  console.log(`✓ ${propertyCount} properties (${mustCount} must)`);
  console.log(`✓ dependency graph valid`);
  const mustWithoutDeterministic = result.ir.properties.filter(
    (p) => p.priority === "must" && !p.acceptance.some((c) => c.type === "command" || c.type === "file"),
  );
  if (mustWithoutDeterministic.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const p of mustWithoutDeterministic) {
      console.log(`  ${p.id} uses only agent/human verification.`);
    }
  }
  console.log("");
  console.log(`Spec valid.`);
  console.log(`Digest: ${result.ir.digest}`);
  if (showCommands) {
    const commands = result.ir.properties.flatMap((p) =>
      p.acceptance.flatMap((c) => {
        if (c.type === "command") return [`  ${c.id}: ${c.command}`];
        if (c.type === "suite") {
          const def = suites?.get(c.ref);
          return [`  ${c.id}: [suite ${c.ref}] ${def ? def.command : "(unresolved)"}`];
        }
        return [];
      }),
    );
    if (commands.length > 0) {
      console.log("");
      console.log("Commands (parsed, post-YAML):");
      for (const line of commands) console.log(line);
    }
  }
  return 0;
}

/** `spc spec show <file> [--format markdown|text]` - generated view. */
export function runSpecShow(file: string, format: "markdown" | "text"): number {
  const result = compileSpecFile(file);
  if (!result.ok || !result.ir) {
    console.log(formatDiagnostics(result.diagnostics, new Map([[file, sourceOf(file)]])));
    return 1;
  }
  console.log(format === "markdown" ? renderSpecMarkdown(result.ir) : renderSpecText(result.ir));
  return 0;
}
