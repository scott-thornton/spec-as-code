import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { listMatchingFiles } from "@spc/repo";
import { buildDispatchExcerpts } from "./execute.js";

// Oracle for specs/excerpt-priority.yaml (EXB-001, EXB-002, EXB-C01 -
// red, committed pre-run): explicit path declarations claim the
// dispatch excerpt budget; glob matches fill the remaining slots. The
// parent defect (har, 2026-11-08): a task declaring src/** plus an
// explicit oracle file lost the oracle to eight sorted glob matches -
// reproduced against the real listMatchingFiles. Today no priority
// construction exists and every leg below fails.
const root = mkdtempSync(path.join(tmpdir(), "spc-exp-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

/** A worktree with 10 glob matches, an explicit oracle file, and an explicit write target. */
function fixture(): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  for (let i = 1; i <= 10; i++) writeFileSync(path.join(root, "src", `f${String(i).padStart(2, "0")}.ts`), `match ${i}\n`, "utf8");
  writeFileSync(path.join(root, "src", "oracle.test.ts"), "the important one\n", "utf8");
  writeFileSync(path.join(root, "src", "target.ts"), "the edit target\n", "utf8");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: root });
}
fixture();

describe("EXB-001: explicit declarations claim the excerpt budget", () => {
  it("a task declaring src/** plus an explicit oracle file: the oracle is in the excerpt regardless of glob match count", () => {
    const files = buildDispatchExcerpts(root, ["src/**", "src/oracle.test.ts"], 8);
    expect(files).toContain("src/oracle.test.ts");
    expect(files.length).toBe(8);
  });

  it("no explicit declarations: byte-identical to today's sorted glob list (prompt stability for existing plans)", () => {
    const files = buildDispatchExcerpts(root, ["src/**"], 8);
    expect(files).toEqual(listMatchingFiles(root, ["src/**"], 8));
  });

  it("the final list is sorted and deduplicated (an explicit path also matching the glob appears once)", () => {
    const files = buildDispatchExcerpts(root, ["src/**", "src/oracle.test.ts", "src/oracle.test.ts"], 8);
    const oracleOccurrences = files.filter((f) => f === "src/oracle.test.ts").length;
    expect(oracleOccurrences).toBe(1);
    expect([...files].sort()).toEqual(files);
  });
});

describe("EXB-002: an explicit write target is never crowded out", () => {
  it("an explicit write target survives a matching-rich read glob (the file the task exists to edit is in the excerpt)", () => {
    // readPatterns unions read+write at the call site; the explicit
    // write path arrives in the same array.
    const files = buildDispatchExcerpts(root, ["src/**", "src/target.ts"], 8);
    expect(files).toContain("src/target.ts");
  });

  it("an explicit path for a nonexistent file is ignored, not fatal - globs fill the budget", () => {
    const files = buildDispatchExcerpts(root, ["src/**", "src/does-not-exist.ts"], 8);
    expect(files).not.toContain("src/does-not-exist.ts");
    expect(files.length).toBe(8);
  });
});

describe("EXB-C01: determinism (the prompt-stability contract)", () => {
  it("the same tree and plan produce the identical list on every invocation", () => {
    const a = buildDispatchExcerpts(root, ["src/**", "src/oracle.test.ts"], 8);
    const b = buildDispatchExcerpts(root, ["src/**", "src/oracle.test.ts"], 8);
    expect(a).toEqual(b);
  });
});
