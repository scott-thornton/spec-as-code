import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spcPaths, EventStore, EvidenceStore, postureFor, trackedDrift } from "./index.js";
import { compileSpecFile } from "@spc/repo";
import { configDigestOf } from "./index.js";

// Oracle for specs/spec-posture.yaml: the derived lifecycle - four
// postures in the ruled evaluation order, any run kind establishes
// evidence while verify-kind remains cache-only, shared drift
// predicate, successor digest never inherits.
const root = mkdtempSync(path.join(tmpdir(), "spc-posture-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gitsh(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "t@t"]);
gitsh(["config", "user.name", "t"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ps-fixture
  title: fixture
goal: fixture
requirements:
  - id: PSP-001
    statement: Gate passes.
    priority: must
    acceptance:
      - id: PSP-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;
writeFileSync(path.join(root, "specs", "ps-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "fixture"]);

const compiled = compileSpecFile(path.join(root, "specs", "ps-fixture.yaml"));
const IR = compiled.ok && compiled.ir ? compiled.ir : null;
if (!IR) throw new Error("fixture spec does not compile");

const paths = spcPaths(root);
const P = (s: string) => path.join(root, s);

function buildRun(
  runId: string,
  opts: { kind?: "verify" | "apply"; digest?: string; requirementStatus?: string; dirty?: boolean; resultRevision?: string },
): string {
  const dir = path.join(paths.runsDir, runId);
  mkdirSync(dir, { recursive: true });
  const base = gitsh(["rev-parse", "HEAD"]);
  writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      runId,
      kind: opts.kind ?? "verify",
      specId: "ps-fixture",
      specDigest: opts.digest ?? IR!.digest,
      configDigest: configDigestOf(path.join(root, ".spc", "config.yaml")),
      baseRevision: base,
      createdAt: new Date(Date.now() + Math.random()).toISOString(),
    }),
    "utf8",
  );
  const events = new EventStore(path.join(dir, "events.jsonl"), runId);
  events.append("RUN_CREATED", { runId, kind: opts.kind ?? "verify", specId: "ps-fixture", baseRevision: base, dirty: opts.dirty ?? false });
  const evidence = new EvidenceStore(path.join(dir, "evidence.jsonl"));
  evidence.add({
    id: "EV-0001",
    runId,
    propertyRefs: ["PSP-001"],
    criterionId: "PSP-001-A",
    kind: "command",
    outcome: "supports",
    producer: { type: "runtime" },
    timestamp: "2026-10-26T00:00:00.000Z",
    repositoryRevision: base,
    payload: { command: "node gate.cjs" },
  });
  writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      status: opts.requirementStatus === "satisfied" ? "succeeded" : "partially_satisfied",
      tasks: {},
      requirements: { PSP-001: { propertyId: "PSP-001", status: opts.requirementStatus ?? "satisfied" } },
      ...(opts.resultRevision ? { resultRevision: opts.resultRevision } : {}),
    }),
    "utf8",
  );
  return runId;
}

beforeEach(() => {
  rmSync(path.join(root, ".spc", "runs"), { recursive: true, force: true });
  mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
});

describe("postureFor derivation (PS-001)", () => {
  it("no valid run for the digest: unverified", () => {
    expect(postureFor(IR!, paths.runsDir, root).posture).toBe("unverified");
  });

  it("a successor digest never inherits its predecessor's posture", () => {
    buildRun("v-green-old", { digest: "sha256:" + "e".repeat(64) }); // green under an OLD digest
    const p = postureFor(IR!, paths.runsDir, root);
    expect(p.posture).toBe("unverified");
    expect(p.reason ?? "").toMatch(/digest/i);
  });

  it("unresolved musts: active - and unresolved takes precedence over drift", () => {
    buildRun("v-unresolved", { requirementStatus: "unsatisfied" });
    writeFileSync(P("tracked.txt"), "drift too\n", "utf8");
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "drift"]);
    const p = postureFor(IR!, paths.runsDir, root);
    expect(p.posture).toBe("active");
  });

  it("green with tracked drift: stale (commit, dirty tree, config change each suffice)", () => {
    buildRun("v-green", {});
    writeFileSync(P("tracked.txt"), "x\n", "utf8");
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "drift"]);
    expect(postureFor(IR!, paths.runsDir, root).posture).toBe("stale");
    rmSync(P("tracked.txt"));
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "undrift"]);
    // dirty working tree
    writeFileSync(P("gate.cjs"), "process.exit(0);\n// dirty\n", "utf8");
    expect(postureFor(IR!, paths.runsDir, root).posture).toBe("stale");
    writeFileSync(P("gate.cjs"), "process.exit(0);\n", "utf8");
    // config change
    writeFileSync(path.join(root, ".spc", "config.yaml"), "version: 9\n", "utf8");
    expect(postureFor(IR!, paths.runsDir, root).posture).toBe("stale");
    rmSync(path.join(root, ".spc", "config.yaml"));
  });

  it("green verify evidence recorded against a dirty tree: stale (unreconstructable)", () => {
    buildRun("v-dirty-evidence", { dirty: true });
    expect(postureFor(IR!, paths.runsDir, root).posture).toBe("stale");
  });

  it("green and fresh: standing", () => {
    buildRun("v-green", {});
    const p = postureFor(IR!, paths.runsDir, root);
    expect(p.posture).toBe("standing");
  });

  it("a green APPLY run establishes posture at its RESULT revision (the conflation case)", () => {
    // The run's evidence binds to what it verified: the result tree.
    const result = gitsh(["rev-parse", "HEAD"]);
    buildRun("run-apply-green", { kind: "apply", resultRevision: result });
    const p = postureFor(IR!, paths.runsDir, root);
    expect(p.posture).toBe("standing"); // verify-only cache logic would have said unverified

    writeFileSync(P("later.txt"), "after\n", "utf8");
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "moved past result"]);
    expect(postureFor(IR!, paths.runsDir, root).posture).toBe("stale"); // anchored at result, not base
  });

  it("corrupt latest run is skipped for the next valid run (loadability)", () => {
    buildRun("v-old-green", {});
    const bad = path.join(paths.runsDir, "v-corrupt");
    mkdirSync(bad, { recursive: true });
    writeFileSync(
      path.join(bad, "metadata.json"),
      JSON.stringify({ runId: "v-corrupt", kind: "verify", specId: "ps-fixture", specDigest: IR!.digest, createdAt: new Date().toISOString() }),
      "utf8",
    );
    writeFileSync(path.join(bad, "evidence.jsonl"), "not evidence\n", "utf8");
    expect(postureFor(IR!, paths.runsDir, root).posture).toBe("standing"); // from v-old-green
  });
});

describe("shared drift predicate (PS-002)", () => {
  it("trackedDrift reports fresh at HEAD and drifted after a commit", () => {
    const head = gitsh(["rev-parse", "HEAD"]);
    const cfg = configDigestOf(path.join(root, ".spc", "config.yaml"));
    expect(trackedDrift(root, head, cfg).drifted).toBe(false);
    writeFileSync(P("drift.txt"), "d\n", "utf8");
    gitsh(["add", "."]);
    gitsh(["commit", "-q", "-m", "d"]);
    const d = trackedDrift(root, head, cfg);
    expect(d.drifted).toBe(true);
    expect(d.reason ?? "").toBeTruthy();
    rmSync(P("drift.txt"));
  });
});
