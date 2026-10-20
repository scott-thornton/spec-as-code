import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { configSchema } from "@spc/schema";
import type { LLMProvider, StructuredRequest } from "@spc/llm";
import { verifyCriterion } from "./criteria.js";

const cwd = mkdtempSync(pathJoin(tmpdir(), "spc-verdictcache-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
function pathJoin(a: string, b: string): string {
  return `${a}/${b}`;
}

const DEFAULT_CONFIG = configSchema.parse({});
const property = {
  kind: "requirement",
  id: "VC-001",
  statement: "Judged property.",
  priority: "must",
  dependsOn: [],
  acceptance: [],
} as const;

function countingProvider(): { provider: LLMProvider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      name: "counting-fake",
      model: "fake",
      async generateStructured<T>(_request: StructuredRequest<T>) {
        n += 1;
        return { value: { outcome: "supports", justification: "looks right" } as unknown as T, usage: { model: "fake", durationMs: 1 } };
      },
    },
    calls: () => n,
  };
}

function ctx(overrides: Partial<Parameters<typeof verifyCriterion>[2]> = {}) {
  return {
    runId: "run-x",
    cwd,
    repositoryRevision: "rev1",
    config: DEFAULT_CONFIG,
    provider: null,
    ...overrides,
  };
}

describe("agent-verdict caching", () => {
  it("asks the verifier once per criterion per revision, reusing the verdict across sweeps", async () => {
    const { provider, calls } = countingProvider();
    const agentVerdicts = new Map();
    const criterion = { id: "VC-001-A", type: "agent" as const, instruction: "judge it" };
    const first = await verifyCriterion(criterion, property as never, ctx({ provider, agentVerdicts }));
    const second = await verifyCriterion(criterion, property as never, ctx({ provider, agentVerdicts }));
    expect(calls()).toBe(1);
    expect(first.evidence.outcome).toBe("supports");
    expect(second.evidence.outcome).toBe("supports");
    expect((second.evidence.payload as Record<string, unknown>).cachedVerdict).toBe(true);
  });

  it("a different revision is a different question - the cache does not cross it", async () => {
    const { provider, calls } = countingProvider();
    const agentVerdicts = new Map();
    const criterion = { id: "VC-001-B", type: "agent" as const, instruction: "judge it" };
    await verifyCriterion(criterion, property as never, ctx({ provider, agentVerdicts }));
    await verifyCriterion(criterion, property as never, ctx({ provider, agentVerdicts, repositoryRevision: "rev2" }));
    expect(calls()).toBe(2);
  });
});
