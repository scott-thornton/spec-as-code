import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessProvider } from "./harness.js";
import { HarnessStore } from "./store.js";

const schema = z.strictObject({ answer: z.string() });

let roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeProvider(): { provider: HarnessProvider; store: HarnessStore } {
  const root = mkdtempSync(path.join(tmpdir(), "spc-layout-"));
  roots.push(root);
  const store = new HarnessStore(root);
  const fastSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
  return { provider: new HarnessProvider(store, 5_000, fastSleep), store };
}

function firstPending(store: HarnessStore) {
  const tick = new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if (store.listPending().length > 0) {
        clearInterval(iv);
        resolve();
      }
    }, 1);
    setTimeout(() => {
      clearInterval(iv);
      resolve();
    }, 2_000);
  });
  return tick.then(() => store.listPending()[0]!);
}

describe("harness request layout", () => {
  it("places the respond instructions BEFORE the model-facing prompt, not appended after it", async () => {
    const { provider, store } = makeProvider();
    const generation = provider.generateStructured({
      role: "planner",
      key: "planner@1",
      requestId: "r1",
      system: "sys",
      prompt: "PLAN-PAYLOAD-MARKER plan the thing with lots of bytes",
      schema,
      schemaName: "PlannerOutput",
    });
    const pending = await firstPending(store);
    const instructionIndex = pending.prompt.indexOf("harness instructions");
    const payloadIndex = pending.prompt.indexOf("PLAN-PAYLOAD-MARKER");
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(payloadIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeLessThan(payloadIndex);
    void generation.catch(() => undefined);
  });
});
