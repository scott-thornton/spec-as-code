import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spcPaths, EventStore, EvidenceStore, replayRun, projectState } from "./index.js";
import { attestRecords, attestRun, evidenceHeadOf } from "./attestation.js";
import type { RunContext } from "./apply.js";

// Oracle for specs/anchor-verification.yaml: the git anchor is recorded
// at write time (AV-001) and consulted at read time (AV-002) - a
// coherently forged local history must not pass as authentic when a
// contradictory commitment exists in git.
const root = mkdtempSync(path.join(tmpdir(), "spc-anchor-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gitsh(args: string[], cwd = root): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);
// attestRun commits on ctx.worktreePath's CURRENT branch: check the
// run branch out the way a real worktree-mode run would have it.
gitsh(["checkout", "-q", "-b", "spc/av-spec/run-anchor-1"]);

const runId = "run-anchor-1";
const runDir = path.join(root, ".spc", "runs", runId);
mkdirSync(runDir, { recursive: true });
writeFileSync(
  path.join(runDir, "metadata.json"),
  JSON.stringify({ runId, specId: "av-spec", createdAt: "2026-10-23T00:00:00.000Z" }),
  "utf8",
);

function freshStores(tag: string): { events: EventStore; evidence: EvidenceStore } {
  const events = new EventStore(path.join(runDir, "events.jsonl"), runId);
  const evidence = new EvidenceStore(path.join(runDir, "evidence.jsonl"));
  events.append("RUN_CREATED", { tag });
  evidence.add({
    id: "EV-0001",
    runId,
    propertyRefs: ["AV-001"],
    kind: "test",
    outcome: "supports",
    producer: { type: "runtime" },
    timestamp: "2026-10-23T00:00:00.000Z",
    repositoryRevision: "0".repeat(40),
    payload: { tag },
  });
  return { events, evidence };
}

function persistProjection(): void {
  const events = new EventStore(path.join(runDir, "events.jsonl"), runId);
  events.load();
  const meta = { runId, specId: "av-spec", createdAt: "2026-10-23T00:00:00.000Z" } as never;
  const state = projectState(meta, null, events.all()) as { [k: string]: unknown };
  writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state), "utf8");
}

function ctxFor(events: EventStore, evidence: EvidenceStore): RunContext {
  return {
    paths: spcPaths(root),
    config: { verification: { attestInGit: true }, execution: { inPlace: false, inPlaceBranch: "run" } } as never,
    meta: { runId, specId: "av-spec", branch: "spc/av-spec/run-anchor-1" } as never,
    events,
    evidence,
    worktreePath: root,
    worktreeBranch: "spc/av-spec/run-anchor-1",
    log: () => {},
    now: () => "2026-10-23T00:00:00.000Z",
  } as unknown as RunContext;
}

describe("git anchor verification (anchor-verification)", () => {
  it("attestRun records the anchor identity in attestation.json and the event (AV-001)", () => {
    const { events, evidence } = freshStores("a");
    const attestation = attestRun(ctxFor(events, evidence), "succeeded", "0".repeat(40));
    const stored = JSON.parse(readFileSync(path.join(runDir, "attestation.json"), "utf8")) as {
      gitAnchor?: { ref: string; commit: string };
    };
    expect(stored.gitAnchor).toBeDefined();
    expect(stored.gitAnchor!.commit).toBe(attestation.gitAnchor?.commit ?? stored.gitAnchor!.commit);
    const message = gitsh(["log", "-1", "--format=%B", stored.gitAnchor!.commit]);
    expect(message).toContain(attestation.eventChainHead);
    expect(message).toContain(attestation.evidenceHead);
    const last = events.all()[events.all().length - 1]!;
    expect((last.payload as { gitAnchor?: { commit: string } }).gitAnchor?.commit).toBe(stored.gitAnchor!.commit);
  });

  it("replay verifies the anchor and passes an authentic run (AV-002)", () => {
    persistProjection();
    const report = replayRun(path.join(root, ".spc", "runs"), runId, null);
    expect(report.attestation).toBe("verified");
    expect(report.anchor).toBe("verified");
    expect(report.ok).toBe(true);
  });

  it("a coherently forged local history is rejected against the git commitment (AV-002)", () => {
    // The attack: replace events and evidence with a DIFFERENT coherent
    // set, rewrite attestation.json to commit to the forged heads (all
    // local checks pass), and strip the gitAnchor field - the defense
    // must still find the anchor commit by scanning git history.
    rmSync(path.join(runDir, "events.jsonl"));
    rmSync(path.join(runDir, "evidence.jsonl"));
    const forged = freshStores("forged");
    attestRecords({
      runDir,
      runId,
      specId: "av-spec",
      status: "succeeded",
      events: forged.events,
      evidence: [...forged.evidence.all()],
      now: () => "2026-10-23T00:01:00.000Z",
    });
    persistProjection();
    const report = replayRun(path.join(root, ".spc", "runs"), runId, null);
    // The forged history is locally coherent...
    expect(report.attestation).toBe("verified");
    // ...but the anchor in git commits to the ORIGINAL heads.
    expect(report.anchor).toBe("mismatch");
    expect(report.ok).toBe(false);
  });

  it("a recorded anchor whose commit is gone is unavailable, not unanchored (AV-002)", () => {
    const file = path.join(runDir, "attestation.json");
    const recorded = JSON.parse(readFileSync(file, "utf8")) as { gitAnchor?: { ref: string; commit: string } };
    recorded.gitAnchor = { ref: "refs/notes/spc-attestations", commit: "f".repeat(40) };
    writeFileSync(file, JSON.stringify(recorded), "utf8");
    const report = replayRun(path.join(root, ".spc", "runs"), runId, null);
    expect(report.anchor).toBe("unavailable");
    expect(report.ok).toBe(false);
  });

  it("a run with no anchor anywhere is explicitly unanchored (AV-002)", () => {
    const runId2 = "run-anchor-2";
    const runDir2 = path.join(root, ".spc", "runs", runId2);
    mkdirSync(runDir2, { recursive: true });
    writeFileSync(
      path.join(runDir2, "metadata.json"),
      JSON.stringify({ runId: runId2, specId: "av-spec", createdAt: "2026-10-23T00:00:00.000Z" }),
      "utf8",
    );
    const events = new EventStore(path.join(runDir2, "events.jsonl"), runId2);
    events.append("RUN_CREATED", { tag: "plain" });
    attestRecords({
      runDir: runDir2,
      runId: runId2,
      specId: "av-spec",
      status: "succeeded",
      events,
      evidence: [],
      now: () => "2026-10-23T00:00:00.000Z",
    });
    const meta = { runId: runId2, specId: "av-spec", createdAt: "2026-10-23T00:00:00.000Z" } as never;
    writeFileSync(path.join(runDir2, "state.json"), JSON.stringify(projectState(meta, null, events.all())), "utf8");
    const report = replayRun(path.join(root, ".spc", "runs"), runId2, null);
    expect(report.anchor).toBe("unanchored");
    expect(report.ok).toBe(true);
  });
});
