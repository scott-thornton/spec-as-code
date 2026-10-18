import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "@spc/runtime";
import { spcPaths } from "@spc/runtime";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-bundle-"));
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

function spc(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function exportedBundle(name: string): Promise<string> {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/exports/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake-script.yaml\n");
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(
    paths.planFile("plan-b"),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-b", createdAt: "now" },
      spec: { id: "greet", digest: ir.digest },
      repository: { revision: "r", snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        { id: "T001", title: "Write greet", kind: "modify", intent: "create src/greet.cjs", dependsOn: [], satisfies: ["FEAT-A"], targets: { write: ["src/greet.cjs"] } },
      ],
    }),
  );
  const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(fakeScript)), log: () => {} });
  expect(report.status).toBe("succeeded");
  const bundle = path.join(paths.spcDir, "exports", report.runId);
  const { exportRun } = await import("@spc/runtime");
  exportRun(repo, report.runId);
  return bundle;
}

describe("spc verify --bundle", () => {
  it("verifies a clean export's integrity and derivation without the repo", async () => {
    const bundle = await exportedBundle("clean");
    // Run from ANY cwd - the bundle is self-contained; no repo needed.
    const r = spc(path.join(root, "clean"), ["verify", "--bundle", bundle]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bundle OK");
    expect(r.stdout).toContain("Manifest: verified");
    expect(r.stdout).toContain("Attestation: verified");
  }, 120_000);

  it("tampering a component after export fails the manifest", async () => {
    const bundle = await exportedBundle("tampered");
    const evFile = path.join(bundle, "run", "events.jsonl");
    const lines = readFileSync(evFile, "utf8").split("\n");
    const victim = JSON.parse(lines[2]!);
    victim.payload.forged = true;
    lines[2] = JSON.stringify(victim);
    writeFileSync(evFile, lines.join("\n"), "utf8");
    const r = spc(path.join(root, "tampered"), ["verify", "--bundle", bundle]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("BUNDLE FAILED");
    // The chain catches the edit itself (strict load throws; the CLI
    // renders it as a bundle failure with the reason).
    expect(r.stdout).toContain("chain break");
  }, 120_000);

  it("forging state.json diverges the projection", async () => {
    const bundle = await exportedBundle("forged");
    const stateFile = path.join(bundle, "run", "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { modelCalls: number };
    state.modelCalls = 0;
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
    const r = spc(path.join(root, "forged"), ["verify", "--bundle", bundle]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("DIVERGED");
    expect(r.stdout).toContain("modelCalls");
  }, 120_000);
});
