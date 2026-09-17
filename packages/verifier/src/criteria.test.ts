import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type DesiredProperty } from "@spc/schema";
import type { Evidence, LLMProvider, StructuredRequest, StructuredResponse } from "@spc/llm";
import { verifyCriterion } from "./criteria.js";
import { evaluateProperty } from "./evaluate.js";

const cwd = mkdtempSync(path.join(tmpdir(), "spc-verify-"));

const property: DesiredProperty = {
  kind: "requirement",
  id: "GREETING-001",
  statement: "Greeting works.",
  priority: "must",
  dependsOn: [],
  acceptance: [],
};

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

describe("command criterion", () => {
  it("supports on expected exit code", async () => {
    const r = await verifyCriterion(
      { id: "GREETING-001-A", type: "command", command: "node -e \"console.log('ok')\"", expect: { exitCode: 0 } },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("supports");
    expect(r.evidence.kind).toBe("command");
    expect(r.evidence.payload).toMatchObject({ exitCode: 0 });
    expect(r.evidence.digest).toMatch(/^sha256:/);
    expect(r.commandRun?.allowed).toBe(true);
  });

  it("classifies test-runner commands as kind test", async () => {
    const r = await verifyCriterion(
      { id: "GREETING-001-A", type: "command", command: "node --test tests/" },
      property,
      ctx(),
    );
    expect(r.evidence.kind).toBe("test");
  });

  it("contradicts on failing exit code", async () => {
    const r = await verifyCriterion(
      { id: "GREETING-001-A", type: "command", command: "node -e \"process.exit(1)\"" },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("contradicts");
  });

  it("records evidence provenance and criterion linkage", async () => {
    const r = await verifyCriterion(
      { id: "GREETING-001-A", type: "command", command: "node -e \"0\"" },
      property,
      ctx(),
    );
    expect(r.evidence.criterionId).toBe("GREETING-001-A");
    expect(r.evidence.propertyRefs).toEqual(["GREETING-001"]);
    expect(r.evidence.producer).toEqual({ type: "runtime" });
  });

  it("denied commands are inconclusive, not unsatisfied", async () => {
    const r = await verifyCriterion(
      { id: "GREETING-001-A", type: "command", command: "curl https://example.com" },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("inconclusive");
    expect(r.followUp?.type).toBe("investigation");
  });
});

describe("file criterion", () => {
  writeFileSync(path.join(cwd, "present.txt"), "hello spc\n");

  it("supports when file exists", async () => {
    const r = await verifyCriterion(
      { id: "G-1-A", type: "file", path: "present.txt", assert: { exists: true } },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("supports");
  });

  it("contradicts when file is absent", async () => {
    const r = await verifyCriterion(
      { id: "G-1-A", type: "file", path: "missing.txt", assert: { exists: true } },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("contradicts");
  });

  it("checks contains and notContains", async () => {
    const good = await verifyCriterion(
      { id: "G-1-A", type: "file", path: "present.txt", assert: { contains: "hello" } },
      property,
      ctx(),
    );
    expect(good.evidence.outcome).toBe("supports");
    const bad = await verifyCriterion(
      { id: "G-1-A", type: "file", path: "present.txt", assert: { notContains: "hello" } },
      property,
      ctx(),
    );
    expect(bad.evidence.outcome).toBe("contradicts");
  });
});

const fakeProvider: LLMProvider = {
  name: "fake-inline",
  model: "fake",
  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const value = { outcome: "supports", justification: "looks right" };
    return { value: value as unknown as T, usage: { model: "fake", durationMs: 0 } };
  },
};

describe("agent criterion", () => {
  it("uses provider verdict as model-derived evidence", async () => {
    const r = await verifyCriterion(
      { id: "G-1-A", type: "agent", instruction: "Check token storage." },
      property,
      ctx({ provider: fakeProvider }),
    );
    expect(r.evidence.kind).toBe("agent");
    expect(r.evidence.outcome).toBe("supports");
    expect(r.evidence.producer).toEqual({ type: "agent", identity: "fake-inline" });
  });

  it("without a provider: inconclusive evidence plus investigation follow-up", async () => {
    const r = await verifyCriterion(
      { id: "G-1-A", type: "agent", instruction: "Check token storage." },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("inconclusive");
    expect(r.followUp?.type).toBe("investigation");
  });
});

describe("human criterion", () => {
  it("produces inconclusive evidence and a manual_verification follow-up", async () => {
    const r = await verifyCriterion(
      { id: "G-1-A", type: "human", instruction: "Review the UX." },
      property,
      ctx(),
    );
    expect(r.evidence.outcome).toBe("inconclusive");
    expect(r.followUp?.type).toBe("manual_verification");
    expect(r.followUp?.blocking).toBe(false);
    expect(r.followUp?.options?.map((o) => o.id)).toEqual(["confirm", "reject"]);
  });
});

function evidence(
  id: string,
  criterionId: string | undefined,
  outcome: Evidence["outcome"],
  kind: Evidence["kind"] = "command",
  timestamp = "2026-09-17T00:00:00.000Z",
  payload: unknown = {},
): Evidence {
  return {
    id,
    runId: "run-x",
    criterionId,
    propertyRefs: [property.id],
    kind,
    outcome,
    producer: { type: "runtime" },
    timestamp,
    repositoryRevision: "rev1",
    payload,
    digest: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
  };
}

describe("requirement satisfaction evaluator", () => {
  const prop: DesiredProperty = {
    ...property,
    acceptance: [
      { id: "P-A", type: "command", command: "node --test" },
      { id: "P-B", type: "file", path: "x", assert: { exists: true } },
    ],
  };

  it("unknown when nothing evaluated", () => {
    const s = evaluateProperty(prop, [], { allowAgentOnly: false });
    expect(s.status).toBe("unknown");
  });

  it("in_progress overlay when tasks are in flight", () => {
    const s = evaluateProperty(prop, [], {
      allowAgentOnly: false,
      inProgressPropertyIds: new Set([prop.id]),
    });
    expect(s.status).toBe("in_progress");
  });

  it("satisfied when all criteria pass", () => {
    const s = evaluateProperty(
      prop,
      [evidence("e1", "P-A", "supports"), evidence("e2", "P-B", "supports")],
      { allowAgentOnly: false },
    );
    expect(s.status).toBe("satisfied");
    expect(s.evidenceIds).toEqual(["e1", "e2"]);
  });

  it("unsatisfied when any authoritative check contradicts", () => {
    const s = evaluateProperty(
      prop,
      [evidence("e1", "P-A", "supports"), evidence("e2", "P-B", "contradicts")],
      { allowAgentOnly: false },
    );
    expect(s.status).toBe("unsatisfied");
    expect(s.reason).toContain("P-B");
  });

  it("contradictory evidence retained: newest evidence per criterion wins, older kept in store", () => {
    const s = evaluateProperty(
      prop,
      [evidence("e1", "P-A", "contradicts", "command", "2026-09-17T01:00:00.000Z"), evidence("e2", "P-B", "supports")],
      { allowAgentOnly: false },
    );
    expect(s.status).toBe("unsatisfied");
  });

  it("indeterminate while human verification is outstanding", () => {
    const humanProp: DesiredProperty = {
      ...property,
      acceptance: [{ id: "H-A", type: "human", instruction: "review" }],
    };
    const s = evaluateProperty(humanProp, [evidence("e1", "H-A", "inconclusive", "human")], {
      allowAgentOnly: false,
    });
    expect(s.status).toBe("indeterminate");
  });

  it("agent-only evidence is indeterminate unless explicitly allowed", () => {
    const agentProp: DesiredProperty = {
      ...property,
      acceptance: [{ id: "AG-A", type: "agent", instruction: "review" }],
    };
    const ev = [evidence("e1", "AG-A", "supports", "agent")];
    expect(evaluateProperty(agentProp, ev, { allowAgentOnly: false }).status).toBe("indeterminate");
    const s = evaluateProperty(agentProp, ev, { allowAgentOnly: true });
    expect(s.status).toBe("satisfied");
    expect(s.weakEvidence).toBe(true);
  });

  it("human waiver overrides evaluation", () => {
    const s = evaluateProperty(
      prop,
      [evidence("e1", "P-A", "contradicts"), evidence("w", undefined, "supports", "human", "2026-09-17T02:00:00.000Z", { waive: true })],
      { allowAgentOnly: false },
    );
    expect(s.status).toBe("waived");
  });
});

afterAll(() => rmSync(cwd, { recursive: true, force: true }));
