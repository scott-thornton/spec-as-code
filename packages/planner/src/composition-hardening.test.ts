import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LLMProvider } from "@spc/llm";
import { compileSpecFile } from "@spc/repo";
import { plannerOutputSchema } from "./schemas.js";
import { generatePlan } from "./planner.js";

// Oracle for specs/composition-hardening.yaml (planner half of CH-001 and
// CH-003): unsafe task-target paths are rejected at the schema layer, and
// plan-validation rejections are passed to the next attempt as
// previousRejection so the queue can surface them.
const tmp = mkdtempSync(path.join(tmpdir(), "spc-ch-planner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const output = (tasks: unknown[]) => ({ plan: { tasks }, observations: [], assumptions: [], followups: [] });
const task = (extra: Record<string, unknown>) => ({
  id: "T001",
  title: "t",
  kind: "modify",
  intent: "i",
  ...extra,
});

describe("task target paths are safe at the schema layer (CH-001)", () => {
  it("rejects an absolute path in targets.read", () => {
    const bad = output([task({ targets: { read: ["src/a.ts", "/tmp/x.ts"], write: ["src/**"] } })]);
    expect(plannerOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a path that escapes the repo", () => {
    const bad = output([task({ targets: { read: ["../escape.ts"], write: [] } })]);
    expect(plannerOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts safe relative paths", () => {
    const good = output([task({ targets: { read: ["src/a.ts"], write: ["src/**", "docs/*.md"] } })]);
    expect(plannerOutputSchema.safeParse(good).success).toBe(true);
  });
});

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ch-planner-fixture
  title: fixture
goal: fixture
requirements:
  - id: CHF-001
    statement: The gate passes.
    priority: must
    acceptance:
      - id: CHF-001-A
        type: command
        command: node gates.cjs
        discriminating: true
`;

describe("plan-validation rejection is passed to the next attempt (CH-003)", () => {
  it("plumbs previousRejection when validatePlan refuses the first answer", async () => {
    const specFile = path.join(tmp, "fixture.yaml");
    writeFileSync(specFile, SPEC, "utf8");
    const compiled = compileSpecFile(specFile);
    if (!compiled.ok || !compiled.ir) throw new Error("fixture spec does not compile");
    const snapshot = {
      revision: "r",
      dirty: false,
      languages: [],
      manifests: [],
      directories: [],
      tests: [],
      commands: {},
      relevantArtifacts: [],
      createdAt: "2026-10-22T00:00:00.000Z",
      digest: "sha256:" + "0".repeat(64),
    } as never;

    const calls: { previousRejection?: string }[] = [];
    let attempt = 0;
    const values = [
      // Attempt 1 covers no property: validatePlan must refuse it (SPC2004).
      output([task({})]),
      // Attempt 2 covers the property: accepted.
      output([task({ satisfies: ["CHF-001"] })]),
    ];
    const provider = {
      name: "fake",
      model: "fake",
      generateStructured: async (args: { previousRejection?: string }) => {
        calls.push(args);
        return { value: values[Math.min(attempt++, values.length - 1)], usage: {} };
      },
    } as unknown as LLMProvider;

    const result = await generatePlan({
      specIr: compiled.ir,
      snapshot,
      excerpts: [],
      provider,
      planId: "plan-ch-test-1",
    });

    expect(result.plan).not.toBeNull();
    expect(calls.length).toBe(2);
    expect(calls[0]!.previousRejection).toBeUndefined();
    expect(calls[1]!.previousRejection).toBeTruthy();
    expect(calls[1]!.previousRejection).toMatch(/CHF-001|SPC2004/);
  });
});
