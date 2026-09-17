import { readFileSync } from "node:fs";
import { compileSpecGraph } from "@spc/core";
import type { SpecCompileResult } from "@spc/core";

/**
 * Filesystem loader for the spec compiler: follows `imports:` relative to
 * each file, composing the graph. A single-file spec is a graph of one node,
 * so this is the one entry point callers need.
 */
export function compileSpecFile(file: string): SpecCompileResult {
  return compileSpecGraph(file, (f) => readFileSync(f, "utf8"));
}
