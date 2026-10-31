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
const specRepo = mkdtempSync(path.join(tmpdir(), "spc-vcache-cli-"));
afterAll(() => rmSync(specRepo, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: specRepo, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitCli(args: string[]): void {
  const r = spawnSync("git", args, { cwd: specRepo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(specRepo, "packages", "pkg-a", "src"), { recursive: true });
writeFileSync(path.join(specRepo, "packages", "pkg-a", "package.json"), JSON.stringify({ name: "@fixture/pkg-a", version: "1.0.0", dependencies: {} }), "utf8");
writeFileSync(path.join(specRepo, "packages", "pkg-a", "src", "index.ts"), "export const paga = 1;\n", "utf8");
mkdirSync(path.join(specRepo, "specs"), { recursive: true });
writeFileSync(path.join(specRepo, "specs", "vc.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: vc\n  title: VC\ngoal: fixture\nrequirements:\n  - id: VC-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: VC-001-A\n        type: command\n        command: pnpm --filter @fixture/pkg-a... test\n', "utf8");
writeFileSync(path.join(specRepo, ".gitignore"), ".spc/\n", "utf8");
gitCli(["init", "-q", "-b", "main"]);
gitCli(["config", "user.email", "t@t"]);
gitCli(["config", "user.name", "t"]);
gitCli(["add", "."]);
gitCli(["commit", "-q", "-m", "base"]);

describe("CLI integration (VC-002)", () => {
  const specRepo = mkdtempSync(path.join(tmpdir(), "spc-vcache-cli-"));

  function sh(args: string[]): { status: number; stdout: string } {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: specRepo, encoding: "utf8" });
    return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  // A spec whose criterion is a scoped pnpm command against a package that
  // does not exist as an installable workspace - executing it would fail
  // (no install), so a satisfied verify with a reuse event proves the hit.
  mkdirSync(path.join(specRepo, "packages", "pkg-a", "src"), { recursive: true });
  writeFileSync(path.join(specRepo, "packages", "pkg-a", "package.json"), JSON.stringify({ name: "@fixture/pkg-a", version: "1.0.0", dependencies: {} }), "utf8");
  writeFileSync(path.join(specRepo, "packages", "pkg-a", "src", "index.ts"), "export const paga = 1;\n", "utf8");
  mkdirSync(path.join(specRepo, "specs"), { recursive: true });
  writeFileSync(path.join(specRepo, "specs", "vc.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: vc\n  title: VC\ngoal: fixture\nrequirements:\n  - id: VC-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: VC-001-A\n        type: command\n        command: pnpm --filter @fixture/pkg-a... test\n', "utf8");
  writeFileSync(path.join(specRepo, ".gitignore"), ".spc/\n", "utf8");
  gitCli(["init", "-q", "-b", "main"], specRepo);
  gitCli(["config", "user.email", "t@t"], specRepo);
  gitCli(["config", "user.name", "t"], specRepo);
  gitCli(["add", "."], specRepo);
  gitCli(["commit", "-q", "-m", "base"], specRepo);

  it("a seeded valid entry verifies satisfied via COMMAND_RESULT_REUSED with no execution; without it, honest execution", { timeout: 180_000 }, () => {
    // No cache: the command really executes and fails on the bare fixture.
    const cold = sh(["verify", "--all"]);
    expect(cold.status).toBe(1);

    // Seed a valid entry: digests computed against the current tree.
    const seeder = new CommandCache(specRepo, path.join(specRepo, ".spc", "cache", "verify-commands.json"));
    seeder.record("pnpm --filter @fixture/pkg-a... test", { executionId: "exec-seed", exitCode: 0, stdout: "all green", stderr: "", timedOut: false });
    seeder.persist();

    const warm = sh(["verify", "--all"]);
    expect(warm.status).toBe(0);
    // The reuse event and the cache-named provenance are in the run record.
    
    const runsDir = path.join(specRepo, ".spc", "runs");
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
