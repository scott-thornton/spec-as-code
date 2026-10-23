import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LINT_RULES } from "./commands/lint.js";

// Oracle for specs/dependency-blind-lint.yaml: the ratchet entry for the
// run-mvix4mfx stale-artifact incident - potentially dependency-blind
// criterion commands warn, dependency-inclusive ones stay quiet, and the
// registry carries validity-dimension tags and provenance.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-dblint-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);
// A pnpm workspace: the rule's precondition.
writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n", "utf8");

function specWith(command: string, discriminating = true): string {
  return `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: db-fixture
  title: fixture
goal: fixture
requirements:
  - id: DBF-001
    statement: Gate passes.
    priority: must
    acceptance:
      - id: DBF-001-A
        type: command
        command: '${command.replace(/'/g, "''")}'
${discriminating ? "        discriminating: true" : ""}
`;
}

function lint(command: string, discriminating = true): string {
  const file = path.join(root, "specs", "db-fixture.yaml");
  writeFileSync(file, specWith(command, discriminating), "utf8");
  return sh(["lint", file]).stdout;
}

describe("LINT-FILTER-NO-DEPS (dependency-blind-lint)", () => {
  it("warns on a bare name-form filter in a workspace (DB-001)", () => {
    const out = lint("pnpm --filter @spc/planner build > /dev/null && pnpm --filter @spc/planner exec vitest run src/x.test.ts");
    expect(out).toContain("LINT-FILTER-NO-DEPS");
    expect(out).toContain("potentially dependency-blind");
  });

  it("stays quiet for dependency-inclusive selectors (DB-001)", () => {
    const out = lint("pnpm --filter @spc/planner... build > /dev/null && pnpm --filter @spc/planner exec vitest run src/x.test.ts");
    expect(out).not.toContain("LINT-FILTER-NO-DEPS");
  });

  it("stays quiet for path-form selectors (DB-001)", () => {
    const out = lint("pnpm --filter ./packages/planner build > /dev/null");
    expect(out).not.toContain("LINT-FILTER-NO-DEPS");
  });

  it("stays quiet for non-discriminating criteria and filterless commands (DB-001)", () => {
    expect(lint("pnpm --filter @spc/planner build > /dev/null", false)).not.toContain("LINT-FILTER-NO-DEPS");
    expect(lint("node --test src/")).not.toContain("LINT-FILTER-NO-DEPS");
  });

  it("stays quiet outside pnpm workspaces (DB-001)", () => {
    rmSync(path.join(root, "pnpm-lock.yaml"));
    rmSync(path.join(root, "pnpm-workspace.yaml"));
    const out = lint("pnpm --filter @spc/planner build > /dev/null");
    expect(out).not.toContain("LINT-FILTER-NO-DEPS");
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n", "utf8");
  });

  it("the registry entry carries provenance and validity dimensions (DB-002)", () => {
    const entry = LINT_RULES.find((r) => r.id === "LINT-FILTER-NO-DEPS");
    expect(entry).toBeDefined();
    expect(entry!.motivation).toContain("run-mvix4mfx");
    expect(entry!.negativeFixture.length).toBeGreaterThan(10);
    expect(entry!.positiveFixture.length).toBeGreaterThan(10);
    expect(entry!.validityDimensions).toContain("criterion");
    expect(entry!.validityDimensions).toContain("environment");
    expect(entry!.approvedBy.length).toBeGreaterThan(0);
  });

  it("the doctrine is recorded where proposals are authored (DB-003)", () => {
    const skill = readFileSync(
      path.join(path.dirname(CLI), "..", "..", "..", ".agents", "skills", "author-spec", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("not exempt from verification");
  });
});
