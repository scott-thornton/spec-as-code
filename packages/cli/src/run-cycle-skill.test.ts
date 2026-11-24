import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Oracle for specs/run-cycle-skill-accuracy.yaml (RCS-007): the run-cycle
// skill text as agents load it. A command criterion on the shape this
// repository's criteria use - pnpm --filter <pkg> build && pnpm
// --filter <pkg> exec vitest run <file> - so that an apply run
// establishes its flip through the oracle-identity gate on that shape.
// At base the skill states the falsehoods this file checks for. Whole
// file; no title filter.
const skill = readFileSync(path.resolve(import.meta.dirname, "../../../.agents/skills/run-cycle/SKILL.md"), "utf8");

describe("the run-cycle skill as agents load it", () => {
  it("documents the four executor fields the schema requires even when empty", () => {
    expect(skill).toContain('"commands": [], "observations": [], "evidenceCandidates": [], "followups": []');
  });

  it("tells the truth about spc run cancel and the way out", () => {
    expect(skill).not.toContain("The only sanctioned exit is");
    expect(skill).toContain("CANCEL_INCOMPLETE");
    expect(skill).toContain("spc apply recover");
  });

  it("gives one writer per path instead of ordering overlapping writers", () => {
    expect(skill).not.toContain("overlapping writers need");
    expect(skill).toContain("one writer per path");
  });

  it("diagnoses a failure from the tail of the captured output", () => {
    expect(skill).not.toContain("[:200]");
    expect(skill).toContain("[-2500:]");
    expect(skill).toContain("64 KiB");
  });

  it("rehearses an answer before responding, with the build gate only", () => {
    expect(skill).toContain("spc agent dry-run");
    expect(skill).toContain("--gates build");
    expect(skill).not.toContain("is a legitimate escape");
  });

  it("shows how to verify one or N specs and warns that an empty selection is green", () => {
    expect(skill).toContain("spc verify <id> <id>");
    expect(skill).toContain("exits 0 when");
  });
});
