import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";

// Oracle for specs/apply-ownership.yaml AO-008 (pre-execution gate):
// process-level tests against REAL spawned applies. The fixture compiles
// the spec through the same compiler apply uses (real digest), configures
// the harness provider (requests queue to .spc/harness/pending and the
// apply HANGS waiting for an executor answer), and disables plan
// approval so the synthetic plan executes.
//
// AO-001: two concurrent applies in one worktree - exactly one enters,
//         the other refuses with APPLY_ALREADY_RUNNING.
// AO-002: a killed coordinator - kernel releases instantly, the durable
//         intent blocks the next apply (APPLY_WORKSPACE_UNSAFE), and
//         `spc apply recover` clears it so the next apply acquires.
// AO-004: two applies in different worktrees - both proceed.
// AO-007: no age-based lock takeover (source-level regression check).
const CLI = path.resolve(import.meta.dirname, "../../cli/dist/main.js");
const root = mkdtempSync(path.join(tmpdir(), "spc-ao-own-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

const SPEC_YAML = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ao-test
  title: T
goal: G
requirements:
  - id: T-001
    statement: S
    priority: must
    acceptance:
      - id: T-001-A
        type: file
        path: src/out.mjs
        assert:
          contains: "done"
`;

/** The harness-provider config that makes applies hang on executor answers. */
const CONFIG_YAML = `version: 1
provider:
  name: harness
execution:
  requirePlanApproval: false
  inPlace: true
verification:
  requireRedPhase: false
`;

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Fixture repo: valid spec (real digest), harness provider, hanging plan. */
function setupWorktree(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc", "plans"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), SPEC_YAML, "utf8");
  writeFileSync(path.join(repo, ".spc", "config.yaml"), CONFIG_YAML, "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);

  // Real spec digest via the exact compile path applyPlan uses, and the
  // actual HEAD revision, so the plan passes validation with no drift.
  const compiled = compileSpecSource(SPEC_YAML, "spec.yaml");
  if (!compiled.ok || !compiled.ir) throw new Error("fixture spec does not compile");
  const revision = git(repo, ["rev-parse", "HEAD"]).trim();
  writeFileSync(
    path.join(repo, ".spc", "plans", "plan-hang.json"),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-hang", createdAt: new Date().toISOString() },
      spec: { id: "ao-test", digest: compiled.ir.digest },
      repository: { revision, snapshotDigest: "sha256:" + "0".repeat(64) },
      tasks: [
        {
          id: "T001",
          title: "hang",
          kind: "modify",
          intent: "await an executor answer that never comes",
          dependsOn: [],
          satisfies: ["T-001"],
          targets: { write: ["src/out.mjs"] },
        },
      ],
    }),
    "utf8",
  );
  return repo;
}

interface TrackedChild {
  proc: ReturnType<typeof spawn>;
  exited: boolean;
  code: number | null;
}

function trackChild(proc: ReturnType<typeof spawn>): TrackedChild {
  const c: TrackedChild = { proc, exited: false, code: null };
  proc.on("exit", (code) => {
    c.exited = true;
    c.code = code;
  });
  return c;
}

function startHangingApply(cwd: string): TrackedChild {
  return trackChild(spawn(process.execPath, [CLI, "apply", ".spc/plans/plan-hang.json"], { cwd, stdio: "pipe" }));
}

function sh(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Kill a hanging apply and clear the safety block it leaves behind. */
function cleanup(repo: string, ...children: TrackedChild[]): void {
  for (const c of children) if (!c.exited) c.proc.kill("SIGKILL");
  sh(repo, ["apply", "recover"]);
}

describe("AO-001: exclusive ownership (process-level)", () => {
  it("two simultaneous applies in ONE worktree: exactly one enters, the other refuses with APPLY_ALREADY_RUNNING", { timeout: 45000 }, async () => {
    const repo = setupWorktree("same-wt");
    const first = startHangingApply(repo);
    await new Promise((r) => setTimeout(r, 3000));
    // The first apply is now hanging on the harness queue, holding the lock.
    expect(first.exited).toBe(false);

    const second = sh(repo, ["apply", ".spc/plans/plan-hang.json"]);
    expect(second.status).not.toBe(0);
    expect(second.stdout).toMatch(/APPLY_ALREADY_RUNNING/);
    // The refusal names the holder and suggests the remedies (AO-006 shape).
    expect(second.stdout).toMatch(/spc apply owner/);

    cleanup(repo, first);
  });
});

describe("AO-002: crash recovery (process-level)", () => {
  it("a SIGKILLed coordinator: next apply is blocked UNSAFE immediately (no window), recover clears it, then the next apply acquires", { timeout: 45000 }, async () => {
    const repo = setupWorktree("crash");
    const owner = startHangingApply(repo);
    await new Promise((r) => setTimeout(r, 3000));
    expect(owner.exited).toBe(false);

    owner.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));

    // The kernel lock died with the process; the durable intent record
    // survives and must block the next apply IMMEDIATELY (measured: well
    // under any window expiry - the old lease's dead-pid reclaim window
    // would have stalled this).
    const t0 = Date.now();
    const blocked = sh(repo, ["apply", ".spc/plans/plan-hang.json"]);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout).toMatch(/APPLY_WORKSPACE_UNSAFE/);

    // Recovery is the sanctioned path back: five steps, then acquisition.
    const recovered = sh(repo, ["apply", "recover"]);
    expect(recovered.status).toBe(0);

    const next = startHangingApply(repo);
    await new Promise((r) => setTimeout(r, 3000));
    expect(next.exited).toBe(false); // acquired, hanging on the harness

    cleanup(repo, next);
  });
});

describe("AO-004: worktree independence (process-level)", () => {
  it("two applies in DIFFERENT worktrees: both proceed without refusing each other", { timeout: 45000 }, async () => {
    const repoA = setupWorktree("wt-a");
    const repoB = setupWorktree("wt-b");
    const a = startHangingApply(repoA);
    const b = startHangingApply(repoB);
    await new Promise((r) => setTimeout(r, 3000));
    // Both still running: each worktree's .spc/ has its own lock, and
    // neither saw the other's ownership.
    expect(a.exited).toBe(false);
    expect(b.exited).toBe(false);
    cleanup(repoA, a);
    cleanup(repoB, b);
  });
});

describe("AO-007: no stale takeover (behavioural regression)", () => {
  it("no stale takeover: an apply held longer than 15 minutes is still protected (not stolen by age)", { timeout: 10000 }, () => {
    // This test verifies the ABSENCE of age-based takeover.
    // We check that the runtime has no code path that takes over
    // a lock based solely on elapsed time (the old 15-minute rule).
    const lockSource = readFileSync(path.resolve(import.meta.dirname, "../src/lock.ts"), "utf8");
    expect(lockSource).not.toContain("RUN_LOCK_STALE_MS");
    expect(lockSource).not.toContain("15 * 60");
    // Also verify the apply-lease module is gone
    const leasePath = path.resolve(import.meta.dirname, "../src/apply-lease.ts");
    expect(existsSync(leasePath)).toBe(false);
  });
});
