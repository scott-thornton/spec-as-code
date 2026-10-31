import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/verify-cache.yaml (VC-001): the scope-addressed,
// artifact-aware command cache. A fixture git workspace (three
// packages, workspace dep a<-b, unrelated c) drives the decision
// matrix: same tree hit; scope-source change miss; unrelated-package
// change hit; dist deleted miss; dist restored to identical content
// hit; unscoped command never cached; corrupt cache file tolerated.
const unitRoot = mkdtempSync(path.join(tmpdir(), "spc-vcache-unit-"));
afterAll(() => rmSync(unitRoot, { recursive: true, force: true }));

function gitUnit(args: string[]): void {
  const r = spawnSync("git", args, { cwd: unitRoot, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

for (const [pkg, deps] of [
  ["pkg-a", { "@fixture/pkg-b": "workspace:*" }],
  ["pkg-b", {}],
  ["pkg-c", {}],
] as const) {
  mkdirSync(path.join(unitRoot, "packages", pkg, "src"), { recursive: true });
  writeFileSync(path.join(unitRoot, "packages", pkg, "package.json"), JSON.stringify({ name: `@fixture/${pkg}`, version: "1.0.0", dependencies: deps }, null, 2), "utf8");
  writeFileSync(path.join(unitRoot, "packages", pkg, "src", "index.ts"), `export const ${pkg.replace("-", "")} = 1;\n`, "utf8");
}
writeFileSync(path.join(unitRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
gitUnit(["init", "-q", "-b", "main"]);
gitUnit(["config", "user.email", "t@t"]);
gitUnit(["config", "user.name", "t"]);
gitUnit(["add", "."]);
gitUnit(["commit", "-q", "-m", "base"]);

import { CommandCache, parseFilterScope, resolveScopeDirs } from "./command-cache.js";

const cacheFile = path.join(unitRoot, ".spc", "cache", "verify-commands.json");

function freshCache(): CommandCache {
  return new CommandCache(unitRoot, cacheFile);
}

function recordAndPersist(): CommandCache {
  const c = freshCache();
  c.record("pnpm --filter @fixture/pkg-a... test", { executionId: "exec-1", exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
  c.persist();
  return c;
}

describe("scope parsing (VC-001a)", () => {
  it("extracts filter specs and marks everything else unscoped", () => {
    expect(parseFilterScope("pnpm --filter @fixture/pkg-a... test")).toEqual({ packages: ["@fixture/pkg-a"], withDeps: true });
    expect(parseFilterScope("pnpm --filter @fixture/pkg-a test")).toEqual({ packages: ["@fixture/pkg-a"], withDeps: false });
    expect(parseFilterScope("pnpm -r typecheck")).toEqual({ packages: null, withDeps: true });
    expect(parseFilterScope("node counter.mjs")).toBeNull();
    expect(parseFilterScope("! grep -rq old src/")).toBeNull();
  });
});

describe("scope resolution (VC-001b)", () => {
  it("the ... form resolves the transitive workspace dependency closure", () => {
    const dirs = resolveScopeDirs(unitRoot, { packages: ["@fixture/pkg-a"], withDeps: true });
    const names = dirs.map((d) => path.basename(d)).sort();
    expect(names).toEqual(["pkg-a", "pkg-b"]); // a depends on b; c excluded
  });

  it("the bare form resolves just the named package", () => {
    const dirs = resolveScopeDirs(unitRoot, { packages: ["@fixture/pkg-a"], withDeps: false });
    expect(dirs.map((d) => path.basename(d))).toEqual(["pkg-a"]);
  });
});

describe("the reuse decision matrix (VC-001c/d)", () => {
  const CMD = "pnpm --filter @fixture/pkg-a... test";

  it("same tree: hit, with the recorded identity", () => {
    recordAndPersist();
    const hit = freshCache().reusable(CMD);
    expect(hit).not.toBeNull();
    expect(hit!.executionId).toBe("exec-1");
    expect(hit!.exitCode).toBe(0);
  });

  it("source change inside the scope: miss", () => {
    recordAndPersist();
    writeFileSync(path.join(unitRoot, "packages", "pkg-b", "src", "index.ts"), "export const pkgb = 2;\n", "utf8");
    expect(freshCache().reusable(CMD)).toBeNull();
    // restore
    writeFileSync(path.join(unitRoot, "packages", "pkg-b", "src", "index.ts"), "export const pkgb = 1;\n", "utf8");
    expect(freshCache().reusable(CMD)).not.toBeNull(); // identical content restored: hit again
  });

  it("source change in an unrelated package: still a hit", () => {
    recordAndPersist();
    writeFileSync(path.join(unitRoot, "packages", "pkg-c", "src", "index.ts"), "export const pkgc = 99;\n", "utf8");
    expect(freshCache().reusable(CMD)).not.toBeNull();
    writeFileSync(path.join(unitRoot, "packages", "pkg-c", "src", "index.ts"), "export const pkgc = 1;\n", "utf8");
  });

  it("dist recorded, then deleted: miss; restored to identical content: hit", () => {
    // Record WITH dist present.
    mkdirSync(path.join(unitRoot, "packages", "pkg-a", "dist"), { recursive: true });
    writeFileSync(path.join(unitRoot, "packages", "pkg-a", "dist", "index.js"), "built-a\n", "utf8");
    mkdirSync(path.join(unitRoot, "packages", "pkg-b", "dist"), { recursive: true });
    writeFileSync(path.join(unitRoot, "packages", "pkg-b", "dist", "index.js"), "built-b\n", "utf8");
    const c = freshCache();
    c.record(CMD, { executionId: "exec-2", exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    c.persist();
    expect(freshCache().reusable(CMD)?.executionId).toBe("exec-2");

    // Dist deleted: the command's outputs are gone - re-run required.
    rmSync(path.join(unitRoot, "packages", "pkg-a", "dist"), { recursive: true, force: true });
    expect(freshCache().reusable(CMD)).toBeNull();

    // Restored to identical content (deterministic rebuild): hit.
    mkdirSync(path.join(unitRoot, "packages", "pkg-a", "dist"), { recursive: true });
    writeFileSync(path.join(unitRoot, "packages", "pkg-a", "dist", "index.js"), "built-a\n", "utf8");
    expect(freshCache().reusable(CMD)?.executionId).toBe("exec-2");

    // Hand-edited dist (content drift): miss.
    writeFileSync(path.join(unitRoot, "packages", "pkg-a", "dist", "index.js"), "tampered\n", "utf8");
    expect(freshCache().reusable(CMD)).toBeNull();
  });

  it("unscoped commands are never recorded or reused", () => {
    const c = freshCache();
    c.record("node counter.mjs", { executionId: "exec-3", exitCode: 0, stdout: "", stderr: "", timedOut: false });
    c.persist();
    const reloaded = freshCache();
    expect(reloaded.reusable("node counter.mjs")).toBeNull();
    const raw = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    expect(raw["node counter.mjs"]).toBeUndefined();
  });

  it("a corrupt cache file is tolerated as absent", () => {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, "{not json", "utf8");
    const c = freshCache();
    expect(c.reusable(CMD)).toBeNull(); // no throw, no hit
    c.record(CMD, { executionId: "exec-4", exitCode: 0, stdout: "", stderr: "", timedOut: false });
    c.persist();
    expect(freshCache().reusable(CMD)?.executionId).toBe("exec-4"); // recovered by overwrite
  });
});

