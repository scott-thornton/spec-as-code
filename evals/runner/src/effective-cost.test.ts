import { describe, expect, it } from "vitest";
import { armTotals, renderSummary } from "./compare.js";
import type { TaskResult } from "./benchmark.js";

// Oracle for specs/effective-cost.yaml (EC2-001): the runner computes a
// cache-weighted effective input figure from the fields it already
// records - reads at 0.1x, writes at 1.25x (anthropic-family tariff) -
// so the next campaign reports cost multiples instead of raw token
// multiples. The row rides the cached-tokens silence rule.
function result(cacheRead: number, cacheCreation: number, tokensIn: number): TaskResult {
  const arm = {
    completionRate: 1,
    falseCompletionDeclaration: false,
    regressionsIntroduced: false,
    forbiddenChanges: [],
    patchSize: 10,
    modelCalls: 2,
    tokensIn,
    tokensOut: 10,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
  return {
    category: "smoke",
    taskId: "t",
    trial: 1,
    control: arm,
    treatment: { ...arm, replans: 0, followupsRaised: 0, status: "succeeded" },
  } as unknown as TaskResult;
}

describe("effective input tokens (EC2-001)", () => {
  it("computes the cache-weighted figure: uncached at 1x, reads at 0.1x, writes at 1.25x", () => {
    // 1000 in, 400 read, 100 created, 500 uncached:
    // 500 * 1 + 400 * 0.1 + 100 * 1.25 = 665.
    const totals = armTotals([result(400, 100, 1000)], "control");
    expect(totals.effectiveInputTokens).toBe(665);
  });

  it("renders the tariff-named row when cache activity exists and stays silent without it", () => {
    const withCache = renderSummary({ mode: "scripted", tasksRoot: "x", outDir: "y", trials: 1, generatedAt: "now", results: [result(400, 100, 1000)] } as never);
    expect(withCache).toMatch(/Effective input \(cache-weighted/);
    expect(withCache).toMatch(/0\.1x\/1\.25x/);
    expect(withCache).toContain("665");

    const silent = renderSummary({ mode: "scripted", tasksRoot: "x", outDir: "y", trials: 1, generatedAt: "now", results: [result(0, 0, 1000)] } as never);
    expect(silent).not.toMatch(/Effective input/);
  });
});
