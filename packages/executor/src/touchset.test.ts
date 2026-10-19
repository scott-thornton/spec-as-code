import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositorySnapshot, Task } from "@spc/schema";
import type { CommandsConfig } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import type { LLMProvider } from "@spc/llm";
import { git, gitOk } from "@spc/repo";
import { executorResultSchema } from "./result.js";
import {
  COMMAND_DENIED,
  COMMAND_FAILED,
  runDeclaredCommands,
  TOUCH_SET_VIOLATION,
  type DeclaredCommand,
} from "./touchset.js";
import { executeTask } from "./execute.js";
import { fileDigest } from "./patch.js";

const CONTENT = `export function authorize(user: string): boolean {
  const ok = check(user);
  return false;
}
`;

let dirs: string[] = [];
function worktree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spc-touchset-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), CONTENT, "utf8");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const COMMANDS_CONFIG: CommandsConfig = {
  network: "deny",
  packageInstall: "approval",
  migration: "approval",
  deployment: "deny",
  publish: "deny",
  gitPush: "deny",
  destructive: "deny",
  unknown: "allow",
};

const RUN_OPTS = {
  commandsConfig: COMMANDS_CONFIG,
  timeoutMs: 30_000,
  maxOutputBytes: 65_536,
};

const WRITE_GEN = `node -e "require('fs').writeFileSync('gen.ts', 'export const g = 1;\\n')"`;

