import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-noop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The requirement is ALREADY satisfied in the base tree.
const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: pre
  title: Pre-satisfied
goal: An existing file keeps existing.
requirements:
  - id: FEAT-A
    statement: The module exists and loads.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: command
        command: node -e "require('./src/there.cjs')"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

// The executor observes the existing state and writes nothing.
const fakeScript = `
executor:
  T001:
    status: completed
    summary: "no change required: src/there.cjs already exists and loads (observed via the criterion)"
    changes: []
`;

function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, "src", "there.cjs"), 'module.exports = { ok: true };\n');
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake-script.yaml\n");
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}

describe("no-op as a first-class successful outcome", () => {
  it("a task that confirms existing state completes with an empty diff and the run succeeds", async () => {
    const repo = setupRepo("noop");
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(
      paths.planFile("plan-noop"),
      JSON.stringify({
        apiVersion: "spc.dev/v1alpha1",
        kind: "Plan",
        metadata: { id: "plan-noop", createdAt: "now" },
        spec: { id: "pre", digest: ir.digest },
        repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
        tasks: [
          { id: "T001", title: "Confirm module", kind: "modify", intent: "confirm the module exists", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/there.cjs"] } },
        ],
      }),
    );
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });

    expect(report.status).toBe("succeeded");
    const state = JSON.parse(readFileSync(paths.stateFile(report.runId), "utf8")) as { tasks: Record<string, { status: string }> };
    expect(state.tasks["T001"]?.status).toBe("completed");
    // Nothing was written: no result commit beyond the base, empty diff.
    expect(report.changedFileCount ?? 0).toBe(0);
    // The task's no-op justification is recorded where task summaries live
    // (the event log and state), not required in the run-level summary.
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).toContain("no change required");
    // And the evidence still proves the property against the tree.
    const req = report.requirements.find((r) => r.propertyId === "FEAT-A");
    expect(req?.status).toBe("satisfied");
  }, 120_000);
});
