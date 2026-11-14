import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { gitOk } from "@spc/repo";
import type { Plan } from "@spc/schema";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

// Oracle for specs/oracle-identity-wiring.yaml (red, committed
// pre-run): the gate governs REAL synthesis. Two fixture histories in
// one repo - a criterion whose oracle bytes MATCH across its red/green
// halves (synthesizes) and one whose oracle bytes DIFFER (rejected:
// indeterminate, SYNTHESIS_REJECTED event with both run ids). Today
// computeChainFlipMemory synthesizes both - the drift candidate is the
// red, this is the wiring.
const root = mkdtempSync(path.join(tmpdir(), "spc-oidw-"));
const repo = path.join(root, "repo");
const PKGS = new Map([["@demo/pkg", "packages/demo"]]);

const SPEC = (id: string, cmdTail: string): string =>
  `apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: ${id}\n  title: ${id}\ngoal: >\n  g\nrequirements:\n  - id: R-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: ${id.toUpperCase()}-A\n        type: command\n        command: node packages/demo/${cmdTail}\n        expect: {exitCode: 0}\n        discriminating: true\n`;

function planFor(specId: string, digest: string): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: `plan-${specId}`, createdAt: "2026-11-14T00:00:00.000Z" },
    spec: { id: specId, digest },
    repository: { revision: "r", snapshotDigest: "sha256:" + "0".repeat(64) },
    tasks: [
      {
        id: "T001",
        title: "Fix",
        kind: "modify",
        intent: "fix the implementation",
        dependsOn: [],
        satisfies: ["R-001"],
        targets: { read: [], write: ["packages/demo/impl.js"] },
      },
    ],
  } as unknown as Plan;
}

const executorScript = (target: string): FakeProvider =>
  new FakeProvider(
    parseFakeScript(
      `executor:\n  T001:\n    status: completed\n    summary: fixed\n    changes:\n      - op: update\n        path: packages/demo/impl.js\n        content: |\n          module.exports = () => 0;\n`,
    ),
  );

const git = (args: string[]): void => {
  const r = gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  void r;
};
const rev = (): string => spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

async function runCycle(specId: string): Promise<void> {
  const paths = spcPaths(repo);
  const m = await import("@spc/repo");
  const c = m.compileSpecFile(path.join(repo, "specs", `${specId}.yaml`));
  if (!c.ok || !c.ir) throw new Error(`fixture spec ${specId} does not compile`);
  const digest = c.ir.digest;
  mkdirSync(paths.plansDir, { recursive: true });
  const planId = `plan-${specId}`;
  writeFileSync(paths.planFile(planId), JSON.stringify(planFor(specId, digest), null, 2));
  const report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => executorScript(planId), log: () => {} });
  void report;
}

beforeAll(async () => {
  // The fixture: a workspace with one package, two criteria
  // (stable - oracle never edited; drifted - oracle edited between
  // the red run and the green run), both discriminating.
  const w = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), content, "utf8");
  };
  w(".gitignore", ".spc/\n");
  w("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  w("package.json", '{ "name": "root", "private": true }\n');
  w("packages/demo/package.json", '{ "name": "@demo/pkg", "private": true }\n');
  // The IMPL starts broken (exit 1): both criteria red at base.
  w("packages/demo/impl.js", "module.exports = () => 1;\n");
  // The ORACLES: stable-check.js never changes; drifted-check.js is
  // edited between the red run and the green run (the oracle fix).
  w("packages/demo/stable-check.js", 'if (require("./impl.js")() !== 0) process.exit(1);\n');
  w("packages/demo/drifted-check.js", 'if (require("./impl.js")() !== 0) { console.error("wrong AND a bogus extra condition"); process.exit(1); }\n');
  w("specs/stable.yaml", SPEC("stable", "stable-check.js"));
  w("specs/drifted.yaml", SPEC("drifted", "drifted-check.js"));
  w(".spc/config.yaml", "version: 1\nprovider:\n  name: fake\n  script: .spc/fake.yaml\nexecution:\n  inPlace: true\n  inPlaceBranch: current\nverification:\n  requireRedPhase: true\n");
  w(".spc/fake.yaml", "executor:\n  T001:\n    status: completed\n    summary: x\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  // RED RUNS: both criteria fail (impl broken), recorded in their runs.
  await runCycle("stable");
  await runCycle("drifted");
  // BETWEEN RUNS: the oracle fix (drifted-check.js edited - the
  // oracle bytes now differ across the halves) - exactly the session's
  // rectification shape.
  w("packages/demo/drifted-check.js", 'if (require("./impl.js")() !== 0) process.exit(1);\n');
  git(["add", "-A"]);
  git(["commit", "-qm", "oracle fix between runs"]);
  // GREEN RUNS: impl fixed; both criteria pass at base (the
  // candidates for synthesis).
  await runCycle("stable");
  await runCycle("drifted");
}, 300_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("OIDW-001/002: the gate governs real synthesis", () => {
  it("the stable candidate (oracle bytes match across halves) still synthesizes - the criterion renders satisfied", async () => {
    await runCycle("stable");
    const status = spawnSync("git", ["log", "-1", "--format=%B"], { cwd: repo, encoding: "utf8" }).stdout;
    void status;
    // The run table is the assertion surface: check the newest run's summary.
    const paths = spcPaths(repo);
    const runs = readdirSync(paths.runsDir).filter((d) => d.startsWith("run-")).sort();
    const newest = runs[runs.length - 1]!;
    // This run's own summary is for the stable spec; its R-001 must be
    // satisfied via the inherited flip (matched oracle).
    const summary = readFileSync(path.join(paths.runsDir, newest, "summary.md"), "utf8");
    expect(summary).toMatch(/satisfied.*R-001|R-001.*satisfied/);
    expect(summary).not.toMatch(/unsatisfied.*R-001|R-001.*unsatisfied/);
  }, 180_000);

  it("the drifted candidate (oracle bytes differ across halves) is REJECTED - indeterminate, with a SYNTHESIS_REJECTED event carrying both run ids", async () => {
    await runCycle("drifted");
    const paths = spcPaths(repo);
    const runs = readdirSync(paths.runsDir).filter((d) => d.startsWith("run-")).sort();
    const newest = runs[runs.length - 1]!;
    const summary = readFileSync(path.join(paths.runsDir, newest, "summary.md"), "utf8");
    // The demotion: NOT satisfied - indeterminate (the gate refused).
    expect(summary).toMatch(/indeterminate/);
    expect(summary).not.toMatch(/satisfied\s+R-001/);
    // The rejected candidate is preserved as an event.
    const events = readFileSync(path.join(paths.runsDir, newest, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const rejected = events.find((e) => e.type === "SYNTHESIS_REJECTED");
    expect(rejected).toBeDefined();
    const payload = JSON.stringify(rejected?.payload);
    expect(payload).toMatch(/drifted-check\.js/);
    expect(payload).toMatch(/oracle-drift|oracle-drift/);
    // Both run ids preserved (the ruling's rendering requirement).
    const driftRuns = runs.filter((r) => {
      const f = path.join(paths.runsDir, r, "metadata.json");
      if (!existsSync(f)) return false;
      return (JSON.parse(readFileSync(f, "utf8")) as { specId?: string }).specId === "drifted";
    });
    expect(driftRuns.length).toBeGreaterThanOrEqual(2);
    for (const runId of driftRuns.slice(0, 2)) {
      expect(payload).toContain(runId);
    }
  }, 180_000);
});
