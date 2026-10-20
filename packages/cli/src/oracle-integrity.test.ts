import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-oracleintegrity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}`);
}

// Double-quoted command scalar containing a backslash: YAML reinterprets
// escape sequences (the field agent's \/ became /), so the criterion that
// runs is not the criterion the author wrote.
const SPEC = [
  "apiVersion: spc.dev/v1alpha1",
  "kind: Spec",
  "metadata:",
  "  id: quoting",
  "  title: Quoting",
  "goal: fixture",
  "requirements:",
  "  - id: Q-001",
  "    statement: holds",
  "    priority: must",
  "    acceptance:",
  "      - id: Q-001-A",
  "        type: command",
  '        command: "echo a\\/b"',
  "",
].join("\n");

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, "specs", "quoting.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

describe("oracle integrity", () => {
  it("lint warns on backslashes inside double-quoted command scalars", () => {
    const r = sh(["spec", "lint", "specs/quoting.yaml"]);
    expect(r.stdout).toContain("LINT-QUOTED-BACKSLASH");
  });

  it("validate folds the same warning from the spec source", () => {
    const r = sh(["spec", "validate", "specs/quoting.yaml"]);
    expect(r.stdout).toContain("LINT-QUOTED-BACKSLASH");
  });

  it("--show-commands prints the parsed command strings that will run", () => {
    const r = sh(["spec", "validate", "specs/quoting.yaml", "--show-commands"]);
    expect(r.status).toBe(0);
    // The double-quoted \\/ parsed to /: the author SEES the transform
    // instead of shipping a criterion they did not write.
    expect(r.stdout).toContain("echo a/b");
    expect(r.stdout).toContain("Q-001-A");
  });
});
