import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-red-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Behavior-changing requirement: the criterion must fail on the base tree
// (module missing) and pass once the task lands it.
const greetSpec = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greet
  title: Greeting module
goal: A greet module exists.
requirements:
  - id: FEAT-A
    statement: The greet module exists and loads.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: command
        command: node -e "require('./src/greet.cjs')"
        discriminating: true
`;
const greetIr = compileSpecSource(greetSpec, "specs/spec.yaml").ir!;

// Regression-shaped requirement: the criterion legitimately passes on the
// base tree already; marked discriminating it is decorative by definition.
const decorativeSpec = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: decorative
  title: Decorative criterion
goal: An existing invariant is stated.
requirements:
  - id: FEAT-B
    statement: The existing marker file keeps its marker.
    priority: must
    acceptance:
      - id: FEAT-B-A
        type: file
        path: src/exists.txt
        assert:
          contains: "marker"
        discriminating: true
`;
const decorativeIr = compileSpecSource(decorativeSpec, "specs/spec.yaml").ir!;

function setupRepo(name: string, configLines: string[], specYaml: string, extraFiles: Record<string, string> = {}): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  for (const [file, content] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  }
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml", ...configLines].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}

function planFor(specId: string, digest: string, tasks: unknown[]): unknown {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-red", createdAt: "now" },
    spec: { id: specId, digest },
    repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks,
  };
}

const greetScript = `
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

const noopScript = `
executor:
  T001:
    status: completed
    summary: nothing to change
    changes: []
`;

function provider(script: string): FakeProvider {
  return new FakeProvider(parseFakeScript(script));
}

describe("red-phase verification (verification.requireRedPhase)", () => {
  it("command criterion flips red -> green: run succeeds with flip recorded", async () => {
    const repo = setupRepo("flip", ["verification:", "  requireRedPhase: true"], greetSpec);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(
      paths.planFile("plan-red"),
      JSON.stringify(
        planFor("greet", greetIr.digest, [
          { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs"] } },
          { id: "T002", title: "Verify", kind: "verify", intent: "verify", dependsOn: ["T001"], verifies: ["FEAT-A"] },
        ]),
      ),
    );

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider(greetScript), log: () => {} });
    expect(report.status).toBe("succeeded");

    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect((events.match(/"type":"RED_PHASE_RECORDED"/g) ?? []).length).toBe(1);
    const evidence = readFileSync(paths.evidenceFile(report.runId), "utf8");
    expect(evidence).toContain('"phase":"red"');
    expect(evidence).toMatch(new RegExp('"criterionId":"FEAT-A-A"[^\\n]*"outcome":"contradicts"|"outcome":"contradicts"[^\\n]*"criterionId":"FEAT-A-A"'));

    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      requirements: Record<string, { status: string; redPhase?: string }>;
    };
    expect(state.requirements["FEAT-A"]?.status).toBe("satisfied");
    expect(state.requirements["FEAT-A"]?.redPhase).toBe("flipped");

    const summary = readFileSync(paths.summaryFile(report.runId), "utf8");
    expect(summary).toContain("Red phase: 1/1 discriminating properties flipped");
  }, 120_000);

  it("criterion that already passes at base: property indeterminate, run cannot succeed", async () => {
    const repo = setupRepo(
      "decorative",
      ["verification:", "  requireRedPhase: true"],
      decorativeSpec,
      { "src/exists.txt": "marker\n" },
    );
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(
      paths.planFile("plan-red"),
      JSON.stringify(
        planFor("decorative", decorativeIr.digest, [
          { id: "T001", title: "Nothing", kind: "modify", intent: "no change needed", dependsOn: [], satisfies: ["FEAT-B"], targets: { write: [] } },
          { id: "T002", title: "Verify", kind: "verify", intent: "verify", dependsOn: ["T001"], verifies: ["FEAT-B"] },
        ]),
      ),
    );

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider(noopScript), log: () => {} });
    expect(report.status).toBe("partially_satisfied");

    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      requirements: Record<string, { status: string; redPhase?: string; reason?: string }>;
    };
    expect(state.requirements["FEAT-B"]?.status).toBe("indeterminate");
    expect(state.requirements["FEAT-B"]?.redPhase).toBe("passed_at_base");
    expect(state.requirements["FEAT-B"]?.reason).toContain("base revision");

    const summary = readFileSync(paths.summaryFile(report.runId), "utf8");
    expect(summary).toContain("does not test this change");
  }, 120_000);

  it("flag off: discriminating markers are inert authoring metadata", async () => {
    const repo = setupRepo("off", [], greetSpec);
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(
      paths.planFile("plan-red"),
      JSON.stringify(
        planFor("greet", greetIr.digest, [
          { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs"] } },
          { id: "T002", title: "Verify", kind: "verify", intent: "verify", dependsOn: ["T001"], verifies: ["FEAT-A"] },
        ]),
      ),
    );

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => provider(greetScript), log: () => {} });
    expect(report.status).toBe("succeeded");

    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).not.toContain("RED_PHASE_RECORDED");
    const evidence = readFileSync(paths.evidenceFile(report.runId), "utf8");
    expect(evidence).not.toContain('"phase":"red"');
    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as {
      requirements: Record<string, { redPhase?: string }>;
    };
    expect(state.requirements["FEAT-A"]?.redPhase).toBeUndefined();
  }, 120_000);
});
