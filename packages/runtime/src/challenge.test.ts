import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireHostAdmission } from "@spc/verifier";
import { loadChallengeFixture, runChallenge, challengeRecordPath, coldPrepare } from "./challenge.js";

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

  // Rectification oracle (adversarial pass, 2026-11-08): CHAL-005
  // enumerates "the criterion and fixture digests, the command
  // execution identities". The fixture digest was recorded; the
  // criterion digest and the execution identities were not (the
  // scratch evidence store is deleted with nothing copied out).
  // Today these fields do not exist - this is red.
  it("the audit record pins the challenged criterion digest and the command execution identities per leg (CHAL-005)", () => {
    const record = JSON.parse(readFileSync(challengeRecordPath(repo, fixtureName), "utf8")) as {
      baseline: Record<string, unknown>;
      mutation: Record<string, unknown>;
    };
    expect(String(record.baseline["criterionDigest"])).toMatch(/^sha256:/);
    expect(String(record.mutation["criterionDigest"])).toMatch(/^sha256:/);
    // The mutation does not touch the spec: both legs challenged the
    // same criterion definition.
    expect(record.baseline["criterionDigest"]).toBe(record.mutation["criterionDigest"]);
    // Execution identities: arrays (empty is honest for file criteria
    // that run no commands; absent is not).
    expect(Array.isArray(record.baseline["executionIds"])).toBe(true);
    expect(Array.isArray(record.mutation["executionIds"])).toBe(true);
  });

  it("both worktrees are cleaned on every exit path - no leftovers at all", () => {
    const worktreesDir = path.join(repo, ".spc", "worktrees");
    const leftover = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
    expect(leftover).toEqual([]);
  });
});

// Rectification oracle (adversarial pass, 2026-11-08): CHAL-C01 -
// "no direct unguarded battery path exists, even for the challenge
// CLI command itself". The cold prepare (pnpm install + a forced
// full monorepo build, twice per challenge) was the heaviest
// subprocess in the delivery and ran through raw spawnSync with no
// admission. Today coldPrepare is private and unadmitted - importing
// it is red; the refusal and install-failure contracts below are red
// with it.
describe("CHAL-C01/CHAL-002: the cold prepare admits and reports honestly", () => {
  const pkgRoot = path.join(root, "pkg-repo");
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(path.join(pkgRoot, "package.json"), '{ "name": "chal-prep", "private": true }\n', "utf8");

  it("refuses - never waits - when another fresh verification holds the host admission; nothing spawns", () => {
    const lock = acquireHostAdmission();
    expect(lock).not.toBeNull();
    try {
      const r = coldPrepare(pkgRoot);
      expect(r.refused).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/admission/i);
    } finally {
      lock?.release();
    }
  });

  it("a failed dependency install is an environment failure, named and non-ok - never laundered into a criterion verdict", () => {
    // No pnpm-lock.yaml: --frozen-lockfile fails fast offline.
    const r = coldPrepare(pkgRoot);
    expect(r.refused).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.failureStage).toBe("install");
    expect(r.output).toMatch(/frozen-lockfile|lockfile/i);
  });
});

// Rectification oracle (adversarial pass, 2026-11-08): a repository
// whose environment cannot prepare must yield an INCONCLUSIVE
// challenge (CHAL-002: execution uncertainty is never a forced
// binary). Today the prepare failure is invisible - the file
// criterion does not need node_modules, both legs run, and the
// challenge reports discriminating over a broken environment. Red.
describe("CHAL-002: a challenge against an unpreparable environment is inconclusive", () => {
  const brokenRepo = path.join(root, "broken-repo");
  const brokenFixture = "delete-fact-broken";
  {
    mkdirSync(path.join(brokenRepo, "specs"), { recursive: true });
    mkdirSync(path.join(brokenRepo, "challenges"), { recursive: true });
    writeFileSync(path.join(brokenRepo, "specs", "c.yaml"),
      'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: chal\n  title: C\ngoal: g\nrequirements:\n  - id: C-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: C-001-A\n        type: file\n        path: fact.txt\n        assert:\n          exists: true\n',
      "utf8");
    writeFileSync(path.join(brokenRepo, "fact.txt"), "the fact\n", "utf8");
    // A package root with NO lockfile: install fails, the environment
    // never prepares, and the challenge must say so - not "detected".
    writeFileSync(path.join(brokenRepo, "package.json"), '{ "name": "broken-prep", "private": true }\n', "utf8");
    writeFileSync(path.join(brokenRepo, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
    writeFileSync(path.join(brokenRepo, "challenges", `${brokenFixture}.yaml`),
      `apiVersion: spc.dev/v1alpha1\nkind: Challenge\nmetadata:\n  id: ${brokenFixture}\n  title: delete the fact\ncriterion:\n  spec: chal\n  criterionId: C-001-A\nopsJson: '[{"op":"delete","path":"fact.txt"}]'\nexpectedSignature: '"exists":false'\nprovenance:\n  introduced: "0000000"\n  caught: "0000000"\n  diagnostic: "fact file deleted"\n`,
      "utf8");
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: brokenRepo });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: brokenRepo });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: brokenRepo });
  }

  it("the challenge outcome is inconclusive - the baseline environment failed to prepare", async () => {
    const result = await runChallenge(brokenRepo, brokenFixture);
    expect(result.outcome).toBe("inconclusive");
    expect(result.baseline.outcome).toBe("inconclusive");
    expect(result.baseline.output).toMatch(/frozen-lockfile|lockfile|install/i);
    const record = JSON.parse(readFileSync(challengeRecordPath(brokenRepo, brokenFixture), "utf8")) as Record<string, unknown>;
    expect(record["outcome"]).toBe("inconclusive");
  }, 180_000);
});
