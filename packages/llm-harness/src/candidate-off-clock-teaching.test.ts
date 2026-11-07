import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Oracle for specs/candidate-off-clock-teaching.yaml OCT-001 (red,
// committed pre-run): the executor stage header teaches the
// off-the-clock pattern up front. The headers are constant per-role
// text, so the source-check precedent applies (AO-007, GD-002:
// constant-text contracts are assertable at source; no export
// ceremony forced on the module).
const source = readFileSync(path.resolve(import.meta.dirname, "../src/harness.ts"), "utf8");

/** The executor stage header's string literal from the source. */
function executorHeader(): string {
  const m = /executor:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  return m?.[1] ?? "";
}

describe("OCT-001: off-the-clock taught where the pressure is", () => {
  it("the executor stage header carries the off-the-clock phrase, the command, and the window framing", () => {
    const header = executorHeader();
    expect(header.length).toBeGreaterThan(0);
    // The candidate-guidance vocabulary, now on the request surface.
    expect(header).toMatch(/off the clock/i);
    // The mechanism, by name.
    expect(header).toMatch(/spc agent save-candidate/);
    // The reframe: composing never races the window.
    expect(header).toMatch(/window measures answering, not composing/i);
    // Never a rushed submit - the discipline line, retained.
    expect(header).toMatch(/never a rushed submit/);
  });

  it("constant text discipline: the header carries no braces; the generic header stays untouched", () => {
    const header = executorHeader();
    expect(header).not.toMatch(/\{|\}/);
    const generic = /GENERIC_STAGE_HEADER =\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1] ?? "";
    expect(generic).not.toMatch(/save-candidate/);
  });
});
