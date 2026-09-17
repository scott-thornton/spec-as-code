import path from "node:path";
import type { Spec, SpecIR } from "@spc/schema";
import { error, hasErrors, type Diagnostic, type SourceLocation } from "../diagnostics.js";
import { finalizeSpec, parseSpecSource, type SpecCompileResult } from "./load.js";
import { validateSpecCrossRefs } from "./semantic.js";

/**
 * Spec composition (§79): `imports:` pulls requirements/constraints/outOfScope
 * from other spec files into one composed graph. Rules (ADR-0014):
 * - the entry file's metadata/goal define the composed spec; imports are libraries;
 * - property IDs are NEVER rewritten (traceability) - collisions across files
 *   are rejected (SPC1008);
 * - `dependsOn` may reference imported properties; resolution and cycle checks
 *   run over the composed set;
 * - the digest covers the composed normalized spec, so any change to any file
 *   in the graph changes it (plan staleness works across imports);
 * - import cycles are rejected (SPC1006), missing files rejected (SPC1007).
 *
 * Pure: file contents are injected via `read`. Import paths resolve relative
 * to the importing file.
 */

interface LoadedFile {
  file: string;
  spec: Spec;
  locs: Map<string, SourceLocation>;
}

export function compileSpecGraph(entryFile: string, read: (file: string) => string): SpecCompileResult {
  const diagnostics: Diagnostic[] = [];
  const loaded = new Map<string, LoadedFile>();
  const visiting: string[] = [];
  const norm = (file: string): string => path.normalize(file);

  const loadFile = (file: string): LoadedFile | null => {
    const key = norm(file);
    // Cycle check must precede the cache: a re-encountered file that is
    // still being resolved is a cycle, not a diamond import.
    if (visiting.includes(key)) {
      const cycle = [...visiting.slice(visiting.indexOf(key)), key];
      diagnostics.push(error("SPC1006", `spec import cycle detected: ${cycle.join(" -> ")}.`, undefined, cycle));
      return null;
    }
    const cached = loaded.get(key);
    if (cached) return cached;

    let source: string;
    try {
      source = read(file);
    } catch {
      diagnostics.push(error("SPC1007", `imported spec not found or unreadable: ${file}`));
      return null;
    }

    // Per-file: parse + schema + intra-file semantics. Cross-file references
    // (dependsOn into imported properties) are validated on the merged set.
    const parsed = parseSpecSource(source, file);
    diagnostics.push(...parsed.diagnostics);
    if (!parsed.spec) return null;

    const loadedFile: LoadedFile = { file: key, spec: parsed.spec, locs: parsed.locs };
    loaded.set(key, loadedFile);
    visiting.push(key);
    for (const imp of loadedFile.spec.imports ?? []) {
      loadFile(path.join(path.dirname(key), imp));
    }
    visiting.pop();
    return loadedFile;
  };

  const entry = loadFile(entryFile);
  if (!entry || hasErrors(diagnostics)) {
    return { ok: false, ir: null, diagnostics };
  }

  // Flatten the graph deterministically: entry first, then each import
  // (transitively) in declaration order, duplicates visited once.
  const order: LoadedFile[] = [];
  const seen = new Set<string>();
  const flatten = (f: LoadedFile): void => {
    if (seen.has(f.file)) return;
    seen.add(f.file);
    order.push(f);
    for (const imp of f.spec.imports ?? []) {
      const child = loaded.get(norm(path.join(path.dirname(f.file), imp)));
      if (child) flatten(child);
    }
  };
  flatten(entry);
  const imports = order.slice(1);

  // SPC1008 - property ID collisions across files (IDs are never rewritten).
  const owner = new Map<string, string>();
  for (const f of order) {
    for (const p of [...f.spec.requirements, ...(f.spec.constraints ?? [])]) {
      const prior = owner.get(p.id);
      if (prior) {
        diagnostics.push(
          error("SPC1008", `property id ${p.id} is defined in both ${prior} and ${f.file}; ids are never rewritten on import.`, undefined, [
            prior,
            f.file,
          ]),
        );
      } else {
        owner.set(p.id, f.file);
      }
    }
  }
  if (hasErrors(diagnostics)) {
    return { ok: false, ir: null, diagnostics };
  }

  // Compose: entry identity, merged property lists, deduplicated outOfScope.
  const { imports: _entryImports, ...entryRest } = entry.spec;
  const composed: Spec = {
    ...entryRest,
    requirements: [...entry.spec.requirements, ...imports.flatMap((f) => f.spec.requirements)],
    constraints: [...(entry.spec.constraints ?? []), ...imports.flatMap((f) => f.spec.constraints ?? [])],
    outOfScope: [...new Set([...(entry.spec.outOfScope ?? []), ...imports.flatMap((f) => f.spec.outOfScope ?? [])])],
  };

  // Cross-reference checks over the composed set, with per-file source
  // locations rebased onto the merged array indices.
  const mergedLocs = new Map<string, SourceLocation>();
  let reqOffset = 0;
  let conOffset = 0;
  for (const f of order) {
    for (const [k, v] of f.locs) {
      const reqMatch = k.match(/^requirements\.(\d+)(\..*)?$/);
      if (reqMatch) {
        mergedLocs.set(`requirements.${reqOffset + Number(reqMatch[1])}${reqMatch[2] ?? ""}`, v);
        continue;
      }
      const conMatch = k.match(/^constraints\.(\d+)(\..*)?$/);
      if (conMatch) {
        mergedLocs.set(`constraints.${conOffset + Number(conMatch[1])}${conMatch[2] ?? ""}`, v);
      }
    }
    reqOffset += f.spec.requirements.length;
    conOffset += f.spec.constraints?.length ?? 0;
  }
  diagnostics.push(...validateSpecCrossRefs(composed, mergedLocs));
  if (hasErrors(diagnostics)) {
    return { ok: false, ir: null, diagnostics };
  }

  const ir: SpecIR = finalizeSpec(composed, imports.map((f) => f.file));
  return { ok: true, ir, diagnostics };
}
