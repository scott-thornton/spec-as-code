import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Oracle for specs/run-cycle-skill-accuracy.yaml (RCS-007): the run-cycle
// skill text as agents load it. A command criterion on the shape this
// repository's criteria use - pnpm --filter <pkg> build && pnpm
// --filter <pkg> exec vitest run <file> - so that an apply run
// establishes its flip through the oracle-identity gate on that shape.
// Amended once: a read-only adversarial pass against the code found
// that the first correction had introduced new errors (what the
// rehearsal can vouch for, which runs read indeterminate, the text the
// CLI actually prints). Whole file; no title filter.
const skill = readFileSync(path.resolve(import.meta.dirname, "../../../.agents/skills/run-cycle/SKILL.md"), "utf8");

describe("the run-cycle skill as agents load it", () => {
  it("documents the four executor fields the request's schema requires even when empty", () => {
    expect(skill).toContain('"commands": [], "observations": [], "evidenceCandidates": [], "followups": []');
  });

  it("tells the truth about spc run cancel and the way out", () => {
    expect(skill).not.toContain("The only sanctioned exit is");
    expect(skill).toContain("cancellation INCOMPLETE");
    expect(skill).toContain("marked cancelled at once");
    expect(skill).not.toContain("--confirm");
    expect(skill).toContain("spc apply recover");
    expect(skill).toContain("once no spc process is writing");
  });

  it("gives one writer per path instead of ordering overlapping writers", () => {
    expect(skill).not.toContain("overlapping writers need");
    expect(skill).toContain("one writer per path");
    expect(skill).toContain("even if it never touches that path");
    expect(skill).toContain("declared write targets overlap a path an earlier task changed");
    expect(skill).not.toContain("later task that touches an earlier");
  });

  it("diagnoses a failure from the tail of the captured output, skipping the red phase", () => {
    expect(skill).not.toContain("[:200]");
    expect(skill).toContain("[-2500:]");
    expect(skill).toContain("64 KiB");
    expect(skill).toContain("e.get('phase')=='red'");
  });

  it("describes the rehearsal for what it can vouch for, and omits --gates", () => {
    expect(skill).toContain("spc agent dry-run");
    expect(skill).toContain("Omit `--gates`");
    expect(skill).not.toContain("--gates build");
    expect(skill).not.toContain("means the answer is wrong");
    expect(skill).toContain("nothing in flight");
    expect(skill).toContain("earlier or later");
    expect(skill).toContain("does not convict the answer");
    expect(skill).toContain("A refused staging is a wrong");
    expect(skill).toContain("this task's own earlier applied work");
    expect(skill).toContain("re-plan so one task owns the path");
    expect(skill).toContain("spc patch verify");
    expect(skill).not.toContain("is a legitimate escape");
  });

  it("states the one shape spc agent respond refuses", () => {
    expect(skill).toContain("PREFLIGHT_ADVISABLE");
    expect(skill).toContain("exactly one shape on rehearsal grounds");
    expect(skill).toContain("--no-preflight");
  });

  it("scopes the indeterminate note to a run that changes the gate itself", () => {
    expect(skill).toContain("oracle-identity gate cannot validate its own repair");
    expect(skill).not.toContain("Expect every property of a run");
  });

  it("shows how to verify one or N specs and warns that an empty selection is green", () => {
    expect(skill).toContain("spc verify <id> <id>");
    expect(skill).toContain("exits 0 when");
  });

  it("separates never claiming a requirement from never padding an answer", () => {
    expect(skill).not.toContain("Answer with anything beyond the minimal valid value");
    expect(skill).toContain("evidence decides, not you");
    expect(skill).toContain("still includes the four empty arrays");
  });
});
