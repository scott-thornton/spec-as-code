import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LINT_RULES } from "./commands/lint.js";

// Oracle for specs/plan-target-gap.yaml: the advisory join between a
// task's intent prose and its declared targets - the three
// OUT_OF_SCOPE_WRITE incidents of the 2026-10-23/24 programme, caught
// at plan-validate time instead of mid-apply. Prose never manufactures
// certainty: ambiguous basenames stay silent.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-ptg-"));
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
  id: ptg
  title: fixture
goal: fixture
requirements:
  - id: PTG-001
    statement: Thing works.
    priority: must
    acceptance:
      - id: PTG-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "packages", "runtime", "src"), { recursive: true });
mkdirSync(path.join(root, "packages", "cli", "src"), { recursive: true });
mkdirSync(path.join(root, ".spc", "plans"), { recursive: true });
writeFileSync(path.join(root, "specs", "spec.yaml"), specYaml, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, "packages", "runtime", "src", "queries.ts"), "export {};\n", "utf8");
writeFileSync(path.join(root, "packages", "runtime", "src", "state.ts"), "export {};\n", "utf8");
writeFileSync(path.join(root, "packages", "cli", "src", "state.ts"), "export {};\n", "utf8");
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

function planFile(name: string, intent: string, write: string[], read: string[] = []): string {
  const file = path.join(root, ".spc", "plans", `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: name, createdAt: "2026-10-25T00:00:00.000Z" },
      spec: { id: "ptg", digest },
      repository: { revision: "0".repeat(40), snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [
        {
          id: "T001",
          title: "Work",
          kind: "modify",
          intent,
          dependsOn: [],
          satisfies: ["PTG-001"],
          targets: { write, ...(read.length ? { read } : {}) },
        },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("LINT-PLAN-TARGET-GAP (plan-target-gap)", () => {
  it("warns when the intent names an uncovered repository file - the queries.ts incident", () => {
    const f = planFile(
      "p-gap",
      "Thread prepareOutcome through createVerifyRun in packages/runtime/src/queries.ts and wire the CLI.",
      ["packages/cli/src/**"],
    );
    const r = sh(["plan", "validate", f]);
    expect(r.status).toBe(0); // advisory: warnings never gate
    expect(r.stdout).toContain("LINT-PLAN-TARGET-GAP");
    expect(r.stdout).toContain("packages/runtime/src/queries.ts");
  });

  it("stays silent when the intent path is covered by write targets", () => {
    const f = planFile(
      "p-covered",
      "Rework createVerifyRun in packages/runtime/src/queries.ts thoroughly.",
      ["packages/runtime/src/**"],
    );
    const r = sh(["plan", "validate", f]);
    expect(r.stdout).not.toContain("LINT-PLAN-TARGET-GAP");
  });

  it("stays silent when the path is covered by READ targets (read-only mention)", () => {
    const f = planFile(
      "p-read",
      "Mirror the behavior of packages/runtime/src/queries.ts in the CLI layer.",
      ["packages/cli/src/**"],
      ["packages/runtime/src/**"],
    );
    const r = sh(["plan", "validate", f]);
    expect(r.stdout).not.toContain("LINT-PLAN-TARGET-GAP");
  });

  it("stays silent for an ambiguous basename - two repository files match state.ts", () => {
    const f = planFile(
      "p-ambiguous",
      "Update state.ts where the run metadata lives.",
      ["packages/cli/src/**"],
    );
    const r = sh(["plan", "validate", f]);
    expect(r.stdout).not.toContain("LINT-PLAN-TARGET-GAP");
  });

  it("stays silent for paths that do not exist in the repository", () => {
    const f = planFile(
      "p-absent",
      "Similar in spirit to packages/nonexistent/src/thing.ts but different.",
      ["packages/cli/src/**"],
    );
    const r = sh(["plan", "validate", f]);
    expect(r.stdout).not.toContain("LINT-PLAN-TARGET-GAP");
  });

  it("the registry entry carries provenance and validity dimensions (PT-002)", () => {
    const entry = LINT_RULES.find((r) => r.id === "LINT-PLAN-TARGET-GAP");
    expect(entry).toBeDefined();
    expect(entry!.motivation).toMatch(/OUT_OF_SCOPE_WRITE/);
    expect(entry!.negativeFixture.length).toBeGreaterThan(10);
    expect(entry!.positiveFixture.length).toBeGreaterThan(10);
    expect(entry!.validityDimensions).toContain("criterion");
  });
});
