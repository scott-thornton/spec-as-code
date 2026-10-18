import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvidenceStore, FollowupStore, ObservationStore } from "./stores.js";
import { digestOf } from "@spc/core";
import { EventStore } from "./events.js";
import { applyEvent, initialState, projectState } from "./state.js";
import type { Plan } from "@spc/schema";

const dir = mkdtempSync(path.join(tmpdir(), "spc-stores-"));

function evidenceBase(outcome: "supports" | "contradicts", criterionId: string) {
  return {
    runId: "run-1",
    criterionId,
    propertyRefs: ["AUTH-001"],
    kind: "command" as const,
    outcome,
    producer: { type: "runtime" as const },
    timestamp: "2026-09-17T00:00:00.000Z",
    repositoryRevision: "r1",
    payload: { exitCode: outcome === "supports" ? 0 : 1 },
  };
}

describe("evidence store", () => {
  it("is append-only with sequential ids and digests", () => {
    const store = new EvidenceStore(path.join(dir, "evidence.jsonl"));
    const e1 = store.add({ id: "EV-0001", ...evidenceBase("supports", "AUTH-001-A") });
    const e2 = store.add({ id: "EV-0002", ...evidenceBase("supports", "AUTH-001-A") });
    expect(e1.digest).toMatch(/^sha256:/);
    expect(e1.id).toBe("EV-0001");
    expect(e2.id).toBe("EV-0002");
  });

  it("retains contradictory evidence", () => {
    const file = path.join(dir, "evidence-contradiction.jsonl");
    const store = new EvidenceStore(file);
    store.add({ id: "EV-0001", ...evidenceBase("supports", "AUTH-001-A") });
    store.add({ id: "EV-0002", ...evidenceBase("contradicts", "AUTH-001-A") });
    const reloaded = new EvidenceStore(file);
    reloaded.load();
    expect(reloaded.all()).toHaveLength(2);
    expect(reloaded.forProperty("AUTH-001")).toHaveLength(2);
  });
});

describe("follow-up store", () => {
  it("creates, persists and resolves follow-ups", () => {
    const file = path.join(dir, "followups.json");
    const store = new FollowupStore(file);
    const f = store.create(
      {
        type: "spec_clarification",
        blocking: true,
        title: "Clarify X",
        description: "d",
      },
      "run-1",
    );
    expect(f.id).toBe("F-001");
    expect(store.openBlocking()).toHaveLength(1);
    store.resolve("F-001", { optionId: "b" });
    expect(store.openBlocking()).toHaveLength(0);
    const reloaded = new FollowupStore(file);
    reloaded.load();
    expect(reloaded.all()[0]?.status).toBe("resolved");
    expect(reloaded.all()[0]?.resolution?.optionId).toBe("b");
  });
});

describe("observation store", () => {
  it("assigns sequential OBS ids and reloads", () => {
    const file = path.join(dir, "observations.jsonl");
    const store = new ObservationStore(file);
    store.add({ type: "architecture", statement: "wrong location", confidence: "confirmed", invalidates: { taskIds: ["T001"] } }, "run-1");
    const reloaded = new ObservationStore(file);
    reloaded.load();
    expect(reloaded.all()[0]?.id).toBe("OBS-001");
    expect(reloaded.all()[0]?.invalidates?.taskIds).toEqual(["T001"]);
  });
});

