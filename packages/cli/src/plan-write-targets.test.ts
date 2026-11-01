import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validatePlan, type Plan, type SpecIR } from "@spc/core";

// Oracle for specs/plan-write-target-validation.yaml: a write target
// that cannot match what the task will write is a compile error, not a
// staging surprise four dispatches later. Runtime write-scope
// enforcement GLOBS; a bare directory name matches only the literal
// path, never its children (run-mvx32fwy T003: plan validated clean,
// every staging failed OUT_OF_SCOPE_WRITE, the rollback reverted 13
// files of valid work). Non-glob FILE targets stay valid - a future
// file path is precise authorship. The validator stays pure for
// callers without a tree: absent repoRoot, no check.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-pwt-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: pwt
  title: fixture
goal: fixture
requirements:
  - id: PWT-001
    statement: Thing works.
    priority: must
    acceptance:
      - id: PWT-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "packages", "runtime", "src"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
writeFileSync(path.join(root, "specs", "spec.yaml"), specYaml, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, "packages", "runtime", "src", "queries.ts"), "export {};\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "t@t"]);
gitsh(["config", "user.name", "t"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

const digest = (() => {
  const out = sh(["spec", "validate", "specs/spec.yaml"]).stdout;
  return /Digest: (sha256:\w+)/.exec(out)?.[1] ?? `sha256:${"0".repeat(64)}`;
})();

function planFileJson(name: string, write: string[]): string {
  return JSON.stringify({
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: name, createdAt: "2026-11-01T00:00:00.000Z" },
    spec: { id: "pwt", digest },
    repository: { revision: "0".repeat(40), snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      {
        id: "T001",
        title: "Work",
        kind: "modify",
        intent: "edit the runtime package",
        dependsOn: [],
        satisfies: ["PWT-001"],
        targets: { write },
      },
    ],
  });
}

function planFile(name: string, write: string[]): string {
  const file = path.join(root, ".spc", "plans", `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: name, createdAt: "2026-11-01T00:00:00.000Z" },
      spec: { id: "pwt", digest },
      repository: { revision: "0".repeat(40), snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        {
          id: "T001",
          title: "Work",
          kind: "modify",
          intent: "edit the runtime package",
          dependsOn: [],
          satisfies: ["PWT-001"],
          targets: { write },
        },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("plan write-target validation (PWT-001, PWT-002)", () => {
  it("a bare-directory write target fails plan validation naming the target and the glob fix", () => {
    const r = sh(["plan", "validate", planFile("p-bare", ["packages/runtime/src"])]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("packages/runtime/src");
    expect(r.stdout).toMatch(/literal/);
    expect(r.stdout).toContain("packages/runtime/src/**");
  });

  it("a trailing-slash directory target is already refused (unsafe-path rule); it must not slip through", () => {
    const r = sh(["plan", "validate", planFile("p-slash", ["packages/runtime/src/"])]);
    expect(r.status).not.toBe(0);
  });

  it("exact file targets, globs, and not-yet-existing file paths stay valid", () => {
    expect(sh(["plan", "validate", planFile("p-file", ["packages/runtime/src/queries.ts"])]).status).toBe(0);
    expect(sh(["plan", "validate", planFile("p-glob", ["packages/runtime/src/**"])]).status).toBe(0);
    expect(sh(["plan", "validate", planFile("p-future", ["packages/runtime/src/new-module.ts"])]).status).toBe(0);
  });

  it("the validator stays pure without a tree: absent repoRoot, no bare-directory check", () => {
    const plan = JSON.parse(planFileJson("p-pure", ["packages/runtime/src"])) as Plan;
    const ir = {
      spec: { metadata: { id: "pwt", title: "fixture" } },
      properties: [{ id: "PWT-001", kind: "requirement", statement: "s", priority: "must", dependsOn: [], acceptance: [] }],
      digest,
    } as unknown as SpecIR;
    const withoutRoot = validatePlan(plan, ir);
    expect(withoutRoot.some((d) => /literal/.test(d.message))).toBe(false);
    const withRoot = validatePlan(plan, ir, root);
    expect(withRoot.some((d) => /literal/.test(d.message) && /packages\/runtime\/src/.test(d.message))).toBe(true);
  });
});
