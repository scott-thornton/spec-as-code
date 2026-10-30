import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessProvider } from "./harness.js";
import { HarnessStore } from "./store.js";

// Oracle for specs/window-recalibration.yaml: windows sized for the
// field. WT-001: role-weighted built-ins (executor 60m, planner and
// replanner 40m, verifier and unlisted roles 30m global) with the full
// precedence matrix - explicit per-role map beats everything, explicit
// global beats the built-in role weights, built-ins apply only where
// the config says nothing - and the effective window lands in the
// dispatched request's expiresAt. WT-004: the stale sweep never retires
// a stamped request whose window is still open, however old it is
// (executor windows at 60m meet the one-hour sweep head-on).
const root = mkdtempSync(path.join(tmpdir(), "spc-windowdefs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let t = Date.now();
const now = (): number => t;

/** Dispatch with a role and capture the request mid-flight; returns
 *  expiresAt - createdAt (the effective window actually stamped). The
 *  provider is constructed WITH this sleep - real-spaced ticks, fake
 *  clock advancing per tick - so the loop is bounded no matter what. */
async function stampedWindow(role: string, key: string, timeoutMs: number, roleTimeouts?: Partial<Record<string, number>>): Promise<number> {
  const store = new HarnessStore(root, now);
  // requestId joins role-key-invocation with hyphens (the @ in real ids
  // lives inside the key itself, e.g. T001@1).
  const id = `${role}-${key}-1`;
  let captured: number | undefined;
  const sleep = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    t += 1000;
    if (captured === undefined) {
      const request = JSON.parse(readFileSync(path.join(root, ".spc", "harness", "pending", `${id}.json`), "utf8")) as { createdAt: string; expiresAt: string };
      captured = Date.parse(request.expiresAt) - Date.parse(request.createdAt);
      store.answer(id, { ok: true });
    }
  };
  const provider = new HarnessProvider(store, timeoutMs, sleep, now, roleTimeouts);
  await provider.generateStructured({
    role: role as never,
    key,
    requestId: `r-${key}`,
    system: "s",
    prompt: "p",
    schema: z.object({ ok: z.boolean() }),
    schemaName: "TestOut",
  });
  return captured!;
}

describe("window defaults (WT-001)", () => {
  it("built-ins are role-weighted: executor 60m, planner/replanner 40m, verifier and unlisted 30m", { timeout: 60_000 }, async () => {
    expect(await stampedWindow("executor", "W1", 30 * 60_000)).toBe(3_600_000);
    expect(await stampedWindow("planner", "W2", 30 * 60_000)).toBe(2_400_000);
    expect(await stampedWindow("replanner", "W3", 30 * 60_000)).toBe(2_400_000);
    expect(await stampedWindow("verifier", "W4", 30 * 60_000)).toBe(1_800_000);
    expect(await stampedWindow("some-new-role", "W5", 30 * 60_000)).toBe(1_800_000);
  });

  it("explicit per-role map beats everything; explicit global beats the built-in role weights", { timeout: 60_000 }, async () => {
    expect(await stampedWindow("executor", "W6", 120_000, { executor: 60_000 })).toBe(60_000);
    expect(await stampedWindow("verifier", "W7", 120_000, { executor: 60_000 })).toBe(120_000);
    expect(await stampedWindow("planner", "W8", 120_000, { executor: 60_000 })).toBe(120_000);
  });
});

describe("sweep respects open windows (WT-004)", () => {
  it("never retires a stamped request whose window is still open, however old", () => {
    const store = new HarnessStore(root, now);
    mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
    const put = (id: string, createdAt: string, expiresAt?: string) =>
      writeFileSync(
        path.join(root, ".spc", "harness", "pending", `${id}.json`),
        JSON.stringify({ id, role: "executor", key: "x@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt, ...(expiresAt ? { expiresAt } : {}) }),
        "utf8",
      );
    const twoHoursAgo = new Date(t - 2 * 60 * 60_000).toISOString();
    put("executor-OPEN@1-1", twoHoursAgo, new Date(t + 60_000).toISOString());
    put("executor-UNSTAMPED@1-1", twoHoursAgo);
    put("executor-ELAPSED@1-1", twoHoursAgo, new Date(t - 60_000).toISOString());
    expect(store.sweepStale(60 * 60_000)).toBe(2); // unstamped + elapsed
    expect(store.getRequest("executor-OPEN@1-1")?.id).toBe("executor-OPEN@1-1");
    expect(store.getRequest("executor-UNSTAMPED@1-1")).toBeNull();
    expect(store.getRequest("executor-ELAPSED@1-1")).toBeNull();
  });
});
