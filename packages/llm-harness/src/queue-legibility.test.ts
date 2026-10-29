import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessProvider } from "./harness.js";
import { HarnessStore, requestState } from "./store.js";

// Oracle for specs/queue-legibility.yaml (QL-001 stamps, QL-002 refuses,
// QL-003 serializes; store half of QL-005 cancel): the slerp incident as
// executable predicates. An agent answered an orphaned request forever
// because answer() checked only that the pending file existed. Every
// move that agent made must now hit a refusal with a next move in it.
const root = mkdtempSync(path.join(tmpdir(), "spc-queuelegibility-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Shared fake clock: the store guards classify on the same clock the
// provider stamps with, so window arithmetic is exact in tests.
let t = Date.parse("2026-10-29T10:00:00.000Z");
const now = (): number => t;
const iso = (offsetMs: number): string => new Date(t + offsetMs).toISOString();

function putRequest(overrides: Record<string, unknown> & { id: string }): void {
  mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
  const base = {
    role: "executor",
    key: "x@1",
    schemaName: "ExecutorResult",
    jsonSchema: { type: "object" },
    system: "s",
    prompt: "p",
    createdAt: new Date(t).toISOString(),
  };
  writeFileSync(path.join(root, ".spc", "harness", "pending", `${overrides.id}.json`), JSON.stringify({ ...base, ...overrides }), "utf8");
}

function readRequest(id: string, dir = "pending"): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, ".spc", "harness", dir, `${id}.json`), "utf8")) as Record<string, unknown>;
}

