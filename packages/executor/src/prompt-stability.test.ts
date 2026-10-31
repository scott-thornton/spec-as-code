import { describe, expect, it } from "vitest";
import { buildExecutorPrompt, EXECUTOR_SYSTEM, type ExecutorTaskContext } from "./prompts.js";
import type { SpecIR, RepositorySnapshot } from "@spc/schema";

// Oracle for specs/prompt-stability.yaml (PST-003): determinism pins on
// the executor prompt builder - same inputs compose byte-identical
// prompts, and two different tasks over the same spec and repository
// share their prefix through the entire spec and repository blocks.
// These pin the stable-first payload order so later composition changes
// cannot silently regress it (every cache regime keys on this prefix).
const specIr = {
  spec: { metadata: { id: "pst-fixture", title: "PST" }, goal: "fixture goal" },
  properties: [
    {
      kind: "requirement",
      id: "PST-001",
      statement: "holds",
      priority: "must",
      dependsOn: [],
      acceptance: [],
    },
  ],
} as unknown as SpecIR;

const snapshot = {
  revision: "abc123",
  languages: ["typescript"],
  commands: { build: "pnpm build" },
} as unknown as RepositorySnapshot;

function ctx(taskId: string): ExecutorTaskContext {
  return {
    task: {
      id: taskId,
      title: `task ${taskId}`,
      kind: "modify",
      intent: "i",
      targets: { read: ["lib/**"], write: ["lib/**"] },
    } as never,
    properties: specIr.properties as never,
    readFiles: [
      { path: "lib/alpha.ts", content: "alpha body", digest: "sha256:" + "a".repeat(64) },
      { path: "lib/beta.ts", content: "beta body", digest: "sha256:" + "b".repeat(64) },
    ],
    priorResults: [{ taskId: "T000", summary: "prior" }],
    observations: [],
    allowedReadPaths: ["lib/**"],
    allowedWritePaths: ["lib/**"],
  } as never;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

describe("executor prompt determinism (PST-003)", () => {
  it("same context composes a byte-identical prompt", () => {
    const a = buildExecutorPrompt(ctx("T001"), specIr, snapshot);
    const b = buildExecutorPrompt(ctx("T001"), specIr, snapshot);
    expect(a).toBe(b);
  });

  it("two tasks share their prefix through the spec and repository blocks", () => {
    const a = buildExecutorPrompt(ctx("T001"), specIr, snapshot);
    const b = buildExecutorPrompt(ctx("T002"), specIr, snapshot);
    const shared = a.slice(0, commonPrefixLength(a, b));
    // Stable-first by construction: spec, then repository, then task.
    expect(shared).toContain('"goal"');
    expect(shared).toContain('"commands"');
    // The divergence lands at the task object, not before it.
    expect(shared.endsWith('"task"') || shared.includes('"repository"')).toBe(true);
    expect(shared).not.toContain("T001");
    expect(shared).not.toContain("T002");
  });

  it("the role system is constant text (no per-request data)", () => {
    expect(EXECUTOR_SYSTEM).not.toMatch(/\{|\}|randomUUID|Date\.now/);
  });
});
