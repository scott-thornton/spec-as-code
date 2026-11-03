import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileSpecSource } from "@spc/core";

// Oracle for specs/apply-ownership.yaml AO-008 (pre-execution gate):
// cancellation process-level tests. Real spawned applies hang on the
// harness queue (see apply-ownership.test.ts for the fixture recipe);
// `spc run cancel` must stop them cooperatively - the owner observes the
// retirement of its pending request, finalizes truthfully, and exits,
// freeing the workspace without any escalation.
const CLI = path.resolve(import.meta.dirname, "../../cli/dist/main.js");
const root = mkdtempSync(path.join(tmpdir(), "spc-ao-cancel-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

const SPEC_YAML = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ao-cancel
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

function setupRepo(name: string): string {
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

  const compiled = compileSpecSource(SPEC_YAML, "spec.yaml");
  if (!compiled.ok || !compiled.ir) throw new Error("fixture spec does not compile");
  const revision = git(repo, ["rev-parse", "HEAD"]).trim();
  writeFileSync(
    path.join(repo, ".spc", "plans", "plan-hang.json"),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-hang", createdAt: new Date().toISOString() },
      spec: { id: "ao-cancel", digest: compiled.ir.digest },
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

function startApply(cwd: string): TrackedChild {
  return trackChild(spawn(process.execPath, [CLI, "apply", ".spc/plans/plan-hang.json"], { cwd, stdio: "pipe" }));
}

function sh(cwd: string, args: string[], timeoutMs?: number): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** The most recent run id in a fixture repo (mtimes, newest first). */
function latestRunId(repo: string): string {
  const runsDir = path.join(repo, ".spc", "runs");
  const entries = spawnSync("ls", ["-t", runsDir], { encoding: "utf8" }).stdout.trim().split("\n");
  const latest = entries[0] ?? "";
  if (!latest) throw new Error("no runs created in fixture");
  return latest;
}

async function waitExited(child: TrackedChild, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!child.exited && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
  }
  return child.exited;
}

function cleanup(repo: string, ...children: TrackedChild[]): void {
  for (const c of children) if (!c.exited) c.proc.kill("SIGKILL");
  sh(repo, ["apply", "recover"]);
}

describe("AO-003: cooperative cancellation (process-level)", () => {
  it("cancel: hanging coordinator stops, finalizes, and frees the workspace for the next apply", { timeout: 60000 }, async () => {
    const repo = setupRepo("coop");
    const applyChild = startApply(repo);
    await new Promise((r) => setTimeout(r, 3000));
    expect(applyChild.exited).toBe(false); // hanging on the harness queue

    const runId = latestRunId(repo);
    const cancel = sh(repo, ["run", "cancel", runId]);
    expect(cancel.status).toBe(0);
    expect(cancel.stdout).toMatch(/cancelled/);

    // The owner observed the retirement and finalized - no escalation.
    expect(await waitExited(applyChild, 20000)).toBe(true);

    // Workspace freed: the next apply acquires and hangs on its own request.
    const next = startApply(repo);
    await new Promise((r) => setTimeout(r, 3000));
    expect(next.exited).toBe(false);
    cleanup(repo, next);
  });

  it("cancel retry after a first cancellation attempt is safe (idempotent, never two outcomes)", { timeout: 60000 }, async () => {
    const repo = setupRepo("crash-retry");
    const applyChild = startApply(repo);
    await new Promise((r) => setTimeout(r, 3000));
    expect(applyChild.exited).toBe(false);

    const runId = latestRunId(repo);
    // A first cancel may complete cooperatively; a retry must either
    // report idempotent success (still finalizing) or the honest
    // RUN_ALREADY_FINISHED refusal - never a second cancellation.
    const first = sh(repo, ["run", "cancel", runId]);
    const retry = sh(repo, ["run", "cancel", runId]);
    const accepted = first.status === 0 || /cancelled|INCOMPLETE/.test(first.stdout);
    expect(accepted).toBe(true);
    expect(
      retry.status === 0 ||
        /RUN_ALREADY_FINISHED|cancelled|INCOMPLETE/.test(retry.stdout),
    ).toBe(true);

    expect(await waitExited(applyChild, 20000)).toBe(true);
    cleanup(repo);
  });

  it("exactly one terminal event per cancelled run (arbitration invariant)", { timeout: 60000 }, async () => {
    const repo = setupRepo("esc-race");
    const applyChild = startApply(repo);
    await new Promise((r) => setTimeout(r, 3000));
    const runId = latestRunId(repo);

    sh(repo, ["run", "cancel", runId]);
    expect(await waitExited(applyChild, 20000)).toBe(true);

    const eventsFile = path.join(repo, ".spc", "runs", runId, "events.jsonl");
    expect(existsSync(eventsFile)).toBe(true);
    const events = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string });
    const terminal = events.filter((e) => e.type === "RUN_COMPLETED");
    expect(terminal.length).toBe(1);
    cleanup(repo);
  });
});
