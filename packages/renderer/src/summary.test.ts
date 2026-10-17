import { describe, expect, it } from "vitest";
import type { Evidence, FollowUp, RunState, SpecIR } from "@spc/schema";
import { renderRunSummary } from "./summary.js";

const specIr = {
  spec: { metadata: { id: "s", title: "t" }, goal: "g" },
  properties: [],
  digest: `sha256:${"0".repeat(64)}`,
} as unknown as SpecIR;

const runState = { runId: "run-1", status: "succeeded", tasks: {}, requirements: {} } as unknown as RunState;

function render(planDrift?: Parameters<typeof renderRunSummary>[0]["planDrift"]): string {
  return renderRunSummary({
    specIr,
    runState,
    followups: [] as FollowUp[],
    evidence: [] as Evidence[],
    ...(planDrift ? { planDrift } : {}),
  });
}

describe("run summary plan drift section", () => {
  it("renders the section when drift data is provided", () => {
    const out = render({
      originalTaskCount: 3,
      tasksAdded: 2,
      tasksRemoved: 1,
      replans: 1,
      filesChanged: 7,
      filesOutsideOriginalTargets: ["src/unplanned.ts"],
    });
    expect(out).toContain("## Plan drift");
    expect(out).toContain("3 planned task(s); 2 added, 1 removed across 1 replan(s)");
    expect(out).toContain("7 file(s) changed; 1 outside original write targets");
    expect(out).toContain("- src/unplanned.ts");
  });

  it("omits the section when no drift data is provided", () => {
    expect(render()).not.toContain("## Plan drift");
  });
});
