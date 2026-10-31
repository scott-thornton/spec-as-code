import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LLMProvider, StructuredRequest, StructuredResponse } from "@spc/llm";
import { loadTask } from "./task.js";
import { runControlArm } from "./control.js";
import { armTotals, renderSummary } from "./compare.js";
import type { TaskResult } from "./benchmark.js";

// Oracle for specs/cache-capture.yaml (CC-002): the runner carries cache
// economics through - the control arm accumulates cacheReadTokens and
// cacheCreationTokens from provider usage into its result record, arm
// totals expose them, and the summary renders a cache row only when
// some arm reports a nonzero figure (absent or zero stays silent, so
// pre-change records read identically).
const tmpRoot = mkdtempSync(path.join(tmpdir(), "spc-cachecapture-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// A minimal task fixture with a real repo checkout.
const taskDir = path.join(tmpRoot, "smoke", "cache-1");
mkdirSync(path.join(taskDir, "repo", "lib"), { recursive: true });
mkdirSync(path.join(taskDir, "grading"), { recursive: true });
writeFileSync(path.join(taskDir, "repo", "lib", "x.mjs"), "export const x = () => 1;\n");
writeFileSync(path.join(taskDir, "grading", "gt-1.mjs"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { x } from "../lib/x.mjs";\ntest("x doubled", () => assert.equal(x(), 2));\n');
writeFileSync(
  path.join(taskDir, "task.yaml"),
  [
    "id: cache-1",
    "category: smoke",
    "title: Double x",
    "description: Change x() to return 2.",
    "spec: |",
    "  apiVersion: spc.dev/v1alpha1",
    "  kind: Spec",
    "  metadata:",
    "    id: cache-1",
    "    title: Double x",
    "  goal: x() returns 2.",
    "  requirements:",
    "    - id: SMK-001",
    "      statement: x() returns 2.",
    "      priority: must",
    "      acceptance:",
    "        - id: SMK-001-A",
    "          type: file",
    "          path: lib/x.mjs",
    "          assert:",
    "            contains: \"return 2\"",
    "groundTruth:",
    "  requirements:",
    "    - id: GT-001",
    "      description: x() returns 2",
    "      verify:",
    "        type: command",
    "        command: node --test \"grading/gt-1.mjs\"",
    "  regression:",
    "    command: node -e 0",
    "    expectBefore: pass",
    "  forbidden:",
    "    - package.json",
    "",
  ].join("\n"),
);
// loadTask requires the scripted-provider files to exist alongside task.yaml.
writeFileSync(
  path.join(taskDir, "control-script.yaml"),
  ["planner:", "  value:", "    planMarkdown: |", "      ## Plan", "executor:", "  implement:", "    summary: done", "    changes: []", "    claimedDone: true", "    ranTests: false", ""].join("\n"),
);
writeFileSync(
  path.join(taskDir, "treatment-script.yaml"),
  ["planner:", "  value:", "    plan:", "      tasks: []", "    observations: []", "    assumptions: []", "    followups: []", "executor: {}", ""].join("\n"),
);
git(path.join(taskDir, "repo"), ["init", "-q", "-b", "main"]);
git(path.join(taskDir, "repo"), ["config", "user.email", "t@t"]);
git(path.join(taskDir, "repo"), ["config", "user.name", "t"]);
git(path.join(taskDir, "repo"), ["add", "."]);
git(path.join(taskDir, "repo"), ["commit", "-q", "-m", "base"]);

/** Provider whose every call reports cache-bearing usage. */
function cachedProvider(cacheRead: number, cacheCreation: number): LLMProvider {
  return {
    name: "stub",
    model: "stub",
    async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
      void request;
      // The control arm asks plan first, then implement; both shapes
      // satisfy their strict schemas minimally.
      const isPlan = request.schemaName === "BaselinePlan";
      const value = (isPlan
        ? { planMarkdown: "## Plan\n1. Tweak x." }
        : { summary: "done", changes: [], claimedDone: true, ranTests: false }) as unknown as T;
      return {
        value,
        usage: { model: "stub", durationMs: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation },
      };
    },
  };
}

describe("cache capture (runner)", () => {
  it("the control arm accumulates cache fields across its provider calls", { timeout: 120_000 }, async () => {
    const loaded = loadTask(taskDir);
    const result = await runControlArm({
      task: loaded,
      repoDir: path.join(taskDir, "repo"),
      provider: cachedProvider(100, 20),
      baselineInstructions: "baseline",
    });
    expect(result.modelCalls).toBe(2);
    expect(result.tokensIn).toBe(200);
    // Two cache-bearing calls: 100 read + 100 read, 20 + 20 created.
    expect(result.cacheReadTokens).toBe(200);
    expect(result.cacheCreationTokens).toBe(40);
  });

  it("arm totals expose the fields and the summary renders a cache row only when nonzero", () => {
    const base = {
      category: "smoke",
      taskId: "t",
      trial: 1,
      error: undefined,
    };
    const control = {
      completionRate: 1,
      falseCompletionDeclaration: false,
      regressionsIntroduced: false,
      forbiddenChanges: [],
      patchSize: 10,
      modelCalls: 2,
      tokensIn: 100,
      tokensOut: 10,
      cacheReadTokens: 200,
      cacheCreationTokens: 40,
    };
    const treatment = { ...control, replans: 0, followupsRaised: 0, status: "succeeded" as const };
    const results = [{ ...base, control, treatment }] as unknown as TaskResult[];
    const c = armTotals(results, "control");
    expect(c.cacheReadTokens).toBe(200);
    expect(c.cacheCreationTokens).toBe(40);
    const withCache = renderSummary({ mode: "scripted", tasksRoot: "x", outDir: "y", trials: 1, generatedAt: "now", results } as never);
    expect(withCache).toMatch(/Cached tokens \(read \/ created\)/);
    expect(withCache).toMatch(/200 \/ 40/);

    const silent = renderSummary({ mode: "scripted", tasksRoot: "x", outDir: "y", trials: 1, generatedAt: "now", results: [{ ...base, control: { ...control, cacheReadTokens: 0, cacheCreationTokens: 0 }, treatment: { ...treatment, cacheReadTokens: 0, cacheCreationTokens: 0 } }] } as never);
    expect(silent).not.toMatch(/Cached tokens/);
  });
});
