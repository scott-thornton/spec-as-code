import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk, statusPorcelain } from "@spc/repo";
import { applyPlan, runEndedDirtyPaths } from "./apply.js";
import { spcPaths } from "./paths.js";

// Oracle for specs/run-end-dirty-assertion.yaml: a run that ends leaving
// run-caused dirt uncommitted says so - at run end, in the durable
// record, not at the next run's first breath (incident: run
// run-mvx2fpfx recorded FILE_CHANGED pnpm-lock.yaml, the run-end commit
// a866e5f omitted it, the run finished silently, the NEXT run aborted
// DIRTY_REPOSITORY). The assertion observes, never gates; the run-end
// commit carries the run status so git log alone says whether HEAD's
// run was green.
const root = mkdtempSync(path.join(tmpdir(), "spc-dte-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: dte
  title: fixture
goal: A file exists.
requirements:
  - id: DTE-F
    statement: File exists.
    priority: must
    acceptance:
      - id: DTE-F-A
        type: file
        path: src/a.mjs
        assert:
          contains: "feature-a"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

// A second spec whose criterion command DIRTIES a tracked file after the
// run-end commit (the sweep runs post-commit): the deterministic
// producer of run-caused post-commit dirt - the assertion's real target.
const dirtySpecYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: dted
  title: fixture
goal: A file exists.
requirements:
  - id: DTE-F
    statement: File exists.
    priority: must
    acceptance:
      - id: DTE-F-A
        type: file
        path: src/a.mjs
        assert:
          contains: "feature-a"
      - id: DTE-F-B
        type: command
        command: node dirt.cjs
`;
const dirtyIr = compileSpecSource(dirtySpecYaml, "specs/spec.yaml").ir!;

function setupRepo(name: string, spec: string = specYaml, extraFiles: Record<string, string> = {}): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), spec);
  for (const [f, c] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), c, "utf8");
  }
  writeFileSync(path.join(repo, ".spc", "config.yaml"), ["version: 1", "provider:", "  name: fake", "  script: .spc/fake-script.yaml"].join("\n"));
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}

function writePlan(repo: string, id: string, digest: string): void {
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(
    paths.planFile(id),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-dte", createdAt: new Date().toISOString() },
      spec: { id: id.includes("dirty") ? "dted" : "dte", digest },
      repository: { revision: "0".repeat(40), snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        {
          id: "T001",
          title: "create the file",
          kind: "modify",
          intent: "create src/a.mjs",
          dependsOn: [],
          satisfies: ["DTE-F"],
          targets: { write: ["src/a.mjs"] },
        },
      ],
    }),
    "utf8",
  );
}

const executorScript = parseFakeScript(`
executor:
  T001:
    status: completed
    summary: create the file
    changes:
      - op: create
        path: src/a.mjs
        content: |
          export const a = "feature-a";
`);

describe("run-end dirty assertion (DTE-001, DTE-002)", () => {
  it("a successful run's end commit carries the SPC-Run-Status trailer; a clean tree emits no RUN_ENDED_DIRTY", { timeout: 120_000 }, async () => {
    const repo = setupRepo("clean");
    writePlan(repo, "plan-dte", ir.digest);
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(executorScript), log: () => {} });
    expect(report.status).toBe("succeeded");

    // DTE-002: git log alone answers whether HEAD's run was green.
    const msg = gitOk(report.worktree!, ["log", "-1", "--format=%B"]).stdout;
    expect(msg).toContain("SPC-Run-Status: succeeded");

    // DTE-001: clean run-end tree stays silent.
    const events = readFileSync(path.join(spcPaths(repo).runsDir, report.runId, "events.jsonl"), "utf8");
    expect(events).not.toContain("RUN_ENDED_DIRTY");
  });

  it("criterion-command dirt after the run-end commit fires RUN_ENDED_DIRTY naming the path - observed, never gating", { timeout: 120_000 }, async () => {
    const repo = setupRepo(
      "dirty",
      dirtySpecYaml,
      { "dirt.cjs": "import { appendFileSync } from 'node:fs'; appendFileSync('dirt.txt', 'x\\n');\n", "dirt.txt": "" },
    );
    writePlan(repo, "plan-dted", dirtyIr.digest);
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(executorScript), log: () => {} });
    // Observed, never gated: the run still succeeds on its file criterion.
    expect(report.status).toBe("succeeded");
    const events = readFileSync(path.join(spcPaths(repo).runsDir, report.runId, "events.jsonl"), "utf8");
    expect(events).toContain("RUN_ENDED_DIRTY");
    expect(events).toContain("dirt.txt");
    // The report carries the paths.
    expect((report as { runEndedDirtyPaths?: string[] }).runEndedDirtyPaths).toContain("dirt.txt");
  });

  it("the dirty-path predicate: run dirt named, .spc and allowDirtyPaths exempt, clean silent", () => {
    const repo = path.join(root, "pred");
    mkdirSync(path.join(repo, ".spc", "runs", "r1"), { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "a.ts"), "a\n", "utf8");
    writeFileSync(path.join(repo, "src", "b.ts"), "b\n", "utf8");
    writeFileSync(path.join(repo, "src", "c.ts"), "c\n", "utf8");
    gitOk(repo, ["init", "-b", "main"]);
    gitOk(repo, ["config", "user.email", "t@t"]);
    gitOk(repo, ["config", "user.name", "t"]);
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-q", "-m", "base"]);

    // Clean tree: nothing.
    expect(runEndedDirtyPaths(statusPorcelain(repo), [])).toEqual([]);

    // Run dirt: named. .spc dirt: exempt. allowDirtyPaths: exempt.
    writeFileSync(path.join(repo, "src", "a.ts"), "changed\n", "utf8");
    writeFileSync(path.join(repo, "src", "b.ts"), "changed\n", "utf8");
    writeFileSync(path.join(repo, "src", "new.ts"), "new\n", "utf8");
    gitOk(repo, ["add", ".spc/runs/r1/x.log"]); // .spc dirt, staged to appear in status
    const named = runEndedDirtyPaths(statusPorcelain(repo), ["src/b.ts"]);
    expect(named).toContain("src/a.ts");
    expect(named).toContain("src/new.ts");
    expect(named).not.toContain("src/b.ts");
    expect(named.every((p: string) => !p.startsWith(".spc/"))).toBe(true);
  });
});
