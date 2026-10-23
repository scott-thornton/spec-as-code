import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spcPaths, EventStore, EvidenceStore, FollowupStore } from "./index.js";
import { runContaminationGuard } from "./guard.js";

// Oracle for specs/verification-preparation.yaml (VP-004): the guard
// prepares its worktree with the shared helper, and a guard that cannot
// prepare does not downgrade satisfied properties - an environmental
// failure is not contamination evidence.
const root = mkdtempSync(path.join(tmpdir(), "spc-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gitsh(args: string[], cwd = root): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const SPEC_PROPERTY = {
  id: "VPG-001",
  statement: "Gate passes.",
  priority: "must" as const,
  acceptance: [
    { id: "VPG-001-A", type: "command" as const, command: "node gate.cjs", discriminating: true },
  ],
};

function makeRepo(kind: "broken-pnpm" | "plain"): string {
  const repo = path.join(root, kind);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  writeFileSync(path.join(repo, "gate.cjs"), "process.exit(0);\n", "utf8");
  if (kind === "broken-pnpm") {
    writeFileSync(path.join(repo, "package.json"), '{"name":"g","private":true}', "utf8");
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "not a lockfile\n", "utf8");
  } else {
    mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    writeFileSync(path.join(repo, "node_modules", ".keep"), "", "utf8");
  }
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
  gitsh(["init", "-q", "-b", "main"], repo);
  gitsh(["config", "user.email", "t@t"], repo);
  gitsh(["config", "user.name", "t"], repo);
  gitsh(["add", "."], repo);
  gitsh(["commit", "-q", "-m", "base"], repo);
  return repo;
}

function guardFor(repo: string) {
  const paths = spcPaths(repo);
  const runId = "run-guard-1";
  const events = new EventStore(paths.eventsFile(runId), runId);
  const resultRevision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout!.trim();
  return () =>
    runContaminationGuard({
      repoRoot: repo,
      runId,
      resultRevision,
      specProperties: [SPEC_PROPERTY as never],
      config: { execution: { commandTimeoutMs: 10_000, maxOutputBytes: 65536 }, commands: {}, verification: {} } as never,
      provider: null,
      evidence: new EvidenceStore(paths.evidenceFile(runId)),
      followups: new FollowupStore(paths.followupsFile(runId)),
      events,
      log: () => {},
      now: () => "2026-10-23T00:00:00.000Z",
    });
}

describe("contamination guard preparation (VP-004)", () => {
  it("a guard that cannot prepare reports it and downgrades nothing", () => {
    const repo = makeRepo("broken-pnpm");
    const result = guardFor(repo)();
    expect(result.ran).toBe(false);
    expect(result.reason ?? "").toMatch(/prepar/i);
    expect(result.states.length).toBe(0);
  });

  it("a guard that prepares runs its criteria", () => {
    const repo = makeRepo("plain");
    const result = guardFor(repo)();
    expect(result.ran).toBe(true);
    expect(result.states.length).toBe(1);
    expect(result.states[0]!.propertyId).toBe("VPG-001");
  });
});
