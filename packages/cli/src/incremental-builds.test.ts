import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Oracle for specs/incremental-builds.yaml: the shared base config turns
// on tsc incremental, warm no-change rebuilds do not re-emit, and the
// incremental state never escapes .gitignore.
const repoRoot = new URL("../../..", import.meta.url).pathname;

function run(cmd: string, args: string[], cwd = repoRoot): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

function findBuildinfo(pkg: string): string[] {
  const dir = path.join(repoRoot, "packages", pkg);
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsbuildinfo")) out.push(p);
    }
  };
  for (const top of [path.join(dir, "dist"), dir]) {
    if (!existsSync(top)) continue;
    try {
      walk(top);
    } catch {
      // not a directory or unreadable
    }
    if (out.length > 0) break;
  }
  return out;
}

describe("incremental builds (incremental-builds)", () => {
  it("the shared base tsconfig declares incremental (IB-001)", () => {
    const base = run("cat", [path.join(repoRoot, "tsconfig.base.json")]).stdout;
    expect(base).toMatch(/"incremental"\s*:\s*true/);
  });

  it("a warm no-change rebuild does not re-emit (IB-001)", () => {
    // First (possibly cold) build of the core closure.
    expect(run("pnpm", ["--filter", "@spc/core...", "build"]).status).toBe(0);
    const buildinfo = findBuildinfo("core");
    expect(buildinfo.length).toBeGreaterThan(0);

    const artifact = path.join(repoRoot, "packages", "core", "dist", "index.js");
    expect(existsSync(artifact)).toBe(true);
    const before = statSync(artifact).mtimeMs;
    // Cross mtime granularity: a re-emit within the same tick would be
    // invisible without the sleep.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    expect(run("pnpm", ["--filter", "@spc/core...", "build"]).status).toBe(0);
    const after = statSync(artifact).mtimeMs;
    expect(after).toBe(before);
  }, 30_000);

  it("incremental state never escapes .gitignore (IB-002)", () => {
    const buildinfo = findBuildinfo("core");
    expect(buildinfo.length).toBeGreaterThan(0);
    for (const file of buildinfo) {
      const r = run("git", ["check-ignore", "-q", path.relative(repoRoot, file)]);
      expect(r.status).toBe(0);
    }
  });
});
