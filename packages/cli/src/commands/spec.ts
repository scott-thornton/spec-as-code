import { readFileSync } from "node:fs";
import { formatDiagnostics } from "@spc/core";
import { renderSpecMarkdown, renderSpecText } from "@spc/renderer";
import { jsonSpecValidation } from "./json-views.js";
import { compileSpecFile } from "../context.js";

function sourceOf(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** `spc spec validate <file>` - compiler-quality diagnostics + digest. */
export function runSpecValidate(file: string, format: "text" | "json" = "text"): number {
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
