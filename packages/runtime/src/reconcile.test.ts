import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { loadConfig } from "./run.js";
import { reconcile } from "./reconcile.js";
import { spcPaths } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-reconcile-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: greeting-api
  title: Greeting API
goal: Expose a greeting function that returns "hello".
requirements:
  - id: GREETING-001
    statement: Calling greeting returns "hello".
    priority: must
    acceptance:
      - id: GREETING-001-A
        type: command
        command: node --test "tests/*.test.mjs"
`;

function greetingScript(): FakeProvider {
  return new FakeProvider(
    parseFakeScript(`
planner:
  value:
    plan:
      tasks:
        - id: T001
          title: Implement greeting
          kind: modify
          intent: create the greeting function
          dependsOn: []
          satisfies: [GREETING-001]
          targets:
            read: [tests/**]
            write: [src/greeting.mjs]
        - id: T002
          title: Verify greeting
          kind: verify
          intent: run acceptance
          dependsOn: [T001]
          verifies: [GREETING-001]
    observations: []
    assumptions: []
    followups: []
executor:
  T001:
    status: completed
    summary: Implemented greeting.
    changes:
      - op: create
        path: src/greeting.mjs
        content: |
          export function greeting() {
            return "hello";
          }
`),
  );
}

function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/worktrees/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "greeting.yaml"), specYaml);
  writeFileSync(
    path.join(repo, "tests", "greeting.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "../src/greeting.mjs";\ntest("greeting", () => {\n  assert.equal(greeting(), "hello");\n});\n',
  );
  commitAll(repo, "init");
  return repo;
}

async function applyGreeting(repo: string): Promise<void> {
  const ir = compileSpecSource(specYaml, "specs/greeting.yaml").ir!;
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(
    paths.planFile("plan-original"),
    JSON.stringify(
      {
        apiVersion: "spc.dev/v1alpha1",
        kind: "Plan",
        metadata: { id: "plan-original", createdAt: "now" },
        spec: { id: "greeting-api", digest: ir.digest },
        repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
        tasks: [
          { id: "T001", title: "Implement greeting", kind: "modify", intent: "i", dependsOn: [], satisfies: ["GREETING-001"], targets: { read: ["tests/**"], write: ["src/greeting.mjs"] } },
          { id: "T002", title: "Verify", kind: "verify", intent: "v", dependsOn: ["T001"], verifies: ["GREETING-001"] },
        ],
      },
      null,
      2,
    ),
  );
  await applyPlan({ repoRoot: repo }, { providerFactory: async () => greetingScript(), log: () => {} });
}

describe("reconcile", () => {
  it("detects drift, generates the next transition, and (with --apply) closes it", async () => {
    const repo = setupRepo("drift");
    await applyGreeting(repo); // fix lands on a branch; main stays unsatisfied

    const ir = compileSpecSource(specYaml, "specs/greeting.yaml").ir!;
    const config = loadConfig(path.join(repo, ".spc", "config.yaml"));
    const deps = { providerFactory: async () => greetingScript(), log: () => {} };

    // Default: drift reported, plan generated, nothing applied.
    const inspect = await reconcile({ repoRoot: repo, specIr: ir, config, deps });
    expect(inspect.inSync).toBe(false);
    expect(inspect.drifted.map((d) => d.propertyId)).toContain("GREETING-001");
    expect(inspect.drifted[0]!.status).toBe("unsatisfied");
    expect(inspect.planId).toBeTruthy();
    expect(inspect.applied).toBeUndefined();

    // --apply: the generated transition executes to succeeded.
    const applied = await reconcile({ repoRoot: repo, specIr: ir, config, apply: true, deps });
    expect(applied.applied?.status).toBe("succeeded");
    expect(applied.applied?.requirements.find((r) => r.propertyId === "GREETING-001")?.status).toBe("satisfied");
  });

  it("reports in-sync when the current tree satisfies the spec", async () => {
    const repo = setupRepo("sync");
    // Merge the fix into main directly, then reconcile.
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "greeting.mjs"), 'export function greeting() {\n  return "hello";\n}\n');
    commitAll(repo, "add greeting");

    const ir = compileSpecSource(specYaml, "specs/greeting.yaml").ir!;
    const result = await reconcile({
      repoRoot: repo,
      specIr: ir,
      config: loadConfig(path.join(repo, ".spc", "config.yaml")),
      deps: { providerFactory: async () => greetingScript(), log: () => {} },
    });
    expect(result.inSync).toBe(true);
    expect(result.drifted).toEqual([]);
  });
});
