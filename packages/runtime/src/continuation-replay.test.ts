import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { git } from "@spc/repo";
import { applyPlan, spcPaths, replayRun } from "./index.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: creplay
  title: Continuation replay
goal: fixture
requirements:
  - id: CR-001
    statement: The module exports the marker.
    priority: must
    acceptance:
      - id: CR-001-A
        type: command
        command: node --test "tests/*.test.mjs"
        discriminating: true
`;

let roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-creplay-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(
    path.join(repo, "tests", "creplay.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { marker } from "../src/module.mjs";',
      'test("marker", () => {',
      '  assert.equal(marker(), "creplay");',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "config.yaml"), [
    "version: 1",
    "provider:",
    "  name: fake",
    "  script: .spc/fake.yaml",
    "execution:",
    "  inPlace: true",
    "  inPlaceBranch: current",
    "verification:",
    "  requireRedPhase: true",
    "",
  ].join("\n"), "utf8");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function fakeScript(taskId: string, create: boolean, content: string): FakeProvider {
  const script = [
    "planner:",
    "  value: {}",
    "executor:",
    `  ${taskId}:`,
    "    status: completed",
    "    summary: work",
    "    changes:",
    `      - op: ${create ? "create" : "update"}`,
    "        path: src/module.mjs",
    "        content: |",
    ...content.split("\n").map((l) => `          ${l}`),
    "",
  ].join("\n");
  return new FakeProvider(parseFakeScript(script));
}

function planFor(id: string, digest: string, taskId: string): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id, createdAt: "2026-10-20T00:00:00.000Z" },
    spec: { id: "creplay", digest },
    repository: { revision: "0000", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: taskId, title: "Do the work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["CR-001"], targets: { write: ["src/module.mjs"] } },
    ],
  } as never;
}

describe("continuation inheritance: replay consistency (Finding B) + digest binding (Finding A)", () => {
  it("run 2's inherited satisfaction replays exactly (PROPERTY_INHERITED in the log)", async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });

    writeFileSync(paths.planFile("plan-one"), JSON.stringify(planFor("plan-one", ir.digest, "T001"), null, 2));
    const run1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fakeScript("T001", true, 'export function marker() {\n  return "creplay";\n}'), log: () => {} });
    expect(run1.status).toBe("succeeded");

    writeFileSync(paths.planFile("plan-two"), JSON.stringify(planFor("plan-two", ir.digest, "T101"), null, 2));
    const run2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fakeScript("T101", false, 'export function marker() {\n  return "creplay";\n}'), log: () => {} });
    expect(run2.status).toBe("succeeded");

    // The inherited property appears satisfied in state AND as an event.
    const events = readFileSync(paths.eventsFile(run2.runId), "utf8");
    expect(events).toContain("PROPERTY_INHERITED");
    expect(events).toContain("CR-001");
    expect(events).toContain(run1.runId);

    // Replay reconstructs exactly the persisted states (the reviewer's
    // regression test, verbatim in spirit).
    const replay = replayRun(paths.runsDir, run2.runId, JSON.parse(readFileSync(paths.planFile("plan-two"), "utf8")));
    expect(replay.projectionMatches).toBe(true);
  });

  it("digest binding: an amended spec does NOT inherit from the old contract", async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });

    writeFileSync(paths.planFile("plan-a"), JSON.stringify(planFor("plan-a", ir.digest, "T001"), null, 2));
    const runA = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fakeScript("T001", true, 'export function marker() {\n  return "creplay";\n}'), log: () => {} });
    expect(runA.status).toBe("succeeded");

    // Amend the contract: a new discriminating criterion on the same property.
    const amended = specYaml.replace(
      "        discriminating: true",
      "        discriminating: true\n      - id: CR-001-B\n        type: file\n        path: src/module.mjs\n        assert:\n          contains: NEW_MARKER\n        discriminating: true",
    );
    writeFileSync(path.join(repo, "specs", "spec.yaml"), amended, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "amend spec"]);
    const ir2 = compileSpecSource(amended, "specs/spec.yaml").ir!;
    expect(ir2.digest).not.toBe(ir.digest);

    writeFileSync(paths.planFile("plan-b"), JSON.stringify(planFor("plan-b", ir2.digest, "T101"), null, 2));
    const runB = await applyPlan({ repoRoot: repo }, { providerFactory: async () => fakeScript("T101", false, 'export function marker() {\n  return "creplay";\n}'), log: () => {} });
    // The new criterion's obligation is NOT discharged by the old run's
    // satisfaction of the same property id under the old digest.
    const state = JSON.parse(readFileSync(paths.stateFile(runB.runId), "utf8")) as { requirements: Record<string, { status: string; reason?: string }> };
    const inherited = state.requirements["CR-001"];
    if (inherited?.status === "satisfied" && (inherited.reason ?? "").includes("prior run")) {
      throw new Error(`inheritance crossed a digest boundary: ${inherited.reason}`);
    }
    expect(runB.status).not.toBe("succeeded");
  });
});
