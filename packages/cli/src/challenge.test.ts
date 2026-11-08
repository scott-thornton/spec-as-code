import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/criterion-challenge.yaml CHAL-001-B (red,
// committed pre-run): the CLI surface - spc challenge <fixture>
// exists, reports the four-outcome contract, and refuses unknown
// fixtures by name. Today the command does not exist.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-chal-cli-"));
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("CHAL-001-B: spc challenge (CLI surface)", () => {
  it("an unknown fixture refuses by name (non-zero, named error)", { timeout: 30_000 }, () => {
    const r = sh(["challenge", "no-such-fixture"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/challenge/i);
    expect(r.stdout).toMatch(/no-such-fixture|not found|unknown/i);
  });

  it("the command's help names the contract (fixture, outcomes, no confidence metric)", { timeout: 30_000 }, () => {
    const r = sh(["challenge", "--help"]);
    expect(r.stdout).toMatch(/discriminating/i);
    expect(r.stdout).toMatch(/non-discriminating|invalid-baseline|inconclusive/i);
  });
});
