import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function sh(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(cwd: string, args: string[]): string {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
}

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: dirty
  title: Dirty isolation
goal: fixture
requirements:
  - id: DI-001
    statement: The marker exists.
    priority: must
    acceptance:
      - id: DI-001-A
        type: command
        command: node -e "require('fs').writeFileSync('marker.txt','x')"
`;

function setup(allowDirtyPaths?: string[]): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-dirty-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "dirty.yaml"), SPEC, "utf8");
  writeFileSync(path.join(repo, ".spc", "config.yaml"), [
    "version: 1",
    "provider:",
    "  name: fake",
    "  script: .spc/fake.yaml",
    "execution:",
    "  inPlace: true",
    "  inPlaceBranch: current",
    ...(allowDirtyPaths ? [`  allowDirtyPaths: [${allowDirtyPaths.map((p) => `"${p}"`).join(", ")}]`] : []),
    "",
  ].join("\n"), "utf8");
  writeFileSync(path.join(repo, ".spc", "fake.yaml"), [
    "planner:",
    "  value:",
    "    plan:",
    "      tasks:",
    "        - id: T001",
    "          title: Work",
    "          kind: modify",
    "          intent: write",
    "          dependsOn: []",
    "          satisfies: [DI-001]",
    "          targets:",
    "            write: [marker.txt]",
    "executor:",
    "  T001:",
    "    status: completed",
    "    summary: w",
    "    changes: []",
    "",
  ].join("\n"), "utf8");
  writeFileSync(path.join(repo, ".env"), "VITE_KEY=dev\n", "utf8");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function digestOfSpec(repo: string): string {
  const out = spawnSync(process.execPath, [CLI, "spec", "validate", "specs/dirty.yaml"], { cwd: repo, encoding: "utf8" });
  return (out.stdout ?? "").match(/Digest: (sha256:\S+)/)?.[1] ?? "sha256:" + "0".repeat(64);
}

function planFor(repo: string): void {
  mkdirSync(path.join(repo, ".spc", "plans"), { recursive: true });
  writeFileSync(path.join(repo, ".spc", "plans", "plan-dirty.json"), JSON.stringify({
    apiVersion: "spc.dev/v1alpha1", kind: "Plan",
    metadata: { id: "plan-dirty", createdAt: "2026-10-21T00:00:00.000Z" },
    spec: { id: "dirty", digest: digestOfSpec(repo) },
    repository: { revision: "0000", snapshotDigest: "sha256:" + "0".repeat(64) },
    tasks: [{ id: "T001", title: "Work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["DI-001"], targets: { write: ["marker.txt"] } }],
  }), "utf8");
}

describe("allowDirtyPaths: the strengthened contract", () => {
  it("dirt on an allowlisted path permits the run; the dirt is preserved and NEVER committed", () => {
    const repo = setup([".env"]);
    // Make .env dirty (tracked, locally modified).
    writeFileSync(path.join(repo, ".env"), "VITE_KEY=changed\n", "utf8");
    planFor(repo);
    const r = sh(repo, ["apply"]);
    expect(r.stderr).toContain("succeeded");
    // Preserved exactly as it was.
    expect(readFileSync(path.join(repo, ".env"), "utf8")).toBe("VITE_KEY=changed\n");
    // Never committed: the run's commits do not touch .env.
    // Only the run's commits (after the init baseline) must not touch .env.
    const init = git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    const touched = git(repo, ["log", "--name-only", "--pretty=format:", `${init}..HEAD`, "--", ".env"]);
    expect(touched).toBe("");
  });

  it("dirt on a NON-allowlisted path still rejects at preflight", () => {
    const repo = setup([".env"]);
    writeFileSync(path.join(repo, "src.ts"), "dirty\n", "utf8");
    planFor(repo);
    const r = sh(repo, ["apply"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/dirty|clean/i);
  });

  it("a dirty allowlisted path overlapping a task's write scope HARD-REJECTS at preflight", () => {
    const repo = setup(["marker.txt"]);
    writeFileSync(path.join(repo, "marker.txt"), "pre-existing dirt\n", "utf8");
    planFor(repo);
    const r = sh(repo, ["apply"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DIRTY_PATH_SCOPE|overlap/i);
  });

  it("an allowlisted path that is CLEAN does not interfere", () => {
    const repo = setup([".env"]);
    planFor(repo);
    const r = sh(repo, ["apply"]);
    expect(r.stderr).toContain("succeeded");
  });

  it("verification contamination: criteria passing only because of excluded dirt stay unsatisfied", () => {
    // A criterion that reads .env's LOCAL value would pass in the worktree
    // but the committed tree lacks it; the run must not claim it.
    const repo = setup([".env"]);
    writeFileSync(path.join(repo, ".env"), "VITE_KEY=contaminating\n", "utf8");
    // The spec's criterion writes marker.txt - passing regardless; use a
    // second property that greps .env for the dirty value.
    const contaminated = SPEC.replace(
      "        command: node -e \"require('fs').writeFileSync('marker.txt','x')\"",
      "        command: node -e \"require('fs').writeFileSync('marker.txt','x')\"\n  - id: DI-002\n    statement: The env marker is committed.\n    priority: must\n    acceptance:\n      - id: DI-002-A\n        type: command\n        command: grep -q contaminating .env",
    );
    writeFileSync(path.join(repo, "specs", "dirty.yaml"), contaminated, "utf8");
    // The fake plan must cover both properties.
    const fake = readFileSync(path.join(repo, ".spc", "fake.yaml"), "utf8").replace(
      "satisfies: [DI-001]",
      "satisfies: [DI-001, DI-002]",
    );
    writeFileSync(path.join(repo, ".spc", "fake.yaml"), fake, "utf8");
    // Stage ONLY the spec - `git add .` would sweep the dirty .env into
    // this commit, and the contamination scenario requires it UNCOMMITTED.
    git(repo, ["add", "specs/dirty.yaml"]);
    git(repo, ["commit", "-q", "-m", "contaminated spec"]);
    planFor(repo);
    // The hand-written plan must cover the new property too.
    const planFile = path.join(repo, ".spc", "plans", "plan-dirty.json");
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    plan.tasks[0].satisfies = ["DI-001", "DI-002"];
    writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf8");
    const r = sh(repo, ["apply"]);
    // The grep passes in the live tree (dirt present) but the committed
    // tree does not contain it - the strengthened contract requires the
    // conclusion NOT be drawn from excluded dirt.
    expect(r.stderr).not.toContain("DI-002.*satisfied");
    expect(r.stderr + r.stdout).toMatch(/partially|unsatisfied|contaminat|indeterminate/);
  });
});
