import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HarnessStore, type HarnessRequest } from "./store.js";
import { claimCandidate, candidateConsumed, deriveFingerprint, saveCandidate } from "./candidates.js";

// Oracle for specs/portable-candidates.yaml (PC-002 store semantics,
// PC-003 race/crash predicates): one atomic commit, fingerprints
// derived from authoritative records at claim time, mismatch preserves
// the candidate, consumption derived from answer records.
const root = mkdtempSync(path.join(tmpdir(), "spc-cand-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const digest = (v: unknown) => "sha256:" + createHash("sha256").update(JSON.stringify(v)).digest("hex");

function payloadPrompt(payload: unknown): string {
  return `--- harness instructions ---\nanswer\n\nExecute the following task. Respond with JSON only.\n\n${JSON.stringify(payload, null, 2)}`;
}

const basePayload = (task: unknown, revision: string) => ({
  spec: { id: "cand-spec" },
  repository: { revision },
  task,
  allowedWritePaths: ["src/**"],
});

function putRequest(store: HarnessStore, id: string, payload: unknown, schema: unknown, key = "T001@1"): void {
  const request: HarnessRequest = {
    id,
    role: "executor",
    key,
    schemaName: "ExecutorResult",
    jsonSchema: schema,
    system: "sys",
    prompt: payloadPrompt(payload),
    createdAt: new Date().toISOString(),
  };
  store.putRequest(request);
}

const SCHEMA = {
  type: "object",
  required: ["status", "summary", "changes", "commands", "observations", "evidenceCandidates", "followups"],
  properties: { status: { type: "string" }, summary: { type: "string" }, changes: { type: "array" }, commands: { type: "array" }, observations: { type: "array" }, evidenceCandidates: { type: "array" }, followups: { type: "array" } },
};
const VALUE = { status: "completed", summary: "s", changes: [], commands: [], observations: [], evidenceCandidates: [], followups: [] };

function freshStore(): HarnessStore {
  rmSync(path.join(root, ".spc"), { recursive: true, force: true });
  mkdirSync(path.join(root, ".spc"), { recursive: true });
  return new HarnessStore(root);
}

describe("claim semantics (PC-002)", () => {
  let store: HarnessStore;
  beforeEach(() => {
    store = freshStore();
    putRequest(store, "executor-T001@1-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA);
  });

  it("a matching successor claims: one rename, lineage stamped, candidate consumed", () => {
    const cand = saveCandidate(store, VALUE, "executor-T001@1-1", "composer");
    putRequest(store, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@2");
    const r = claimCandidate(store, cand.id, "executor-T001@2-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer.id).toBe("executor-T001@2-1");
      expect(r.answer.candidateId).toBe(cand.id);
      expect((r.answer.value as { status: string }).status).toBe("completed");
    }
    expect(candidateConsumed(store, cand.id)).toBe(true);
    expect(existsSync(path.join(root, ".spc", "harness", "answered", "executor-T001@2-1.json"))).toBe(true);
  });

  const mismatch = (name: string, mutate: (store: HarnessStore) => void) =>
    it(`mismatch on ${name} rejects the attempt and PRESERVES the candidate`, () => {
      const cand = saveCandidate(store, VALUE, "executor-T001@1-1", "composer");
      mutate(store);
      const r = claimCandidate(store, cand.id, "executor-T001@2-1");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toContain(name);
      expect(candidateConsumed(store, cand.id)).toBe(false);
      expect(store.getCandidate(cand.id)).not.toBeNull();
    });

  mismatch("task", (s) => putRequest(s, "executor-T001@2-1", basePayload({ id: "T002", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@2"));
  mismatch("schema", (s) => putRequest(s, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), { ...SCHEMA, required: [...SCHEMA.required, "extra"] }, "T001@2"));
  mismatch("baseRevision", (s) => putRequest(s, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "b".repeat(40)), SCHEMA, "T001@2"));
  mismatch("writeScope", (s) => putRequest(s, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["docs/**"] } }, "a".repeat(40)), SCHEMA, "T001@2"));
  mismatch("config", (s) => writeFileSync(path.join(root, ".spc", "config.yaml"), "version: 9\n", "utf8"));

  it("a schema-invalid candidate value is refused at claim", () => {
    const cand = saveCandidate(store, { status: "nope" }, "executor-T001@1-1", "composer");
    putRequest(store, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@2");
    const r = claimCandidate(store, cand.id, "executor-T001@2-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CANDIDATE_SCHEMA_INVALID");
    expect(candidateConsumed(store, cand.id)).toBe(false);
  });

  it("a consumed candidate can never be claimed again", () => {
    const cand = saveCandidate(store, VALUE, "executor-T001@1-1", "composer");
    putRequest(store, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@2");
    expect(claimCandidate(store, cand.id, "executor-T001@2-1").ok).toBe(true);
    putRequest(store, "executor-T001@3-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@3");
    const again = claimCandidate(store, cand.id, "executor-T001@3-1");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("CANDIDATE_CONSUMED");
  });
});

describe("race and crash predicates (PC-003)", () => {
  it("expiry racing claim, expiry-first: the request stays dead, the candidate Available", () => {
    const store = freshStore();
    putRequest(store, "executor-T001@1-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA);
    const cand = saveCandidate(store, VALUE, "executor-T001@1-1");
    store.expirePending("executor-T001@2-1"); // no such request; also expire the successor below
    putRequest(store, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@2");
    store.expirePending("executor-T001@2-1");
    const r = claimCandidate(store, cand.id, "executor-T001@2-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CANDIDATE_REQUEST_NOT_LIVE");
    expect(candidateConsumed(store, cand.id)).toBe(false);
  });

  it("claim then expiry racing consumption: candidate stays consumed, records converge", () => {
    const store = freshStore();
    putRequest(store, "executor-T001@1-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA);
    const cand = saveCandidate(store, VALUE, "executor-T001@1-1");
    putRequest(store, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@2");
    expect(claimCandidate(store, cand.id, "executor-T001@2-1").ok).toBe(true);
    store.expirePending("executor-T001@2-1"); // the request dies AFTER admission
    expect(candidateConsumed(store, cand.id)).toBe(true); // admitted: consumed forever
    expect(store.getAnswer("executor-T001@2-1")).not.toBeNull(); // answer record kept
  });

  it("the crash predicate is executable across every candidate", () => {
    const store = freshStore();
    putRequest(store, "executor-T001@1-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA);
    const a = saveCandidate(store, VALUE, "executor-T001@1-1");
    const b = saveCandidate(store, VALUE, "executor-T001@1-1");
    putRequest(store, "executor-T001@2-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "a".repeat(40)), SCHEMA, "T001@2");
    expect(claimCandidate(store, a.id, "executor-T001@2-1").ok).toBe(true);
    // Orphaned temp file in answered/ is NOT an answer.
    writeFileSync(path.join(root, ".spc", "harness", "answered", ".crash-tmp.json"), "{}", "utf8");
    const answeredDir = path.join(root, ".spc", "harness", "answered");
    const answerContents = readdirSync(answeredDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    const consumedIds = new Set(
      answerContents.flatMap((f) => {
        const ans = JSON.parse(readFileSync(path.join(answeredDir, f), "utf8")) as { candidateId?: string };
        return ans.candidateId ? [ans.candidateId] : [];
      }),
    );
    for (const id of [a.id, b.id]) {
      expect(consumedIds.has(id)).toBe(candidateConsumed(store, id)); // XOR invariant
    }
    expect(consumedIds.has(a.id)).toBe(true);
    expect(consumedIds.has(b.id)).toBe(false);
    expect(store.getCandidate(b.id)).not.toBeNull(); // b survives Available
  });

  it("deriveFingerprint reads only authoritative request records", () => {
    const store = freshStore();
    putRequest(store, "executor-T001@1-1", basePayload({ id: "T001", targets: { write: ["src/**"] } }, "c".repeat(40)), SCHEMA);
    const req = store.getRequest("executor-T001@1-1")!;
    const fp = deriveFingerprint(store, req);
    expect(fp.schemaName).toBe("ExecutorResult");
    expect(fp.baseRevision).toBe("c".repeat(40));
    expect(fp.writeScope).toEqual(["src/**"]);
  });
});
