import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CommandCache } from "@spc/verifier";

// Oracle for specs/verify-cache.yaml (VC-002): the CLI integration - a
// seeded valid cache entry verifies satisfied via COMMAND_RESULT_REUSED
// with cache-named provenance and NO physical execution (the scoped
// command, if executed, fails on the uninstalled fixture - success
// itself proves the hit); without a cache, honest execution and honest
// failure.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const repo = mkdtempSync(path.join(tmpdir(), "spc-vcache-cli-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (exit ${r.status}): ${r.stdout} ${r.stderr}`);
}

mkdirSync(path.join(repo, "packages", "pkg-a", "src"), { recursive: true });
writeFileSync(path.join(repo, "packages", "pkg-a", "package.json"), JSON.stringify({ name: "@fixture/pkg-a", version: "1.0.0", dependencies: {}, scripts: { test: "exit 3" } }), "utf8");
writeFileSync(path.join(repo, "packages", "pkg-a", "src", "index.ts"), "export const paga = 1;\n", "utf8");
mkdirSync(path.join(repo, "specs"), { recursive: true });
writeFileSync(path.join(repo, "specs", "vc.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: vc\n  title: VC\ngoal: fixture\nrequirements:\n  - id: VC-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: VC-001-A\n        type: command\n        command: pnpm --filter @fixture/pkg-a... test\n', "utf8");
writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

describe("verify-cache (CLI integration, VC-002)", () => {
  it("cold: no cache means honest execution and honest failure; seeded: satisfied via COMMAND_RESULT_REUSED with no execution", { timeout: 180_000 }, () => {
    // No cache: the scoped command really executes and fails on the bare
    // fixture (pnpm finds no installable workspace).
    const cold = sh(["verify", "--all"]);
    expect(cold.status).toBe(1);

    // Seed a valid entry: digests computed against the current tree.
    const seeder = new CommandCache(repo, path.join(repo, ".spc", "cache", "verify-commands.json"));
    seeder.record("pnpm --filter @fixture/pkg-a... test", { executionId: "exec-seed", exitCode: 0, stdout: "all green", stderr: "", timedOut: false });
    seeder.persist();

    const warm = sh(["verify", "--all"]);
    expect(warm.status).toBe(0);

    // The reuse event with cache-named provenance is in the run records,
    // and no COMMAND_EXECUTED ever physically ran the scoped command.
    const runsDir = path.join(repo, ".spc", "runs");
    let sawReuse = false;
    let sawCacheOrigin = false;
    for (const run of readdirSync(runsDir)) {
      try {
        for (const line of readFileSync(path.join(runsDir, run, "events.jsonl"), "utf8").split("\n")) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as { type: string; payload?: Record<string, unknown> };
          if (e.type === "COMMAND_RESULT_REUSED") {
            sawReuse = true;
            if (e.payload?.origin === "cache" || e.payload?.reusedFrom === "cache") sawCacheOrigin = true;
          }
          if (e.type === "COMMAND_EXECUTED" && String(e.payload?.command ?? "").includes("pkg-a")) {
            throw new Error("cache hit path physically executed the command");
          }
        }
      } catch (err) {
        if ((err as Error).message.includes("physically executed")) throw err;
      }
    }
    expect(sawReuse).toBe(true);
    expect(sawCacheOrigin).toBe(true);
  });
});
