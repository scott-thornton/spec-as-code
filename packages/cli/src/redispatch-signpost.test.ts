import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/redispatch-signpost.yaml (RS-001): when a task
// re-dispatches and the tree already carries staged-but-uncommitted work
// under the task's own write targets (the duplicate-answer collision that
// burned three ghost rebuilds in verify-cache), the new request carries a
// note and agent list renders it. A clean re-dispatch carries none.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-rsign-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
writeFileSync(
  path.join(root, "specs", "rs.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: rs\n  title: RS\ngoal: fixture\nrequirements:\n  - id: RS-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: RS-001-A\n        type: command\n        command: "true"\n',
  "utf8",
);
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

// Direct unit-level oracle through the executor: a task whose worktree is
// dirty UNDER ITS OWN write targets re-dispatches with the note; a clean
// worktree (or dirt only elsewhere) does not.
import { executeTask } from "@spc/executor";
import { compileSpecFile } from "@spc/repo";
import { observeRepository } from "@spc/repo";

function stubProvider(calls: { key?: string; note?: string }[]) {
  return {
    name: "stub",
    model: "stub",
    async generateStructured<T>(request: { role: string; key?: string; previousRejection?: string; note?: string; schemaName: string }) {
      calls.push({ key: request.key, note: request.note });
      void request;
      const value = {
        status: "completed",
        summary: "s",
        changes: [],
        commands: [],
        observations: [],
        evidenceCandidates: [],
        followups: [],
      } as unknown as T;
      return { value, usage: { model: "stub", durationMs: 1 } };
    },
  };
}

describe("redispatch signpost (RS-001)", () => {
  it("a re-dispatch over the task's own staged work carries the note; a clean re-dispatch does not", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "spc-rsign-exec-"));
    mkdirSync(path.join(repo, "specs"), { recursive: true });
    writeFileSync(path.join(repo, "specs", "rs.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: rs\n  title: RS\ngoal: g\nrequirements:\n  - id: RS-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: RS-001-A\n        type: command\n        command: "true"\n', "utf8");
    writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
    const g = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git: ${r.stderr}`);
    };
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    g(["add", "."]);
    g(["commit", "-q", "-m", "base"]);
    const ir = compileSpecFile(path.join(repo, "specs", "rs.yaml")).ir!;

    const task = {
      id: "T001",
      title: "t",
      kind: "modify",
      intent: "i",
      targets: { read: ["lib/**"], write: ["lib/**"] },
    };

    const run = async (dirty: boolean): Promise<{ key?: string; note?: string }[]> => {
      if (dirty) {
        mkdirSync(path.join(repo, "lib"), { recursive: true });
        writeFileSync(path.join(repo, "lib", "staged.txt"), "staged work from a prior answer\n", "utf8");
      } else {
        rmSync(path.join(repo, "lib"), { recursive: true, force: true });
      }
      const calls: { key?: string; note?: string }[] = [];
      await executeTask(
        {
          task: dirty ? task : { ...task, id: "T002" },
          specIr: ir,
          snapshot: observeRepository(repo, null) as never,
          worktreeRoot: repo,
          attempt: 2,
          priorResults: [],
          observations: [],
          // The signal: this is a RE-dispatch (attempt 2 / previousRejection present)
          failureContext: { code: "PATCH_BASE_MISMATCH", message: "prior answer staged" },
        } as never,
        { provider: stubProvider(calls), onUsage: () => {} } as never,
      );
      return calls;
    };

    const dirty = await run(true);
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty[0]!.note).toMatch(/already contains/i);

    const clean = await run(false);
    expect(clean[0]!.note).toBeUndefined();
    rmSync(repo, { recursive: true, force: true });
  }, { timeout: 120_000 });

  it("agent list renders the note on a pending request carrying one", () => {
    mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
    const now = Date.now();
    writeFileSync(
      path.join(root, ".spc", "harness", "pending", "executor-T001@2-1.json"),
      JSON.stringify({
        id: "executor-T001@2-1",
        role: "executor",
        key: "T001@2",
        schemaName: "ExecutorResult",
        jsonSchema: { type: "object" },
        system: "s",
        prompt: "p",
        createdAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 10 * 60_000).toISOString(),
        note: "the tree already contains uncommitted work from a prior answer of this task - verify what is present before rebuilding",
      }),
      "utf8",
    );
    const r = sh(["agent", "list"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/executor-T001@2-1.*already contains uncommitted work/s);
  });
});
