import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { spawnSync } from "node:child_process";
function shGit(repo: string, args: string[]): { stdout: string } {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" }) as { stdout: string };
}
import { applyPlan, spcPaths } from "./index.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: driftspec
  title: Drift spec
goal: fixture
requirements:
  - id: DR-001
    statement: The marker exists.
    priority: must
    acceptance:
      - id: DR-001-A
        type: command
        command: node --test "tests/*.test.mjs"
`;

let roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-drift-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(
    path.join(repo, "tests", "drift.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { m } from "../src/module.mjs";',
      'test("marker", () => { assert.ok(m()); });',
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake.yaml\nexecution:\n  inPlace: true\n  inPlaceBranch: current\n");
  writeFileSync(path.join(repo, ".spc", "fake.yaml"), "planner:\n  value: {}\nexecutor:\n  T001:\n    status: completed\n    summary: work\n    changes:\n      - op: create\n        path: src/module.mjs\n        content: |\n          export function m() { return true; }\n");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  shGit(repo, ["init", "-q", "-b", "main"]);
  shGit(repo, ["config", "user.email", "t@t"]);
  shGit(repo, ["config", "user.name", "t"]);
  shGit(repo, ["add", "."]);
  shGit(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

describe("plan drift visibility (Finding D)", () => {
  it("a plan whose recorded revision differs from the apply base emits PLAN_DRIFT and a non-blocking follow-up", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    // A plan bound to a FICTIONAL old revision: current HEAD differs.
    const plan: Plan = {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-drift", createdAt: "2026-10-20T00:00:00.000Z" },
      spec: { id: "driftspec", digest: ir.digest },
      repository: { revision: "0000000000000000000000000000000000000000", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        { id: "T001", title: "Work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["DR-001"], targets: { write: ["src/module.mjs"] } },
      ],
    } as never;
    writeFileSync(paths.planFile("plan-drift"), JSON.stringify(plan, null, 2));

    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(readFileSync(path.join(repo, ".spc", "fake.yaml"), "utf8"))), log: () => {} });
    // Warn policy: the run still proceeds (and succeeds - the fixture passes).
    expect(report.status).toBe("succeeded");
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).toContain("PLAN_DRIFT");
    // Non-blocking follow-up recorded.
    const followups = JSON.parse(readFileSync(paths.followupsFile(report.runId), "utf8")) as { blocking: boolean; title: string }[];
    expect(followups.some((f) => /drift/i.test(f.title) && !f.blocking)).toBe(true);
  });

  it("no drift event when the plan revision matches the base", { timeout: 120_000 }, async () => {
    const repo = setup();
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    const head = shGit(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const plan: Plan = {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-fresh", createdAt: "2026-10-20T00:00:00.000Z" },
      spec: { id: "driftspec", digest: ir.digest },
      repository: { revision: head, snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        { id: "T001", title: "Work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["DR-001"], targets: { write: ["src/module.mjs"] } },
      ],
    } as never;
    writeFileSync(paths.planFile("plan-fresh"), JSON.stringify(plan, null, 2));
    const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(readFileSync(path.join(repo, ".spc", "fake.yaml"), "utf8"))), log: () => {} });
    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).not.toContain("PLAN_DRIFT");
  });
});