describe("change protocol schema: commands", () => {
  it("accepts command entries with and without a touch-set, defaulting to none", () => {
    const withSet = executorResultSchema.safeParse({
      status: "completed",
      summary: "s",
      commands: [{ command: WRITE_GEN, touchSet: ["gen.ts"] }, { command: `node -e "console.log(1)"` }],
    });
    expect(withSet.success).toBe(true);
    if (withSet.success) {
      expect(withSet.data.commands).toHaveLength(2);
      expect(withSet.data.commands[0]!.touchSet).toEqual(["gen.ts"]);
    }
  });

  it("rejects unknown fields on command entries", () => {
    const parsed = executorResultSchema.safeParse({
      status: "completed",
      summary: "s",
      commands: [{ command: WRITE_GEN, expectedPaths: ["gen.ts"] }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("runDeclaredCommands", () => {
  it("runs an allowed command and records its result", async () => {
    const wt = worktree();
    const outcome = await runDeclaredCommands(wt, [{ command: WRITE_GEN, touchSet: ["gen.ts"] }], RUN_OPTS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]!.exitCode).toBe(0);
    expect(readFileSync(path.join(wt, "gen.ts"), "utf8")).toBe("export const g = 1;\n");
    expect(outcome.untouched).toEqual([]);
  });

  it("refuses COMMAND_DENIED for a policy-denied command without running anything", async () => {
    const wt = worktree();
    const outcome = await runDeclaredCommands(
      wt,
      [{ command: "npm publish --access public", touchSet: ["gen.ts"] }],
      RUN_OPTS,
    );
    expect(outcome).toMatchObject({ ok: false, code: COMMAND_DENIED });
    expect(() => readFileSync(path.join(wt, "gen.ts"))).toThrow();
  });

  it("refuses TOUCH_SET_VIOLATION when a tracked file outside the set is modified, and restores it", async () => {
    const wt = worktree();
    const vandalize = `node -e "require('fs').writeFileSync('src/a.ts', 'pwned\\n')"`;
    const outcome = await runDeclaredCommands(wt, [{ command: vandalize, touchSet: ["gen.ts"] }], RUN_OPTS);
    expect(outcome).toMatchObject({ ok: false, code: TOUCH_SET_VIOLATION });
    if (!outcome.ok) expect(outcome.message).toContain("src/a.ts");
    expect(readFileSync(path.join(wt, "src", "a.ts"), "utf8")).toBe(CONTENT);
  });

  it("refuses TOUCH_SET_VIOLATION when an undeclared new file is created, and removes it", async () => {
    const wt = worktree();
    const outcome = await runDeclaredCommands(wt, [{ command: WRITE_GEN }], RUN_OPTS);
    expect(outcome).toMatchObject({ ok: false, code: TOUCH_SET_VIOLATION });
    expect(() => readFileSync(path.join(wt, "gen.ts"))).toThrow();
  });

  it("refuses COMMAND_FAILED on a nonzero exit, naming the code", async () => {
    const wt = worktree();
    const outcome = await runDeclaredCommands(wt, [{ command: `node -e "process.exit(3)"` }], RUN_OPTS);
    expect(outcome).toMatchObject({ ok: false, code: COMMAND_FAILED });
    if (!outcome.ok) expect(outcome.message).toContain("3");
  });

  it("reports declared-but-unchanged entries without failing", async () => {
    const wt = worktree();
    const outcome = await runDeclaredCommands(
      wt,
      [{ command: `node -e "console.log(1)"`, touchSet: ["gen.ts", "src/*.extra"] }],
      RUN_OPTS,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.untouched).toContain("gen.ts");
    expect(outcome.untouched).toContain("src/*.extra");
  });
});

describe("executeTask wiring", () => {
  it("executes proposed commands after staged changes, so commands see the patched tree", async () => {
    const wt = worktree();
    const outcome = await runExecutorTask(wt, {
      status: "completed",
      summary: "patch then generate",
      changes: [
        {
          op: "patch",
          path: "src/a.ts",
          baseDigest: fileDigest(CONTENT),
          anchor: "return false;",
          replacement: "return ok;",
        },
      ],
      commands: [
        {
          command: `node -e "require('fs').copyFileSync('src/a.ts', 'out.txt')"`,
          touchSet: ["out.txt"],
        },
      ],
      observations: [],
      evidenceCandidates: [],
      followups: [],
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.executedCommands).toEqual([
      { command: expect.stringContaining("copyFileSync"), exitCode: 0 },
    ]);
    expect(readFileSync(path.join(wt, "out.txt"), "utf8")).toContain("return ok;");
  });

  it("fails the task when a command is denied by policy", async () => {
    const wt = worktree();
    const outcome = await runExecutorTask(wt, {
      status: "completed",
      summary: "should not run",
      changes: [],
      commands: [{ command: "npm publish", touchSet: ["gen.ts"] }],
      observations: [],
      evidenceCandidates: [],
      followups: [],
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.code).toBe(COMMAND_DENIED);
  });

  it("mentions declared-but-unchanged entries in the task summary", async () => {
    const wt = worktree();
    const outcome = await runExecutorTask(wt, {
      status: "completed",
      summary: "sweep",
      changes: [],
      commands: [{ command: `node -e "console.log(1)"`, touchSet: ["never-written.ts"] }],
      observations: [],
      evidenceCandidates: [],
      followups: [],
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.summary).toContain("never-written.ts");
  });
});

const MINIMAL_SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: touchset-fixture
  title: Touch-set fixture
goal: fixture spec for executor wiring tests
requirements:
  - id: TF-001
    statement: fixture property.
    priority: must
    acceptance:
      - id: TF-001-A
        type: command
        command: "true"
`;

function fixtureSnapshot(): RepositorySnapshot {
  return {
    revision: "r",
    dirty: false,
    languages: [],
    manifests: [],
    directories: [],
    tests: [],
    commands: {},
    relevantArtifacts: [],
    createdAt: "2026-10-19T00:00:00.000Z",
    digest: `sha256:${"0".repeat(64)}`,
  };
}

async function runExecutorTask(wt: string, value: Record<string, unknown>) {
  const specIr = compileSpecSource(MINIMAL_SPEC, "touchset-fixture.yaml").ir!;
  const provider: LLMProvider = {
    name: "fake",
    model: "fake",
    async generateStructured<T>() {
      return { value: value as unknown as T, usage: { model: "fake", durationMs: 1 } };
    },
  };
  return executeTask(
    {
      task: {
        id: "T001",
        title: "run a declared command",
        kind: "modify",
        intent: "sweep via command with declared touch-set",
        targets: { read: ["src/**", "*.ts"], write: ["src/**", "*.ts"] },
      },
      specIr,
      snapshot: fixtureSnapshot(),
      worktreeRoot: wt,
      attempt: 1,
      priorResults: [],
      observations: [],
      commands: RUN_OPTS,
    },
    { provider },
  );
}
