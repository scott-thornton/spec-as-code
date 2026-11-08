import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Oracle for specs/challenge-corpus.yaml (red, committed pre-run):
// the corpus replays three archived defects through the REAL CLI -
// each challenge runs two admitted cold worktree pipelines and must
// come back DISCRIMINATING with its signature attributed. Today the
// fixtures do not exist (exit 2, unknown fixture) - this is red.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const REPO = path.resolve(import.meta.dirname, "../../..");

function challenge(fixture: string): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, "challenge", `challenges/${fixture}.yaml`], {
    cwd: REPO, encoding: "utf8", timeout: 590_000,
  });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("CORPUS: archived defects replay discriminating", () => {
  it("excerpt-crowding (1c946f7 -> ec13550): glob-first budgeting crowds out the explicit oracle file", () => {
    const r = challenge("excerpt-crowding-glob-first");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/discriminating/i);
    expect(r.stdout).toContain("src/oracle.test.ts");
  }, 600_000);

  it("executor prompt update-op gap (1c946f7 -> 6a11435): the untaught op is named in the attribution", () => {
    const r = challenge("executor-prompt-update-op");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/discriminating/i);
    expect(r.stdout).toContain('op:\\s*"update"');
  }, 600_000);

  it("timer race leak (62954d0 -> 54876bb): the lingering child's lifetime is named in the attribution", () => {
    const r = challenge("timer-race-uncleared");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/discriminating/i);
    expect(r.stdout).toContain("to be less than 4000");
  }, 600_000);
});
