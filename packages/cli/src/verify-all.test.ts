import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-verifyall-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function specYaml(id: string): string {
  return [
    "apiVersion: spc.dev/v1alpha1",
    "kind: Spec",
    "metadata:",
    `  id: ${id}`,
    `  title: ${id}`,
    `goal: ${id} holds.`,
    "requirements:",
    "  - id: R-001",
    "    statement: The marker file exists.",
    "    priority: must",
    "    acceptance:",
    "      - id: R-001-A",
    "        type: file",
    `        path: marker-${id}.txt`,
    "        assert:",
    "          exists: true",
    "",
  ].join("\n");
}

function setupRepo(name: string, ids: string[], dropMarker?: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  for (const id of ids) {
    writeFileSync(path.join(repo, "specs", `${id}.yaml`), specYaml(id));
    if (id !== dropMarker) writeFileSync(path.join(repo, `marker-${id}.txt`), "ok\n");
  }
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: repo });
  return repo;
}

function spc(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("bare spc verify with multiple specs", () => {
  it("no file: verifies every spec, reporting each, exit 0 when all pass", () => {
    const repo = setupRepo("all", ["alpha", "beta"]);
    const r = spc(repo, ["verify"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("alpha");
    expect(r.stdout).toContain("beta");
    // Worst-of exit code: 0 only when every spec passes.
  });

  it("worst-of: one unsatisfied spec exits 1 while the others still report", () => {
    const repo = setupRepo("worst", ["good", "bad"], "bad");
    const r = spc(repo, ["verify"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("good");
    expect(r.stdout).toContain("bad");
  });

  it("an explicit file still selects exactly one spec", () => {
    const repo = setupRepo("explicit", ["alpha", "beta"]);
    const r = spc(repo, ["verify", "specs/alpha.yaml"]);
    expect(r.status).toBe(0);
    // Exactly one verification run: single-spec mode runs once and never
    // mentions the other spec.
    expect(r.stdout.match(/Verification run:/g) ?? []).toHaveLength(1);
    expect(r.stdout).not.toContain("beta");
  });
});
