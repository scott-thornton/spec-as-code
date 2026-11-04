import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, gitOk } from "./git.js";

// Oracle for specs/git-deadline.yaml (GD-001, GD-002 - red, committed
// pre-run): every git subprocess on a coordinator path carries its own
// deadline. The fake git TRAPS SIGTERM and sleeps - a correct SIGKILL
// deadline returns at the bound with a typed timedOut and a named
// SPC_GIT_DEADLINE throw; a naive SIGTERM implementation waits out the
// sleep and the assertions fail; today (no deadline, no gitBinary) the
// real git answers and the assertions fail fast instead.
const root = mkdtempSync(path.join(tmpdir(), "spc-gdl-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

// The hung-git fake: single node process (no shell children to orphan),
// ignores its arguments, traps SIGTERM so only SIGKILL ends it.
const FAKE = path.join(root, "fake-git");
writeFileSync(FAKE, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 20_000);\n", "utf8");
chmodSync(FAKE, 0o755);

// A real repository for the control leg (the fixture root itself - the
// fake-git and a.txt ride along as committed content, harmlessly).
const repo = root;
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
writeFileSync(path.join(repo, "a.txt"), "x\n", "utf8");
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"], { cwd: repo });

describe("GD-001: the adapter's deadline", () => {
  it("a SIGTERM-trapping hung git is killed at the bound: typed timedOut, named SPC_GIT_DEADLINE, elapsed under the sleep", { timeout: 60_000 }, () => {
    const saved = process.env.SPC_GIT_TIMEOUT_MS;
    process.env.SPC_GIT_TIMEOUT_MS = "300";
    const t0 = Date.now();
    try {
      const r = git(repo, ["rev-parse", "HEAD"], { gitBinary: FAKE });
      const elapsed = Date.now() - t0;
      // Killed at the ~300ms bound - not waited out the 20s sleep, not
      // blocked forever.
      expect(elapsed).toBeLessThan(10_000);
      // Typed failure surface (the CommandRunResult precedent), never a
      // string-matching contract.
      expect(r.timedOut).toBe(true);
      expect(r.ok).toBe(false);
      // gitOk throws the named error: command + budget identified.
      let threw: (Error & { code?: string }) | undefined;
      try {
        gitOk(repo, ["rev-parse", "HEAD"], { gitBinary: FAKE });
      } catch (e) {
        threw = e as Error & { code?: string };
      }
      expect(threw).toBeDefined();
      expect(threw!.code).toBe("SPC_GIT_DEADLINE");
      expect(threw!.message).toMatch(/rev-parse/);
      expect(threw!.message).toMatch(/300/);
    } finally {
      if (saved === undefined) delete process.env.SPC_GIT_TIMEOUT_MS;
      else process.env.SPC_GIT_TIMEOUT_MS = saved;
    }
  });

  it("real git under a tightened override completes normally - the deadline never fires below the bound", { timeout: 30_000 }, () => {
    const saved = process.env.SPC_GIT_TIMEOUT_MS;
    process.env.SPC_GIT_TIMEOUT_MS = "10000";
    try {
      const r = git(repo, ["rev-parse", "HEAD"]);
      expect(r.ok).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      if (saved === undefined) delete process.env.SPC_GIT_TIMEOUT_MS;
      else process.env.SPC_GIT_TIMEOUT_MS = saved;
    }
  });
});

describe("GD-002: no sibling git spawns outside the adapter", () => {
  it("executor and verifier sources carry no direct spawnSync(\"git\") calls (AO-007 source-check precedent)", () => {
    const sites = [
      "../../executor/src/execute.ts",
      "../../executor/src/unmediated-guard.ts",
      "../../verifier/src/command-cache.ts",
    ];
    for (const rel of sites) {
      const src = readFileSync(path.resolve(import.meta.dirname, rel), "utf8");
      expect(src, `${rel} still spawns git directly`).not.toContain('spawnSync("git"');
    }
  });
});
