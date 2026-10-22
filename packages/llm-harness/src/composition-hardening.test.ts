import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessProvider } from "./harness.js";
import { HarnessStore } from "./store.js";

// Oracle for specs/composition-hardening.yaml (harness half of CH-003):
// a request dispatched with previousRejection seeds the pending request's
// lastError, so spc agent list shows "retry needed" for plan-validation
// rejections, not only schema rejections.
const schema = z.strictObject({ answer: z.string() });

function makeProvider(timeoutMs = 60_000): { provider: HarnessProvider; store: HarnessStore } {
  const root = mkdtempSync(path.join(tmpdir(), "spc-ch-harness-"));
  const store = new HarnessStore(root);
  const fastSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
  return { provider: new HarnessProvider(store, timeoutMs, fastSleep), store };
}

const request = {
  role: "planner" as const,
  key: "planner@2",
  requestId: "r2",
  system: "sys",
  prompt: "plan the thing",
  schema,
  schemaName: "PlannerOutput",
};

describe("previousRejection seeds lastError (CH-003)", () => {
  it("the retried request carries the plan-validation rejection visibly", async () => {
    const { provider, store } = makeProvider();
    const pending = provider.generateStructured({
      ...request,
      previousRejection: "SPC2004: property CHF-001 is not covered by any task; assign a task via satisfies",
    });
    await new Promise((r) => setTimeout(r, 30));
    const queued = store.listPending();
    expect(queued.length).toBe(1);
    expect(queued[0]!.lastError ?? "").toContain("SPC2004");
    expect(queued[0]!.lastError ?? "").toContain("CHF-001");

    store.answer(queued[0]!.id, { answer: "ok" }, "test");
    const result = await pending;
    expect(result.value).toEqual({ answer: "ok" });
  });
});
