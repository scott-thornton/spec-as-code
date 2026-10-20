import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function sh(cwd: string, args: string[], timeout = 60000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(cwd: string, args: string[]): string {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
}

function repo(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `spc-${name}-`));
  roots.push(root);
  mkdirSync(path.join(root, "specs"), { recursive: true });
  mkdirSync(path.join(root, ".spc"), { recursive: true });
  writeFileSync(path.join(root, ".spc", "config.yaml"), [
    "version: 1",
    "provider:",
    "  name: fake",
    "  script: .spc/fake.yaml",
    "execution:",
    "  inPlace: true",
    "",
  ].join("\n"), "utf8");
  writeFileSync(path.join(root, ".spc", "fake.yaml"), [
    "executor:",
    "  T001:",
    "    status: completed",
    "    summary: done",
    "    changes:",
    "      - op: create",
    "        path: out.txt",
    '        content: "ok"',
    "",
  ].join("\n"), "utf8");
  writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

describe("run ergonomics", () => {
  it("quick --write skips the planner request entirely", () => {
    const root = repo("qwrite");
    const r = sh(root, ["quick", "write the marker file", "--verify", "test -f out.txt", "--write", "out.txt"]);
    expect(r.stderr).toContain("succeeded");
    // No planner section in the fake script: had a planner call been made,
    // the fake provider would have failed the run.
    expect(readFileSync(path.join(root, "out.txt"), "utf8")).toBe("ok");
  });

  it("apply --stay leaves the checkout on the run branch", () => {
    const root = repo("stay");
    // An apply needs a plan; quick IS apply machinery and honors --stay.
    const r = sh(root, ["quick", "marker", "--verify", "test -f out.txt", "--write", "out.txt", "--stay"]);
    expect(r.stderr).toContain("succeeded");
    const branch = git(root, ["branch", "--show-current"]);
    expect(branch).toMatch(/^spc\//);
  });

  it("without --stay the checkout returns to the original branch", () => {
    const root = repo("nostay");
    const r = sh(root, ["quick", "marker", "--verify", "test -f out.txt", "--write", "out.txt"]);
    expect(r.stderr).toContain("succeeded");
    expect(git(root, ["branch", "--show-current"])).toBe("main");
  });
});