describe("event store and state projection", () => {
  it("appends persistently with sequence numbers and folds into state", () => {
    const file = path.join(dir, "events.jsonl");
    const events = new EventStore(file, "run-1");
    events.append("RUN_CREATED", { specId: "s" });
    events.append("TASK_READY", { taskId: "T001", attempt: 1 });
    events.append("TASK_STARTED", { taskId: "T001", attempt: 1 });
    events.append("TASK_COMPLETED", { taskId: "T001", attempt: 1 });
    events.append("PROPERTY_VERIFIED", { propertyId: "AUTH-001", status: "satisfied", evidenceIds: ["EV-0001"] });
    events.append("USAGE_RECORDED", { role: "executor" });
    events.append("RUN_COMPLETED", { status: "succeeded", resultRevision: "r2" });

    const replayed = new EventStore(file, "run-1");
    replayed.load();
    expect(replayed.all().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const plan: Plan = {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "p", createdAt: "now" },
      spec: { id: "s", digest: `sha256:${"0".repeat(64)}` },
      repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [{ id: "T001", title: "t", kind: "modify", intent: "i" }],
    };
    const meta = { runId: "run-1", kind: "apply" as const, specId: "s", specDigest: `sha256:${"0".repeat(64)}`, createdAt: "now" };
    const state = projectState(meta, plan, replayed.all());
    expect(state.tasks["T001"]?.status).toBe("completed");
    expect(state.requirements["AUTH-001"]?.status).toBe("satisfied");
    expect(state.modelCalls).toBe(1);
    expect(state.status).toBe("succeeded");
    expect(state.resultRevision).toBe("r2");
  });

  it("state.json corruption is recoverable: projection from events only", () => {
    // no state file involved: projectState reconstructs purely from events
    const meta = { runId: "run-2", kind: "apply" as const, specId: "s", specDigest: "d", createdAt: "now" };
    let state = initialState(meta, null);
    const ev = { seq: 1, id: "x", type: "TASK_FAILED" as const, runId: "run-2", timestamp: "now", payload: { taskId: "T009", attempt: 2, error: { code: "X", message: "y" } } };
    state = applyEvent(state, ev);
    expect(state.tasks["T009"]?.status).toBe("failed");
    expect(state.tasks["T009"]?.failure?.code).toBe("X");
  });

  it("PLAN_AMENDED resets added tasks and skips removed ones", () => {
    const meta = { runId: "run-3", kind: "apply" as const, specId: "s", specDigest: "d", createdAt: "now" };
    let state = initialState(meta, null);
    state = applyEvent(state, { seq: 1, id: "a", type: "PLAN_AMENDED", runId: "run-3", timestamp: "t", payload: { removedTaskIds: ["T001"], addedTaskIds: ["T003"] } });
    state = applyEvent(state, { seq: 2, id: "b", type: "REPLAN_REQUESTED", runId: "run-3", timestamp: "t", payload: { taskId: "T001" } });
    expect(state.tasks["T001"]?.status).toBe("skipped");
    expect(state.tasks["T003"]?.status).toBe("pending");
    expect(state.replans).toBe(1);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fail-closed audit loads", () => {
  it("evidence: tampered content with stale digest throws on load", () => {
    const file = path.join(dir, "evidence-tampered.jsonl");
    const writer = new EvidenceStore(file);
    writer.add({ id: "EV-0001", ...evidenceBase("supports", "T-001-A") });
    const raw = readFileSync(file, "utf8").split("\n");
    const rec = JSON.parse(raw[0]!);
    rec.payload.exitCode = 99; // content changed, digest left alone
    raw[0] = JSON.stringify(rec);
    writeFileSync(file, raw.join("\n"), "utf8");
    expect(() => new EvidenceStore(file).load()).toThrow(/digest mismatch/);
  });

  it("evidence: torn trailing line from an interrupted append is tolerated", () => {
    const file = path.join(dir, "evidence-torn.jsonl");
    const writer = new EvidenceStore(file);
    writer.add({ id: "EV-0001", ...evidenceBase("supports", "T-001-A") });
    // Simulate an interrupted append: partial JSON, no trailing newline.
    appendFileSync(file, '{"id":"EV-0002","runId":"run-1","prop', "utf8");
    const reloaded = new EvidenceStore(file);
    expect(() => reloaded.load()).not.toThrow();
    expect(reloaded.all()).toHaveLength(1);
  });

  it("evidence: corrupted interior line throws", () => {
    const file = path.join(dir, "evidence-interior.jsonl");
    const writer = new EvidenceStore(file);
    writer.add({ id: "EV-0001", ...evidenceBase("supports", "T-001-A") });
    writer.add({ id: "EV-0002", ...evidenceBase("supports", "T-001-A") });
    const raw = readFileSync(file, "utf8").split("\n");
    raw[0] = "not json at all";
    writeFileSync(file, raw.join("\n"), "utf8");
    expect(() => new EvidenceStore(file).load()).toThrow(/corrupted at line 1/);
  });

  it("events: schema-invalid interior event throws instead of vanishing", () => {
    const file = path.join(dir, "events-invalid.jsonl");
    const store = new EventStore(file, "run-1", () => "2026-09-17T00:00:00.000Z");
    store.append("RUN_CREATED", { runId: "run-1" });
    store.append("SPEC_LOADED", {});
    const raw = readFileSync(file, "utf8").split("\n");
    const second = JSON.parse(raw[1]!);
    delete second.type; // schema-invalid: no type
    raw[1] = JSON.stringify(second);
    writeFileSync(file, raw.join("\n"), "utf8");
    expect(() => new EventStore(file, "run-1").load()).toThrow(/invalid event at line 2/);
  });

  it("events: torn trailing line from an interrupted append is tolerated", () => {
    const file = path.join(dir, "events-torn.jsonl");
    const store = new EventStore(file, "run-1", () => "2026-09-17T00:00:00.000Z");
    store.append("RUN_CREATED", { runId: "run-1" });
    appendFileSync(file, '{"seq":2,"id":"torn', "utf8");
    const reloaded = new EventStore(file, "run-1");
    expect(() => reloaded.load()).not.toThrow();
    expect(reloaded.length).toBe(1);
  });
});

describe("evidence chain", () => {
  const file = path.join(dir, "evidence-chain.jsonl");

  it("records chain genesis then prior digests; tampering a mid-record breaks the chain on load", () => {
    const store = new EvidenceStore(file);
    const e1 = store.add({ id: "EV-0001", ...evidenceBase("supports", "C-001") });
    const e2 = store.add({ id: "EV-0002", ...evidenceBase("supports", "C-001") });
    const e3 = store.add({ id: "EV-0003", ...evidenceBase("contradicts", "C-001") });
    expect(e1.chain).toBe(`sha256:${"0".repeat(64)}`);
    expect(e2.chain).toBe(e1.digest);
    expect(e3.chain).toBe(e2.digest);

    // The between-attestations attack: swap record 2 for a
    // self-consistent forgery (new content, RECOMPUTED digest). The
    // digest check alone passes; the chain catches it.
    const raw = readFileSync(file, "utf8").split("\n");
    const forged = JSON.parse(raw[1]!);
    forged.payload.exitCode = 99;
    const { digest: _d, ...rest } = forged;
    
    forged.digest = digestOf(rest);
    raw[1] = JSON.stringify(forged);
    writeFileSync(file, raw.join("\n"), "utf8");
    expect(() => new EvidenceStore(file).load()).toThrow(/chain break/);
  });

  it("legacy logs stay legacy on append and load; mixing is rejected", () => {
    const legacyFile = path.join(dir, "evidence-legacy.jsonl");
    // Hand-written pre-chaining log: no chain fields.
    const mk = (id: string) => {
      const rec = {
        id,
        runId: "run-1",
        criterionId: "C-001",
        propertyRefs: ["AUTH-001"],
        kind: "command" as const,
        outcome: "supports" as const,
        producer: { type: "runtime" as const },
        timestamp: "2026-01-01T00:00:00.000Z",
        repositoryRevision: "r1",
        payload: {},
      };
      return JSON.stringify({ ...rec, digest: digestOf(rec) });
    };
    writeFileSync(legacyFile, `${mk("EV-0001")}\n${mk("EV-0002")}\n`, "utf8");
    const legacy = new EvidenceStore(legacyFile);
    legacy.load();
    expect(legacy.chainStatus).toBe("legacy");
    // Append stays legacy (resume across versions).
    const appended = legacy.add({ id: "EV-0003", ...evidenceBase("supports", "C-001") });
    expect(appended.chain).toBeUndefined();
    expect(() => new EvidenceStore(legacyFile).load()).not.toThrow();

    // Mixed: inject a chained record into a legacy log (digest
    // recomputed so ONLY the chain rule catches it).
    const mixedFile = path.join(dir, "evidence-mixed.jsonl");
    const base = JSON.parse(mk("EV-0002")) as Record<string, unknown>;
    const { digest: _md, ...mRest } = base;
    const mixedRecord = { ...mRest, chain: `sha256:${"0".repeat(64)}` };
    writeFileSync(mixedFile, `${mk("EV-0001")}\n${JSON.stringify({ ...mixedRecord, digest: digestOf(mixedRecord) })}\n`, "utf8");
    expect(() => new EvidenceStore(mixedFile).load()).toThrow(/partially chained/);
  });
});
