import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadChallengeFixture, runChallenge, challengeRecordPath } from "./challenge.js";

// Oracle for specs/criterion-challenge.yaml CHAL-001/CHAL-005 (red,
// committed pre-run): the challenge engine - fixture loading, two
// disposable worktrees from one base revision, cold prepare (build
// with incremental state invalidated), criteria through the frozen
// executor, the audit record, and cleanup on every exit path. Today
// no engine exists. The fixture repo is deliberately tiny (a
// file-criterion challenge - cheap) so the engine's mechanics are
// tested without a battery.
const root = mkdtempSync(path.join(tmpdir(), "spc-chal-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

/** A fixture repo: a spec with one file criterion that passes at base and fails when the mutation deletes the fact file. */
const repo = path.join(root, "repo");
const fixtureName = "delete-fact";
{
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "challenges"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "c.yaml"),
    'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: chal\n  title: C\ngoal: g\nrequirements:\n  - id: C-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: C-001-A\n        type: file\n        path: fact.txt\n        assert:\n          exists: true\n',
    "utf8");
  writeFileSync(path.join(repo, "fact.txt"), "the fact\n", "utf8");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  writeFileSync(path.join(repo, "challenges", `${fixtureName}.yaml`),
    `apiVersion: spc.dev/v1alpha1\nkind: Challenge\nmetadata:\n  id: ${fixtureName}\n  title: delete the fact\ncriterion:\n  spec: chal\n  criterionId: C-001-A\nopsJson: '[{"op":"delete","path":"fact.txt"}]'\nexpectedSignature: '"exists":false'\nprovenance:\n  introduced: "0000000"\n  caught: "0000000"\n  diagnostic: "fact file deleted"\n`,
    "utf8");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: repo });
}

describe("CHAL-001: fixture loading", () => {
  it("loads the committed fixture: criterion identity, mutation ops, signature, provenance", () => {
    const fixture = loadChallengeFixture(repo, fixtureName);
    expect(fixture.criterion.spec).toBe("chal");
    expect(fixture.criterion.criterionId).toBe("C-001-A");
    expect(fixture.mutation.ops.length).toBe(1);
    expect(fixture.expectedSignature).toBe('"exists":false');
  });

  it("refuses an unknown criterion or a malformed fixture - named, not fatal-adjacent", () => {
    expect(() => loadChallengeFixture(repo, "no-such-fixture")).toThrow(/challenge/i);
  });
});

describe("CHAL-001/CHAL-005: the engine end to end (file criterion)", () => {
  let result: Awaited<ReturnType<typeof runChallenge>>;
  beforeAll(async () => {
    result = await runChallenge(repo, fixtureName);
  }, 120_000);

  it("the outcome is discriminating: baseline supports, mutation contradicts, signature in the pipeline output", () => {
    expect(result.outcome).toBe("discriminating");
    expect(result.baseline.outcome).toBe("supports");
    expect(result.mutation.outcome).toBe("contradicts");
    expect(result.mutation.output).toContain("fact.txt");
  });

  it("the audit record carries revisions, digests, outcome, and attribution - separate from the run store", () => {
    const recordPath = challengeRecordPath(repo, fixtureName);
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    expect(record["outcome"]).toBe("discriminating");
    expect(String(record["fixtureDigest"])).toMatch(/^sha256:/);
    expect(record["criterion"]).toEqual({ spec: "chal", criterionId: "C-001-A" });
    // Provenance pinned.
    expect(record["provenance"]).toBeDefined();
  });

  it("both worktrees are cleaned on every exit path", () => {
    const worktreesDir = path.join(repo, ".spc", "worktrees");
    if (existsSync(worktreesDir)) {
      const leftover = require("node:fs").readdirSync(worktreesDir).filter((d: string) => d.includes("challenge"));
      expect(leftover).toEqual([]);
    }
  });
});
