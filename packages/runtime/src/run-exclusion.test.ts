import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EvidenceStore } from "./stores.js";
import { acquireExecutionLock, releaseExecutionLock, RUN_LOCK_HELD } from "./lock.js";

// Oracle for specs/run-exclusion.yaml: one live process per run (RX-001),
// and evidence appends that adopt the on-disk tail instead of an
// in-memory one (RX-002) - the run-mvix4mfx corruption, fenced.
const tmp = mkdtempSync(path.join(tmpdir(), "spc-runex-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function baseRecord(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    runId: "run-test",
    propertyRefs: ["RX-001"],
    kind: "test",
    outcome: "supports",
    producer: { type: "runtime" },
    timestamp: "2026-10-22T00:00:00.000Z",
    repositoryRevision: "0".repeat(40),
    payload: {},
    ...extra,
  };
}

describe("EvidenceStore.add adopts the on-disk tail (RX-002)", () => {
  it("a second writer continues the file's chain and id sequence", () => {
    const file = path.join(tmp, "evidence.jsonl");
    rmSync(file, { force: true });

    // Writer A: loads once, appends twice (ids minted by its callers).
    const a = new EvidenceStore(file);
    a.load();
    a.add(baseRecord("EV-0001") as never);
    const aLast = a.add(baseRecord("EV-0002") as never);

    // Writer B: a store instance that has seen NOTHING - the resumed or
    // concurrent process. Its append must chain onto the FILE tail and
    // continue the id sequence, not restart it.
    const b = new EvidenceStore(file);
    const bRecord = b.add(baseRecord("EV-0001", { propertyRefs: ["RX-002"] }) as never);

    expect(bRecord.id).not.toBe("EV-0001");
    expect(bRecord.chain).toBe(aLast.digest);

    // The resulting log loads cleanly - no duplicate ids, no chain break.
    const check = new EvidenceStore(file);
    expect(() => check.load()).not.toThrow();
    const ids = check.all().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a fresh store on an existing file starts from the file's tail, not from genesis", () => {
    const file = path.join(tmp, "evidence-tail.jsonl");
    rmSync(file, { force: true });
    const a = new EvidenceStore(file);
    a.load();
    a.add(baseRecord("EV-0001") as never);
    const last = a.add(baseRecord("EV-0002") as never);

    const b = new EvidenceStore(file);
    const rec = b.add(baseRecord("EV-0003") as never);
    expect(rec.chain).toBe(last.digest);
    const raw = readFileSync(file, "utf8").trim().split("\n");
    expect(raw.length).toBe(3);
    const check = new EvidenceStore(file);
    expect(() => check.load()).not.toThrow();
  });
});

describe("run execution lock (RX-001)", () => {
  it("acquires when free, refuses a live holder, takes over a dead one", () => {
    const runDir = path.join(tmp, "run-lock");
    rmSync(runDir, { recursive: true, force: true });
    writeFileSync(path.join(tmp, "marker"), "ensure tmp"); // keep tmp alive on cleanup races

    const first = acquireExecutionLock(runDir, process.pid, () => new Date().toISOString());
    expect(first.ok).toBe(true);

    // A LIVE holder (this process) must be refused.
    const second = acquireExecutionLock(runDir, process.pid, () => new Date().toISOString());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe(RUN_LOCK_HELD);
      expect(String(second.holderPid)).toBe(String(process.pid));
    }

    releaseExecutionLock(runDir);
    const third = acquireExecutionLock(runDir, process.pid, () => new Date().toISOString());
    expect(third.ok).toBe(true);

    // A dead pid's lock is stale: taken over.
    releaseExecutionLock(runDir);
    writeFileSync(
      path.join(runDir, "execution.lock"),
      JSON.stringify({ pid: 999999999, at: new Date().toISOString(), command: "spc apply" }),
      "utf8",
    );
    const fourth = acquireExecutionLock(runDir, process.pid, () => new Date().toISOString());
    expect(fourth.ok).toBe(true);

    // An old-but-alive lock (older than the stale window) is taken over.
    releaseExecutionLock(runDir);
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeFileSync(
      path.join(runDir, "execution.lock"),
      JSON.stringify({ pid: process.pid, at: old, command: "spc apply" }),
      "utf8",
    );
    const fifth = acquireExecutionLock(runDir, process.pid, () => new Date().toISOString());
    expect(fifth.ok).toBe(true);
    releaseExecutionLock(runDir);
  });
});
