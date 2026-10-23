import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spcPaths, EventStore, EvidenceStore, projectState, replayRun } from "./index.js";
import { attestRecords, attestRun } from "./attestation.js";
import type { RunContext } from "./apply.js";

// Oracle for specs/notes-anchoring.yaml: current-branch runs anchor via a
// git note on the result revision (NA-001), and replay reads note-borne
// commitments (NA-002) - the mode this repository runs finally gets the
// anchor guarantee without surprise commits on the user's branch.
const root = mkdtempSync(path.join(tmpdir(), "spc-notes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gitsh(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

mkdirSync(path.join(root, "specs"), { recursive: true });
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);
// A result revision to anchor against.
writeFileSync(path.join(root, "change.txt"), "result\n", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "result change"]);
const resultRevision = gitsh(["rev-parse", "HEAD"]);

const runId = "run-notes-1";
const runDir = path.join(root, ".spc", "runs", runId);
mkdirSync(runDir, { recursive: true });
writeFileSync(
  path.join(runDir, "metadata.json"),
  JSON.stringify({ runId, specId: "na-spec", createdAt: "2026-10-23T00:00:00.000Z" }),
  "utf8",
);

function stores(): { events: EventStore; evidence: EvidenceStore } {
  const events = new EventStore(path.join(runDir, "events.jsonl"), runId);
  const evidence = new EvidenceStore(path.join(runDir, "evidence.jsonl"));
  events.append("RUN_CREATED", { tag: "notes" });
  evidence.add({
    id: "EV-0001",
    runId,
    propertyRefs: ["NA-001"],
    kind: "test",
    outcome: "supports",
    producer: { type: "runtime" },
    timestamp: "2026-10-23T00:00:00.000Z",
    repositoryRevision: resultRevision,
    payload: { tag: "notes" },
  });
  return { events, evidence };
}

function ctxFor(events: EventStore, evidence: EvidenceStore): RunContext {
  return {
    paths: spcPaths(root),
    config: {
      verification: { attestInGit: true },
      execution: { inPlace: true, inPlaceBranch: "current" },
    } as never,
    meta: { runId, specId: "na-spec", branch: "main" } as never,
    events,
    evidence,
    worktreePath: root,
    worktreeBranch: null,
    log: () => {},
    now: () => "2026-10-23T00:00:00.000Z",
  } as unknown as RunContext;
}

describe("git notes anchoring (notes-anchoring)", () => {
  it("current-branch mode anchors via a note on the result revision (NA-001)", () => {
    const { events, evidence } = stores();
    const attestation = attestRun(ctxFor(events, evidence), "succeeded", resultRevision);
    const stored = JSON.parse(readFileSync(path.join(runDir, "attestation.json"), "utf8")) as {
      gitAnchor?: { ref: string; commit: string };
    };
    expect(stored.gitAnchor).toBeDefined();
    expect(stored.gitAnchor!.ref).toBe("refs/notes/spc-attestations");
    expect(stored.gitAnchor!.commit).toBe(resultRevision);
    const note = gitsh(["notes", "--ref=spc-attestations", "show", resultRevision]);
    expect(note).toContain(attestation.eventChainHead);
    expect(note).toContain(attestation.evidenceHead);
    // No surprise commit landed on the user's branch.
    expect(gitsh(["rev-parse", "HEAD"])).toBe(resultRevision);
  });

  it("replay verifies a note-anchored run and catches a contradicted one (NA-002)", () => {
    const events = new EventStore(path.join(runDir, "events.jsonl"), runId);
    const meta = { runId, specId: "na-spec", createdAt: "2026-10-23T00:00:00.000Z" } as never;
    writeFileSync(path.join(runDir, "state.json"), JSON.stringify(projectState(meta, null, events.all())), "utf8");
    const report = replayRun(path.join(root, ".spc", "runs"), runId, null);
    expect(report.anchor).toBe("verified");
    expect(report.ok).toBe(true);

    // The attack: rewrite the local history coherently and re-attest -
    // the note on the unchanged result revision still commits to the
    // ORIGINAL heads.
    rmSync(path.join(runDir, "events.jsonl"));
    rmSync(path.join(runDir, "evidence.jsonl"));
    const fresh = stores();
    fresh.events.append("RUN_CREATED", { tag: "forged" });
    attestRecords({
      runDir,
      runId,
      specId: "na-spec",
      status: "succeeded",
      events: fresh.events,
      evidence: [...fresh.evidence.all()],
      now: () => "2026-10-23T00:01:00.000Z",
    });
    const state2 = projectState(meta, null, fresh.events.all());
    writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state2), "utf8");
    const forged = replayRun(path.join(root, ".spc", "runs"), runId, null);
    expect(forged.anchor).toBe("mismatch");
    expect(forged.ok).toBe(false);
  });
});