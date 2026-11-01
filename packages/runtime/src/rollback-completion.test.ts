import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { commitAll, gitOk } from "@spc/repo";
import type { LLMProvider, StructuredRequest, StructuredResponse } from "@spc/llm";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

// Oracle for specs/rollback-completion-visibility.yaml: an empty-delta
// completion after a failed prior attempt is the aftermath of a
// rollback, and the record must say so (incident: run-mvx32fwy T003 -
// attempt 1 staged valid work, failed OUT_OF_SCOPE_WRITE, the violation
// rollback deleted it, attempt 2 completed empty, the state read
// "completed" while every file was gone). The duplicate-answer no-ops
// class (work present, NO prior failure) stays unmarked; a completion
// WITH changes after a failure stays unmarked.
const root = mkdtempSync(path.join(tmpdir(), "spc-rvc-"));
afterAll(() => {
  // SPC_KEEP_FIXTURE=1 preserves the fixture for post-failure diagnosis
  // (a convention, never an assertion change; the path prints loudly).
  if (process.env.SPC_KEEP_FIXTURE) {
    console.error(`[KEEP_FIXTURE] packages/runtime/src/rollback-completion.test.ts: ${root}`);
    return;
  }
  rmSync(root, { recursive: true, force: true });
});

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: rvc
  title: fixture
goal: A module exists.
requirements:
  - id: RVC-F
    statement: Module exists.
    priority: must
    acceptance:
      - id: RVC-F-A
        type: file
        path: src/mod.mjs
        assert:
          contains: "ok"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

/** Deterministic per-round provider: each task key serves answers in
 *  order, repeating the last (the executor re-dispatch rounds). */
class RoundProvider implements LLMProvider {
  name = "rounds";
  model = "rounds";
  private calls = new Map<string, number>();
  constructor(private readonly script: Record<string, unknown[]>) {}
  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    // Task-scoped, not dispatch-scoped: attempt 2 dispatches as
    // "<task>@2" and must serve the script's next round.
    const key = (request.key ?? "").split("@")[0]!;
    const answers = this.script[key] ?? [];
    const n = Math.min(this.calls.get(key) ?? 0, answers.length - 1);
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    return { value: answers[n] as T, usage: { model: this.model, durationMs: 0 } };
  }
}

function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, ".spc", "config.yaml"), ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml"].join("\n"));
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}

function writePlan(repo: string): void {
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(
    paths.planFile("plan-rvc"),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-rvc", createdAt: new Date().toISOString() },
      spec: { id: "rvc", digest: ir.digest },
      repository: { revision: "0".repeat(40), snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        { id: "T001", title: "create the module", kind: "modify", intent: "i", dependsOn: [], satisfies: ["RVC-F"], targets: { write: ["src/mod.mjs"] } },
      ],
    }),
    "utf8",
  );
}

const CREATE = {
  status: "completed",
  summary: "create the module",
  changes: [{ op: "create", path: "src/mod.mjs", content: "export const ok = 1;\n" }],
  commands: [],
  observations: [],
  evidenceCandidates: [],
  followups: [],
};
const CREATE_WITH_VIOLATION = {
  ...CREATE,
  commands: [{ command: 'node -e "require(\'fs\').writeFileSync(\'side.txt\',\'x\')"' }],
};
const NOOPS = { status: "completed", summary: "no changes needed", changes: [], commands: [], observations: [], evidenceCandidates: [], followups: [] };

function eventsOf(repo: string, runId: string): string {
  return readFileSync(path.join(spcPaths(repo).runsDir, runId, "events.jsonl"), "utf8");
}

describe("rollback-completion-visibility (RVC-001, RVC-002)", () => {
  it("an empty-delta completion after a failed prior attempt is marked in event, state and summary", { timeout: 120_000 }, async () => {
    const repo = setupRepo("flagged");
    writePlan(repo);
    const report = await applyPlan(
      { repoRoot: repo },
      { providerFactory: async () => new RoundProvider({ T001: [CREATE_WITH_VIOLATION, NOOPS] }), log: () => {} },
    );
    // The no-ops completion is legitimate recovery; the run still lands.
    expect(report.status).toBe("succeeded");

    const events = eventsOf(repo, report.runId);
    expect(events).toContain("emptyDeltaAfterPriorFailure");
    const state = JSON.parse(readFileSync(spcPaths(repo).stateFile(report.runId), "utf8")) as {
      tasks: Record<string, { emptyDeltaAfterPriorFailure?: boolean }>;
    };
    expect(state.tasks["T001"]?.emptyDeltaAfterPriorFailure).toBe(true);
    const summary = readFileSync(path.join(spcPaths(repo).runsDir, report.runId, "summary.md"), "utf8");
    expect(summary).toContain("empty delta after prior failure");
    expect(summary).toContain("prior work was reverted");
  });

  it("a clean single-attempt completion carries no marker", { timeout: 120_000 }, async () => {
    const repo = setupRepo("clean");
    writePlan(repo);
    const report = await applyPlan(
      { repoRoot: repo },
      { providerFactory: async () => new RoundProvider({ T001: [CREATE] }), log: () => {} },
    );
    expect(report.status).toBe("succeeded");
    expect(eventsOf(repo, report.runId)).not.toContain("emptyDeltaAfterPriorFailure");
  });

  it("a completion WITH changes after a failed attempt carries no marker - work landed, not reverted", { timeout: 120_000 }, async () => {
    const repo = setupRepo("repaired");
    writePlan(repo);
    const report = await applyPlan(
      { repoRoot: repo },
      { providerFactory: async () => new RoundProvider({ T001: [CREATE_WITH_VIOLATION, CREATE] }), log: () => {} },
    );
    expect(report.status).toBe("succeeded");
    expect(eventsOf(repo, report.runId)).not.toContain("emptyDeltaAfterPriorFailure");
  });
});