describe("queue legibility (store)", () => {
  it("stamps: dispatch writes expiresAt from the poll window and runId when the context has one", async () => {
    const store = new HarnessStore(root, now);
    const captured: Record<string, unknown>[] = [];
    // Each poll tick advances the clock one interval, like real time.
    // The answer must land INSIDE the window - the loop polls on the
    // same fake clock, so answering after it would be answering a dead
    // request (which the guards in QL-002 will refuse).
    const sleep = async (): Promise<void> => {
      t += 1000;
      if (captured.length === 0) captured.push(readRequest("executor-T001@1-1"));
      else store.answer("executor-T001@1-1", { ok: true });
    };
    const provider = new HarnessProvider(store, 3000, sleep, now);
    const response = await provider.generateStructured({
      role: "executor",
      key: "T001@1",
      requestId: "r1",
      system: "s",
      prompt: "p",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "TestOut",
      runId: "run-abc",
    });
    expect(response.value).toEqual({ ok: true });
    const request = captured[0]!;
    expect(Date.parse(request.expiresAt as string)).toBe(Date.parse(request.createdAt as string) + 3000);
    expect(request.runId).toBe("run-abc");
  });

  it("stamps: a role timeout overrides the global window in the stamp", async () => {
    const store = new HarnessStore(root, now);
    const captured: Record<string, unknown>[] = [];
    const sleep = async (): Promise<void> => {
      t += 1000;
      if (captured.length === 0) captured.push(readRequest("executor-T002@1-1"));
      else store.answer("executor-T002@1-1", { ok: true });
    };
    const provider = new HarnessProvider(store, 3000, sleep, now, { executor: 60_000 });
    await provider.generateStructured({
      role: "executor",
      key: "T002@1",
      requestId: "r2",
      system: "s",
      prompt: "p",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "TestOut",
    });
    const request = captured[0]!;
    expect(Date.parse(request.expiresAt as string) - Date.parse(request.createdAt as string)).toBe(60_000);
    expect(request.runId).toBeUndefined();
  });

  it("stamps: an invalid answer requeues with a refreshed expiresAt and unchanged createdAt", async () => {
    const store = new HarnessStore(root, now);
    const versions: Record<string, unknown>[] = [];
    const sleep = async (): Promise<void> => {
      t += 1000;
      if (versions.length === 0) {
        versions.push(readRequest("executor-T003@1-1"));
        store.answer("executor-T003@1-1", { ok: "not a boolean" });
      } else if (versions.length === 1) {
        versions.push(readRequest("executor-T003@1-1"));
        store.answer("executor-T003@1-1", { ok: true });
      }
    };
    const provider = new HarnessProvider(store, 3000, sleep, now);
    await provider.generateStructured({
      role: "executor",
      key: "T003@1",
      requestId: "r3",
      system: "s",
      prompt: "p",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "TestOut",
    });
    const [before, after] = versions as [{ createdAt: string; expiresAt: string }, { createdAt: string; expiresAt: string; lastError: string }];
    expect(after.createdAt).toBe(before.createdAt);
    // Refreshed: the deadline moved strictly forward (anchored at the
    // requeue instant, one poll interval in), not still the dispatch
    // deadline.
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
    expect(after.lastError).toBeTruthy();
  });

  it("stamps: requeueWithFeedback without a window leaves the deadline alone", () => {
    const store = new HarnessStore(root, now);
    const deadline = iso(1000);
    putRequest({ id: "executor-T004@1-1", expiresAt: deadline });
    t += 5000;
    store.requeueWithFeedback("executor-T004@1-1", "boom");
    expect(readRequest("executor-T004@1-1").expiresAt).toBe(deadline);
  });

  it("stamps: requestState derives live, elapsed, and window-unknown; unstamped stays legal", () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-LIVE@1-1", expiresAt: iso(5000) });
    putRequest({ id: "executor-DEAD@1-1", expiresAt: iso(-1000) });
    putRequest({ id: "executor-LEGACY@1-1" });
    expect(requestState(store.getRequest("executor-LIVE@1-1")!, now())).toBe("live");
    expect(requestState(store.getRequest("executor-DEAD@1-1")!, now())).toBe("elapsed");
    expect(requestState(store.getRequest("executor-LEGACY@1-1")!, now())).toBe("unknown");
    // No expiresAt, no guard: the legacy request is answerable until the
    // one-hour sweep retires it (classification never upgrades unknown to
    // expired).
    expect(store.answer("executor-LEGACY@1-1", { ok: true }).id).toBe("executor-LEGACY@1-1");
  });

  it("refuses: answer on an elapsed window throws REQUEST_WINDOW_ELAPSED with the next moves, and writes nothing", () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-ELAPSED@1-1", expiresAt: iso(-60_000) });
    expect(() => store.answer("executor-ELAPSED@1-1", { ok: true })).toThrow(/REQUEST_WINDOW_ELAPSED/);
    expect(() => store.answer("executor-ELAPSED@1-1", { ok: true })).toThrow(/stopped consuming/);
    expect(() => store.answer("executor-ELAPSED@1-1", { ok: true })).toThrow(/save-candidate/);
    expect(existsSync(path.join(root, ".spc", "harness", "answered", "executor-ELAPSED@1-1.json"))).toBe(false);
  });

  it("refuses: a duplicate submission without lastError throws REQUEST_ALREADY_ANSWERED and declares nothing dead while the window is open", () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-DUP@1-1", expiresAt: iso(10_000) });
    const first = store.answer("executor-DUP@1-1", { ok: true });
    expect(() => store.answer("executor-DUP@1-1", { ok: false })).toThrow(/REQUEST_ALREADY_ANSWERED/);
    try {
      store.answer("executor-DUP@1-1", { ok: false });
    } catch (e) {
      const message = (e as Error).message;
      // Submitted, not consumed - and no death declaration while the
      // window is open: the run may still be polling.
      expect(message).toMatch(/not been consumed/);
      expect(message).toMatch(/may still/);
      expect(message).not.toMatch(/dead/);
    }
    // The refusal protected the record: the first answer stands.
    expect(store.getAnswer("executor-DUP@1-1")?.answeredAt).toBe(first.answeredAt);
  });

  it("refuses: a rejected answer (lastError) still accepts the corrected retry", () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-RETRY@1-1", expiresAt: iso(10_000), lastError: "ok: expected boolean" });
    store.answer("executor-RETRY@1-1", { ok: "bad" });
    // The rejection invites a new answer: the overwrite is the intent.
    expect(store.answer("executor-RETRY@1-1", { ok: true }).value).toEqual({ ok: true });
  });

  it("refuses: the missing-request error names both resolutions", () => {
    const store = new HarnessStore(root, now);
    expect(() => store.answer("executor-GONE@1-1", { ok: true })).toThrow(/consumed/);
    expect(() => store.answer("executor-GONE@1-1", { ok: true })).toThrow(/retired/);
  });

  it("serializes: answer waits out a competing lock holder, then writes", async () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-LOCKED@1-1", expiresAt: iso(60_000) });
    // An external process holds the store lock for 400ms: mkdir the lock
    // dir, wait, remove it. Same protocol, no imports needed. The answer
    // below starts while the holder still holds - it must wait for the
    // release instead of writing under the holder.
    const child = spawn(
      process.execPath,
      ["-e", `const fs=require("fs");const p=${JSON.stringify(path.join(root, ".spc", "harness", ".lock"))};fs.mkdirSync(p);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);fs.rmdirSync(p);`],
      { stdio: "ignore" },
    );
    await new Promise((r) => setTimeout(r, 120));
    const started = Date.now();
    expect(store.answer("executor-LOCKED@1-1", { ok: true }).id).toBe("executor-LOCKED@1-1");
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(existsSync(path.join(root, ".spc", "harness", "answered", "executor-LOCKED@1-1.json"))).toBe(true);
    // The holder's clean exit is awaited, not assumed: answer returning
    // proves the lock was RELEASED, and only then can the holder exit.
    const code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.on("exit", (c) => resolve(c));
    });
    expect(code).toBe(0);
  }, { timeout: 15_000 });

  it("serializes: a crashed lock holder is broken after the stale threshold", () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-STALELOCK@1-1", expiresAt: iso(60_000) });
    const lockDir = path.join(root, ".spc", "harness", ".lock");
    mkdirSync(lockDir);
    const ancient = new Date(Date.now() - 60_000);
    utimesSync(lockDir, ancient, ancient);
    // Must not wait out the retry budget for a lock nobody will release.
    const started = Date.now();
    expect(store.answer("executor-STALELOCK@1-1", { ok: true }).id).toBe("executor-STALELOCK@1-1");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("serializes: reads stay lock-free while a holder holds", () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-READ@1-1", expiresAt: iso(60_000) });
    const lockDir = path.join(root, ".spc", "harness", ".lock");
    mkdirSync(lockDir);
    try {
      const started = Date.now();
      expect(store.getRequest("executor-READ@1-1")?.id).toBe("executor-READ@1-1");
      expect(store.listPending().length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  it("cancel: expireForRun retires only the named run's stamped requests, keeping records", () => {
    const store = new HarnessStore(root, now);
    putRequest({ id: "executor-C1@1-1", expiresAt: iso(60_000), runId: "run-cancel-me" });
    putRequest({ id: "executor-C2@1-1", expiresAt: iso(60_000), runId: "run-cancel-me" });
    putRequest({ id: "executor-C3@1-1", expiresAt: iso(60_000), runId: "run-other" });
    putRequest({ id: "executor-C4@1-1", expiresAt: iso(60_000) });
    const retired = store.expireForRun("run-cancel-me");
    expect(retired.sort()).toEqual(["executor-C1@1-1", "executor-C2@1-1"]);
    expect(readRequest("executor-C1@1-1", "stale").runId).toBe("run-cancel-me");
    expect(store.getRequest("executor-C3@1-1")?.id).toBe("executor-C3@1-1");
    expect(store.getRequest("executor-C4@1-1")?.id).toBe("executor-C4@1-1");
  });
});
