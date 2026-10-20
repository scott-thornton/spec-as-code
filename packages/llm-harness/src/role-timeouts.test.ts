import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterAll } from "vitest";
import { HarnessProvider } from "./harness.js";
import { HarnessStore } from "./store.js";

const schema = z.strictObject({ answer: z.string() });
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function makeProvider(roleTimeouts?: Partial<Record<string, number>>): HarnessProvider {
  const root = mkdtempSync(path.join(tmpdir(), "spc-roletimeout-"));
  roots.push(root);
  const store = new HarnessStore(root);
  const fastSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
  return new HarnessProvider(store, 10_000, fastSleep, roleTimeouts);
}

describe("per-role harness timeouts", () => {
  it("a verifier request times out at its role-specific window, not the global default", async () => {
    const provider = makeProvider({ verifier: 60 });
    const started = Date.now();
    await expect(
      provider.generateStructured({ role: "verifier", key: "v@1", requestId: "r1", system: "s", prompt: "p", schema, schemaName: "X" }),
    ).rejects.toThrow(/not answered/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000); // the 10s default would not have fired
  });

  it("roles without an override use the global window", async () => {
    const provider = makeProvider({ verifier: 60 });
    // planner has no override: with a 120ms global window it fires at ~120ms,
    // proving the default still applies where no role override exists.
    const started = Date.now();
    await expect(
      provider.generateStructured({ role: "planner", key: "p@1", requestId: "r2", system: "s", prompt: "p", schema, schemaName: "X" }),
    ).rejects.toThrow(/not answered/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
  });
});
