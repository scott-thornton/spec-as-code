export type Severity = "error" | "warning";

export interface SourceLocation {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  loc?: SourceLocation;
  related?: string[];
}

/** Stable diagnostic codes. SPC1005 is a warning; the rest are errors. */
export const DiagnosticCode = {
  YAML_PARSE_ERROR: "SPC0001",
  SCHEMA_INVALID: "SPC0002",
  UNKNOWN_FIELD: "SPC0003",
  SPEC_NOT_FOUND: "SPC0010",
  NOT_A_GIT_REPO: "SPC0011",

  DUPLICATE_PROPERTY_ID: "SPC1001",
  UNKNOWN_PROPERTY_DEPENDENCY: "SPC1002",
  PROPERTY_DEPENDENCY_CYCLE: "SPC1003",
  MUST_PROPERTY_WITHOUT_ACCEPTANCE: "SPC1004",
  OPTIONAL_PROPERTY_WITHOUT_ACCEPTANCE: "SPC1005",

  DUPLICATE_TASK_ID: "SPC2001",
  UNKNOWN_TASK_DEPENDENCY: "SPC2002",
  TASK_DEPENDENCY_CYCLE: "SPC2003",
  UNKNOWN_PROPERTY_REFERENCE: "SPC2004",
  MUST_PROPERTY_NOT_COVERED: "SPC2005",
  MUST_PROPERTY_NOT_VERIFIED: "SPC2006",
  CONCURRENT_WRITE_CONFLICT: "SPC2007",
  PLAN_SPEC_ID_MISMATCH: "SPC2008",
  PLAN_SPEC_DIGEST_MISMATCH: "SPC2009",
  INSPECT_TASK_HAS_WRITES: "SPC2010",
  UNSAFE_TARGET_PATH: "SPC2011",

  AMENDMENT_TASK_NOT_FOUND: "SPC2012",
  AMENDMENT_TARGET_EXECUTED: "SPC2013",
  AMENDMENT_DUPLICATE_TASK: "SPC2014",
  AMENDMENT_CYCLE: "SPC2015",
} as const;

export function error(code: string, message: string, loc?: SourceLocation, related?: string[]): Diagnostic {
  return { code, severity: "error", message, ...(loc ? { loc } : {}), ...(related ? { related } : {}) };
}

export function warning(
  code: string,
  message: string,
  loc?: SourceLocation,
  related?: string[],
): Diagnostic {
  return { code, severity: "warning", message, ...(loc ? { loc } : {}), ...(related ? { related } : {}) };
}

export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

export function formatDiagnostic(d: Diagnostic, sources?: ReadonlyMap<string, string>): string {
  const severity = d.severity;
  const head =
    d.loc !== undefined
      ? `${severity} ${d.code} ${d.loc.file}:${d.loc.line}:${d.loc.column}`
      : `${severity} ${d.code}`;
  const lines = [head, "", d.message];
  if (d.related?.length) {
    lines.push("", "Related:", ...d.related.map((r) => `  ${r}`));
  }
  const source = d.loc !== undefined ? sources?.get(d.loc.file) : undefined;
  if (d.loc !== undefined && source !== undefined) {
    const excerpt = renderExcerpt(source, d.loc);
    if (excerpt.length > 0) {
      lines.push("", ...excerpt);
    }
  }
  return lines.join("\n");
}

export function formatDiagnostics(diags: Diagnostic[], sources?: ReadonlyMap<string, string>): string {
  return diags.map((d) => formatDiagnostic(d, sources)).join("\n\n");
}

function renderExcerpt(source: string, loc: SourceLocation): string[] {
  const lines = source.split("\n");
  const idx = loc.line - 1;
  if (idx < 0 || idx >= lines.length) return [];
  const shown = lines
    .slice(idx, idx + 2)
    .map((l, i) => `${String(loc.line + i).padStart(4)} | ${l}`);
  const first = lines[idx] ?? "";
  const caretPad = " ".repeat(Math.min(Math.max(loc.column - 1, 0), Math.max(first.length, 1)));
  shown.push(`${" ".repeat(4)} | ${caretPad}${"^".repeat(1)}`);
  return shown;
}
