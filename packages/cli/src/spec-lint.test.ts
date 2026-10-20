import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-lint-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// A spec with one deliberately broken thing per rule.
const BAD_SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: lint-fixture
  title: Lint fixture
goal: every rule fires
requirements:
  - id: LF-001
    statement: Decorated property.
    priority: must
    acceptance:
      - id: LF-001-A
        type: command
        command: "true"
  - id: LF-002
    statement: Bare identifier grep.
    priority: must
    acceptance:
      - id: LF-002-A
        type: file
        path: src/app.ts
        assert:
          contains: "faviconUrl"
  - id: LF-003
    statement: Unprotected oracle.
    priority: must
    acceptance:
      - id: LF-003-A
        type: command
        command: npx vitest run tests/unit/app.spec.ts
        discriminating: true
  - id: LF-004
    statement: Duplicate commands with differing expectations.
    priority: must
    acceptance:
      - id: LF-004-A
        type: command
        command: node src/app.ts
        expect:
          exitCode: 0
      - id: LF-004-B
        type: command
        command: node src/app.ts
        expect:
          exitCode: 1
`;

const CONFIG = `version: 1
provider:
  name: none
execution:
  commandTimeoutMs: 3000
commands:
  network: deny
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, "specs", "lint-fixture.yaml"), BAD_SPEC, "utf8");
writeFileSync(path.join(root, ".spc", "config.yaml"), CONFIG, "utf8");
writeFileSync(path.join(root, "src", "app.ts"), "console.log(1);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

describe("spc spec lint", () => {
  it("fires every static rule with a stable identifier", () => {
    const r = sh(["spec", "lint", "specs/lint-fixture.yaml"]);
    expect(r.status).toBe(0); // warnings never gate
    expect(r.stdout).toContain("LINT-DECORATION");
    expect(r.stdout).toContain("LINT-BARE-IDENTIFIER");
    expect(r.stdout).toContain("LINT-UNPROTECTED-ORACLE");
    expect(r.stdout).toContain("LINT-DUPLICATE-COMMAND");
    expect(r.stdout).toContain("LINT-EMPTY-OUT-OF-SCOPE");
  });

  it("flags a discriminating criterion that passes at baseline with the precise diagnostic", () => {
    // LF-003's command fails at baseline (no vitest/test file) - not the pass case.
    // Add one that passes: a discriminating criterion over an existing behavior.
    const spec = BAD_SPEC.replace(`  - id: LF-004`, `  - id: LF-005
    statement: Passes at baseline while a sibling fails.
    priority: must
    acceptance:
      - id: LF-005-A
        type: command
        command: node -e "console.log('ok')"
        discriminating: true
      - id: LF-005-B
        type: command
        command: node -e "process.exit(1)"
        discriminating: true
  - id: LF-004`);
    writeFileSync(path.join(root, "specs", "lint-fixture.yaml"), spec, "utf8");
    const r = sh(["spec", "lint", "specs/lint-fixture.yaml"]);
    expect(r.stdout).toContain("LINT-NO-RED-CAPABILITY");
    expect(r.stdout).toMatch(/criterion passes at baseline/i);
    expect(r.stdout).toMatch(/while 1 still fails/i);
  });

  it("reports not-safely-executable distinctly from pass and fail", () => {
    const spec = readFileSync(path.join(root, "specs", "lint-fixture.yaml"), "utf8").replace(
      `  - id: LF-004`,
      `  - id: LF-006
    statement: Policy-denied check.
    priority: must
    acceptance:
      - id: LF-006-A
        type: command
        command: curl https://example.com
        discriminating: true
  - id: LF-004`,
    );
    writeFileSync(path.join(root, "specs", "lint-fixture.yaml"), spec, "utf8");
    const r = sh(["spec", "lint", "specs/lint-fixture.yaml"]);
    expect(r.stdout).toContain("not-safely-executable");
    expect(r.stdout).toContain("LF-006-A");
  });

  it("never mutates the working tree: lint executes only in a disposable worktree", () => {
    const before = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
    sh(["spec", "lint", "specs/lint-fixture.yaml"]);
    const after = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
    expect(after).toBe(before);
  }, 20000);

  it("spec validate folds static warnings but executes nothing (LF-005 passes silently there)", () => {
    const before = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const r = sh(["spec", "validate", "specs/lint-fixture.yaml"]);
    expect(r.stdout).toContain("LINT-DECORATION");
    expect(r.stdout).not.toContain("LINT-NO-RED-CAPABILITY");
    const after = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
    expect(after).toBe(before);
  }, 20000);
});
