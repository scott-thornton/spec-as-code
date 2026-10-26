import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, git, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { loadPlanFile } from "./run.js";
import { replayRun } from "./replay.js";
import { EventStore } from "./events.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-spine-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greet
  title: Greeting module
goal: A greet module exists.
requirements:
  - id: FEAT-A
    statement: The greet module exists.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: file
        path: src/greet.cjs
        assert:
          contains: "greet"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

const fakeScript = `
executor:
  T001:
    status: completed
    summary: wrote greet module
    changes:
      - op: create
        path: src/greet.cjs
        content: |
          module.exports = { greet: () => "hello" };
`;

function setupRepo(name: string, configLines: string[]): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml", ...configLines].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}

function planFor(): unknown {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-spine", createdAt: "now" },
    spec: { id: "greet", digest: ir.digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs"] } },
    ],
  };
}

async function runTo(repo: string): Promise<string> {
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(paths.planFile("plan-spine"), JSON.stringify(planFor()));
  const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
  expect(report.status).toBe("succeeded");
  return report.runId;
}

function replayOf(repo: string, runId: string) {
  const paths = spcPaths(repo);
  return replayRun(paths.runsDir, runId, loadPlanFile(paths.planFile("plan-spine")));
}

describe("audit spine: chaining, attestation, replay", () => {
  it("a completed run is chained, attested, and replays clean", { timeout: 120_000 }, async () => {
    const repo = setupRepo("clean", []);
    const runId = await runTo(repo);
    const paths = spcPaths(repo);

    const r = replayOf(repo, runId);
    expect(r.ok).toBe(true);
    expect(r.chainStatus).toBe("chained");
    expect(r.projectionMatches).toBe(true);
    expect(r.attestation).toBe("verified");

    // The attestation file is in the run dir and rides inside exports.
    const attestation = JSON.parse(readFileSync(path.join(paths.runDir(runId), "attestation.json"), "utf8")) as { eventCount: number; status: string };
    expect(attestation.status).toBe("succeeded");
    expect(attestation.eventCount).toBeGreaterThan(0);
  }, 120_000);

  it("editing an interior event breaks the chain and replay fails loudly", { timeout: 120_000 }, async () => {
    const repo = setupRepo("tamper", []);
    const runId = await runTo(repo);
    const paths = spcPaths(repo);
    const evFile = path.join(paths.runDir(runId), "events.jsonl");
    const lines = readFileSync(evFile, "utf8").split("\n");
    const victim = JSON.parse(lines[2]!);
    victim.payload.forged = true;
    lines[2] = JSON.stringify(victim);
    writeFileSync(evFile, lines.join("\n"), "utf8");
    expect(() => replayOf(repo, runId)).toThrow(/chain break/);
  }, 120_000);

  it("an edited state.json diverges from the replayed projection", { timeout: 120_000 }, async () => {
    const repo = setupRepo("projection", []);
    const runId = await runTo(repo);
    const paths = spcPaths(repo);
    const stateFile = path.join(paths.runDir(runId), "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { modelCalls: number };
    state.modelCalls = 0; // forged: hides spend
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
    const r = replayOf(repo, runId);
    expect(r.ok).toBe(false);
    expect(r.projectionMatches).toBe(false);
    expect(r.projectionDiffs.join(" ")).toContain("modelCalls");
  }, 120_000);

  it("a forged attestation is detected as broken", { timeout: 120_000 }, async () => {
    const repo = setupRepo("forge", []);
    const runId = await runTo(repo);
    const paths = spcPaths(repo);
    const file = path.join(paths.runDir(runId), "attestation.json");
    const attestation = JSON.parse(readFileSync(file, "utf8")) as { eventCount: number; eventChainHead: string };
    attestation.eventCount += 5; // claims more log than existed
    writeFileSync(file, JSON.stringify(attestation, null, 2), "utf8");
    const r = replayOf(repo, runId);
    expect(r.ok).toBe(false);
    expect(r.attestation).toBe("broken");
  }, 120_000);

  it("legacy unchained logs replay as legacy; mixed logs are rejected", { timeout: 120_000 }, () => {
    const dir = path.join(root, "legacy");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "events.jsonl");
    const legacy = new EventStore(file, "run-legacy", () => "2026-01-01T00:00:00.000Z");
    // Simulate a pre-chaining log: hand-write events without chain fields.
    const raw = [
      { seq: 1, id: "a", type: "RUN_CREATED", runId: "run-legacy", timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
      { seq: 2, id: "b", type: "SPEC_LOADED", runId: "run-legacy", timestamp: "2026-01-01T00:00:01.000Z", payload: {} },
    ];
    writeFileSync(file, raw.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const legacyStore = new EventStore(file, "run-legacy");
    legacyStore.load();
    expect(legacyStore.chainStatus).toBe("legacy");

    // Appending to a legacy log stays legacy (resume across versions).
    legacyStore.append("SPEC_VALIDATED", {});
    const reloaded = new EventStore(file, "run-legacy");
    expect(() => reloaded.load()).not.toThrow();
    expect(reloaded.chainStatus).toBe("legacy");

    // A chained event injected into a legacy log is rejected as mixed.
    const mixed = new EventStore(path.join(dir, "mixed.jsonl"), "run-mixed", () => "2026-01-01T00:00:00.000Z");
    mixed.append("RUN_CREATED", {}); // chained
    const lines = readFileSync(path.join(dir, "mixed.jsonl"), "utf8").split("\n");
    lines.splice(1, 0, JSON.stringify({ seq: 2, id: "x", type: "SPEC_LOADED", runId: "run-mixed", timestamp: "2026-01-01T00:00:00.000Z", payload: {} })); // unchained, interior
    writeFileSync(path.join(dir, "mixed.jsonl"), lines.join("\n"), "utf8");
    expect(() => new EventStore(path.join(dir, "mixed.jsonl"), "run-mixed").load()).toThrow(/partially chained/);
  });

  it("attestInGit anchors the commitment as an empty commit on the run branch", { timeout: 120_000 }, async () => {
    const repo = setupRepo("anchor", ["verification:", "  attestInGit: true"]);
    const runId = await runTo(repo);
    const paths = spcPaths(repo);
    const r = replayOf(repo, runId);
    expect(r.ok).toBe(true);
    // The anchor commit exists on the run branch with attestation trailers.
    const meta = JSON.parse(readFileSync(path.join(paths.runDir(runId), "metadata.json"), "utf8")) as { branch: string };
    const anchored = git(repo, ["log", "--format=%B", "--grep=attest run", meta.branch, "-1"]);
    expect(anchored.ok).toBe(true);
    expect(anchored.stdout).toContain("SPC-Attestation-Event-Head");
    expect(anchored.stdout).toContain("SPC-Attestation-Evidence-Head");
  }, 120_000);
});
