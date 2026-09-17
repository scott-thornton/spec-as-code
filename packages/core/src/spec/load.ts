import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { Document, Node } from "yaml";
import { specSchema, type Spec, type SpecIR } from "@spc/schema";
import { error, hasErrors, type Diagnostic, type SourceLocation } from "../diagnostics.js";
import { digestOf } from "../hash.js";
import { normalizeSpec } from "./normalize.js";
import { validateSpecSemantics } from "./semantic.js";

export interface SpecCompileResult {
  ok: boolean;
  ir: SpecIR | null;
  diagnostics: Diagnostic[];
}

interface LineIndex {
  lineStarts: number[];
  totalLength: number;
}

function buildLineIndex(source: string): LineIndex {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  return { lineStarts, totalLength: source.length };
}

function offsetToLoc(index: LineIndex, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, index.totalLength));
  let lo = 0;
  let hi = index.lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((index.lineStarts[mid] ?? 0) <= clamped) lo = mid;
    else hi = mid - 1;
  }
  const start = index.lineStarts[lo] ?? 0;
  return { line: lo + 1, column: clamped - start + 1 };
}

interface WalkCtx {
  doc: Document;
  index: LineIndex;
  file: string;
  locs: Map<string, SourceLocation>;
  diagnostics: Diagnostic[];
  aliases: Set<Node>;
}

function recordLoc(ctx: WalkCtx, path: string, node: Node): void {
  const range = (node as { range?: readonly number[] }).range;
  if (range && range[0] !== undefined && !ctx.locs.has(path)) {
    const { line, column } = offsetToLoc(ctx.index, range[0]);
    ctx.locs.set(path, { file: ctx.file, line, column });
  }
}

function walkNode(node: Node | null, path: string, ctx: WalkCtx): unknown {
  if (node === null) return null;
  recordLoc(ctx, path, node);
  if (isAlias(node)) {
    if (ctx.aliases.has(node)) {
      ctx.diagnostics.push(
        error("SPC0001", `cyclic YAML alias at ${path}.`, ctx.locs.get(path)),
      );
      return null;
    }
    ctx.aliases.add(node);
    try {
      const target = node.resolve(ctx.doc) as Node | undefined;
      return walkNode(target ?? null, path, ctx);
    } finally {
      ctx.aliases.delete(node);
    }
  }
  if (isScalar(node)) return node.value;
  if (isSeq(node)) {
    return node.items.map(
      (item, i) => walkNode(item as Node | null, `${path === "" ? "" : path + "."}${i}`, ctx),
    );
  }
  if (isMap(node)) {
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const pair of node.items) {
      const keyNode = pair.key as Node;
      if (!isScalar(keyNode) || keyNode.value === null || typeof keyNode.value === "object") {
        ctx.diagnostics.push(
          error("SPC0001", `complex mapping keys are not supported (at ${path || "<root>"}).`, ctx.locs.get(path)),
        );
        continue;
      }
      const key = String(keyNode.value);
      const keyPath = `${path === "" ? "" : path + "."}${key}`;
      recordLoc(ctx, keyPath, keyNode);
      if (seen.has(key)) {
        ctx.diagnostics.push(
          error("SPC0001", `duplicate key "${key}" in mapping.`, ctx.locs.get(keyPath)),
        );
        continue;
      }
      seen.add(key);
      obj[key] = walkNode(pair.value as Node | null, keyPath, ctx);
    }
    return obj;
  }
  ctx.diagnostics.push(error("SPC0001", `unsupported YAML node at ${path || "<root>"}.`, ctx.locs.get(path)));
  return null;
}

function zodIssuePath(path: readonly (string | number)[]): string {
  return path.map(String).join(".");
}

function schemaDiagnostics(
  issues: { code: string; message: string; path: readonly (string | number)[]; keys?: unknown[] }[],
  locs: ReadonlyMap<string, SourceLocation>,
): Diagnostic[] {
  return issues.map((issue) => {
    const path = zodIssuePath(issue.path);
    const loc = locs.get(path);
    if (issue.code === "unrecognized_keys") {
      const keys = (issue.keys ?? []).map(String);
      return error(
        "SPC0003",
        `unknown field${keys.length === 1 ? "" : "s"} ${keys.map((k) => `"${k}"`).join(", ")} at ${path || "<root>"}.`,
        loc,
      );
    }
    return error("SPC0002", `${path ? path + ": " : ""}${issue.message}`, loc);
  });
}

/**
 * Spec compiler: YAML -> parse -> schema validation -> semantic validation
 * -> normalization -> immutable SpecIR + digest.
 */
export function compileSpecSource(source: string, file: string): SpecCompileResult {
  const diagnostics: Diagnostic[] = [];
  const index = buildLineIndex(source);

  let documents;
  try {
    documents = parseAllDocuments(source);
  } catch (e) {
    return { ok: false, ir: null, diagnostics: [error("SPC0001", `YAML parse error: ${(e as Error).message}`)] };
  }
  if (documents.length !== 1) {
    return {
      ok: false,
      ir: null,
      diagnostics: [error("SPC0001", `expected exactly one YAML document in ${file}, found ${documents.length}.`)],
    };
  }
  const doc = documents[0]!;
  for (const err of doc.errors) {
    const pos = (err as { pos?: number[] }).pos;
    const loc =
      pos && pos[0] !== undefined
        ? (() => {
            const { line, column } = offsetToLoc(index, pos[0]);
            return { file, line, column };
          })()
        : undefined;
    diagnostics.push(error("SPC0001", `YAML parse error: ${err.message}`, loc));
  }
  if (doc.errors.length > 0) {
    return { ok: false, ir: null, diagnostics };
  }

  const ctx: WalkCtx = { doc, index, file, locs: new Map(), diagnostics: [], aliases: new Set() };
  const data = walkNode(doc.contents ?? null, "", ctx);
  diagnostics.push(...ctx.diagnostics);
  if (diagnostics.some((d) => d.code === "SPC0001")) {
    return { ok: false, ir: null, diagnostics };
  }

  const parsed = specSchema.safeParse(data);
  if (!parsed.success) {
    diagnostics.push(...schemaDiagnostics(parsed.error.issues as never, ctx.locs));
    return { ok: false, ir: null, diagnostics };
  }
  const spec: Spec = parsed.data;

  diagnostics.push(...validateSpecSemantics(spec, ctx.locs));
  if (hasErrors(diagnostics)) {
    return { ok: false, ir: null, diagnostics };
  }

  const normalized = normalizeSpec(spec);
  const digest = digestOf(normalized);
  return {
    ok: true,
    ir: {
      spec: normalized,
      properties: [...normalized.requirements, ...normalized.constraints],
      digest,
    },
    diagnostics,
  };
}
