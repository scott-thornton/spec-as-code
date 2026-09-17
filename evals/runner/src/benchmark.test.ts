import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTask, listTasks } from "./task.js";
import { runBenchmark } from "./benchmark.js";
import { armTotals, renderSummary } from "./compare.js";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "spc-evals-test-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Minimal self-contained task: control misses the requirement and lies; treatment satisfies it. */
function writeSmokeTask(root: string, id: string): void {
  const dir = path.join(root, "smoke", id);
  mkdirSync(path.join(dir, "repo", "lib"), { recursive: true });
  writeFileSync(path.join(dir, "repo", "lib", "x.mjs"), 'export const x = () => 1;\n');
  mkdirSync(path.join(dir, "grading"), { recursive: true });
  writeFileSync(
    path.join(dir, "grading", "gt-1.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { x } from "../lib/x.mjs";\n\ntest("x doubled", () => {\n  assert.equal(x(), 2);\n});\n',
  );
  writeFileSync(
    path.join(dir, "task.yaml"),
    [
      "id: " + id,
      "category: smoke",
      "title: Double x",
      "description: Change x() to return 2.",
      "spec: |",
      "  apiVersion: spc.dev/v1alpha1",
      "  kind: Spec",
      "  metadata:",
      "    id: " + id,
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
  writeFileSync(
    path.join(dir, "control-script.yaml"),
    [
      "planner:",
      "  value:",
      "    planMarkdown: |",
      "      ## Plan",
      "      1. Tweak x.",
      "executor:",
      "  implement:",
      "    summary: done",
      "    changes:",
      "      - op: update",
      "        path: lib/x.mjs",
      "        content: |",
      "          export const x = () => 3;",
      "    claimedDone: true",
      "    ranTests: false",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "treatment-script.yaml"),
    [
      "planner:",
      "  value:",
      "    plan:",
      "      tasks:",
      "        - id: T001",
      "          title: Double x",
      "          kind: modify",
      "          intent: return 2",
      "          dependsOn: []",
      "          satisfies: [SMK-001]",
      "          targets:",
      "            write: [lib/x.mjs]",
      "        - id: T002",
      "          title: Verify",
      "          kind: verify",
      "          intent: verify",
      "          dependsOn: [T001]",
      "          verifies: [SMK-001]",
      "    observations: []",
      "    assumptions: []",
      "    followups: []",
      "executor:",
      "  T001:",
      "    status: completed",
      "    summary: doubled",
      "    changes:",
      "      - op: update",
      "        path: lib/x.mjs",
      "        content: |",
      "          export function x() {",
      "            return 2;",
      "          }",
      "",
    ].join("\n"),
  );
}

describe("task loading", () => {
  it("loads and validates tasks", () => {
    writeSmokeTask(tmpRoot, "smoke-ok");
    const loaded = loadTask(path.join(tmpRoot, "smoke", "smoke-ok"));
    expect(loaded.task.id).toBe("smoke-ok");
    expect(loaded.task.groundTruth.forbidden).toEqual(["package.json"]);
  });

  it("rejects invalid task definitions", () => {
    const dir = path.join(tmpRoot, "invalid", "smoke-bad");
    mkdirSync(path.join(dir, "repo"), { recursive: true });
    writeFileSync(path.join(dir, "task.yaml"), "id: bad\ncategory: smoke\ntitle: t\ndescription: d\nspec: not: valid: yaml:\n");
    expect(() => loadTask(dir)).toThrow(/invalid|not valid/);
  });
});

describe("benchmark harness", () => {
  it("runs both arms, grades from withheld ground truth, writes reports", async () => {
    const outDir = path.join(tmpRoot, "out");
    const result = await runBenchmark({ tasksRoot: tmpRoot, outDir, trials: 1 });
    expect(result.mode).toBe("scripted");
    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    // Control implemented the wrong value but claimed done: false completion.
    expect(r.control.claimedDone).toBe(true);
    expect(r.control.completionRate).toBe(0);
    expect(r.control.falseCompletionDeclaration).toBe(true);
    // Treatment satisfied the requirement with no false claims.
    expect(r.treatment.status).toBe("succeeded");
    expect(r.treatment.completionRate).toBe(1);
    expect(r.treatment.falseCompletionDeclaration).toBe(false);

    const control = armTotals(result.results, "control");
    const treatment = armTotals(result.results, "treatment");
    expect(control.falseCompletions).toBe(1);
    expect(treatment.falseCompletions).toBe(0);

    const summary = renderSummary(result);
    expect(summary).toContain("# spc benchmark - scripted mode");
    expect(summary).toContain("| MUST requirement completion | 0% | 100% |");
    expect(summary).toContain("Interpretation caveat");
    // Reports persisted.
    expect(() => {
      rmSync(path.join(outDir, "summary.md"), { force: true });
    }).toBeDefined();
  }, 120_000);

  it("runs a real benchmark category end to end", async () => {
    const tasks = listTasks(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../tasks"), "feature-addition");
    expect(tasks.length).toBe(3);
    const outDir = path.join(tmpRoot, "out-feature");
    const result = await runBenchmark({ tasksRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../tasks"), outDir, category: "feature-addition" });
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => !r.error)).toBe(true);
    // The under-specified trap task blocks the treatment with a follow-up
    // instead of hallucinating; the control ships a hallucination.
    const trap = result.results.find((r) => r.taskId === "feat-log-levels");
    expect(trap?.trap).toBe("under-specified requirement");
    expect(trap?.treatment.status).toBe("blocked");
    expect(trap?.treatment.followupsRaised).toBe(1);
    expect(trap?.control.claimedDone).toBe(true);
  }, 300_000);
});
