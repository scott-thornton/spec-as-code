import { describe, expect, it } from "vitest";
import { buildPlannerPrompt } from "./prompts.js";
import { buildReplannerPrompt } from "./prompts.js";

const ir = {
  spec: { metadata: { id: "s", title: "t" }, goal: "g" },
  properties: [],
  digest: "sha256:" + "0".repeat(64),
} as never;

const snapshot = {
  revision: "r",
  dirty: false,
  languages: [],
  manifests: [],
  directories: [],
  tests: [],
  commands: {},
  relevantArtifacts: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  digest: "sha256:" + "0".repeat(64),
} as never;

describe("repair diagnostics render before the payload", () => {
  it("planner repair prompt leads with the rejection reason, not the repo dump", () => {
    const prompt = buildPlannerPrompt(
      { specIr: ir, snapshot, excerpts: [] },
      "SPC2004: property MUST-001 is not covered by any task; assign a task via satisfies",
    );
    const diagIndex = prompt.indexOf("SPC2004");
    const payloadIndex = prompt.indexOf('"spec"');
    expect(diagIndex).toBeGreaterThanOrEqual(0);
    expect(payloadIndex).toBeGreaterThanOrEqual(0);
    // The CHK3555 agent read "rejected with no stated reason" because the
    // reason sat after ~74KB of repository payload. Diagnostics lead now.
    expect(diagIndex).toBeLessThan(payloadIndex);
  });

  it("replanner repair prompt leads with the amendment diagnostics", () => {
    const prompt = buildReplannerPrompt({
      specIr: ir,
      plan: { apiVersion: "spc.dev/v1alpha1", kind: "Plan", metadata: { id: "p", createdAt: "n" }, spec: { id: "s", digest: "d" }, repository: { revision: "r", snapshotDigest: "d" }, tasks: [] } as never,
      taskStates: new Map(),
      triggeringObservations: [],
      amendmentDiagnostics: "SPC2011: changeTarget only allowed for tasks not completed",
    });
    const diagIndex = prompt.indexOf("SPC2011");
    const payloadIndex = prompt.indexOf('"spec"');
    expect(diagIndex).toBeGreaterThanOrEqual(0);
    expect(payloadIndex).toBeGreaterThanOrEqual(0);
    expect(diagIndex).toBeLessThan(payloadIndex);
  });
});
