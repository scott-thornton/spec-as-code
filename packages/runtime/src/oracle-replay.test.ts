import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { compileSpecFile, gitOk } from "@spc/repo";
import type { Plan } from "@spc/schema";
import { applyPlan, type ApplyReport } from "./apply.js";
import { spcPaths } from "./paths.js";

// Oracle for specs/oracle-identity-replay.yaml (red, committed
// pre-run): slice 3 of the ruling - in-run oracle drift demands
// same-oracle counterfactual replay. Fixture A (the rectification
// shape): the task fixes the implementation AND corrects the oracle;
// the in-run flip crossed instrument drift; replay (final oracle
// against the base implementation) must go RED - the flip is
// ESTABLISHED with counterfactualFlip provenance. Fixture B (the
// weakened-oracle shape): the task weakens ONLY the oracle; replay
// goes GREEN against the unchanged broken implementation -
// green->green, indeterminate, never an unqualified flip. Today
// neither replay exists; A establishes silently (unqualified) and B
// establishes DISHONESTLY (the oracle change produced the flip).
// This is red.
const root = mkdtempSync(path.join(tmpdir(), "spc-oir-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: oir
  title: OIR
goal: >
  g
requirements:
  - id: R-001
    statement: s
    priority: must
    acceptance:
      - id: OIR-A
        type: command
        command: node packages/demo/check.js
        expect: {exitCode: 0}
        discriminating: true
`;

function executorWith(changes: { path: string; content: string }[]): FakeProvider {
  const lines = ["executor:", "  T001:", "    status: completed", "    summary: work", "    changes:"];
  for (const c of changes) {
    lines.push(`      - op: update`, `        path: ${c.path}`, `        content: |`);
    for (const l of c.content.split("\n")) lines.push(`          ${l}`);
  }
  return new FakeProvider(parseFakeScript(lines.join("\n") + "\n"));
}

function planFor(digest: string): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-oir", createdAt: "2026-11-15T00:00:00.000Z" },
    spec: { id: "oir", digest },
    repository: { revision: "r", snapshotDigest: "sha256:" + "0".repeat(64) },
    tasks: [
      { id: "T001", title: "fix", kind: "modify", intent: "i", dependsOn: [], satisfies: ["R-001"], targets: { read: [], write: ["packages/demo/impl.js", "packages/demo/check.js"] } },
    ],
  } as unknown as Plan;
}

interface FixtureRun {
  report: ApplyReport;
  runId: string;
  events: { type: string; payload?: Record<string, unknown> }[];
  evidence: { criterionId?: string; payload?: Record<string, unknown> }[];
}

async function scenario(name: string, changes: { path: string; content: string }[]): Promise<FixtureRun> {
  const repo = path.join(root, name);
  const w = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), content, "utf8");
  };
  const git = (args: string[]): void => {
    gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  };
  w(".gitignore", ".spc/\n");
  w("specs/oir.yaml", SPEC);
  // The BROKEN implementation and the BUGGY-ORACLE baseline: the
  // oracle fails against the broken impl for a WRONG reason (it also
  // demands a stale marker), so correcting the oracle is part of the
  // honest fix - the rectification shape.
  w("packages/demo/impl.js", "module.exports = () => 1; // broken\n");
  w("packages/demo/check.js", 'const v = require("./impl.js")();\nif (v !== 0) process.exit(1);\nif (!require("node:fs").existsSync("STALE_MARKER")) process.exit(1); // the oracle bug\n');
  w(".spc/config.yaml", "version: 1\nprovider:\n  name: fake\n  script: .spc/fake.yaml\nexecution:\n  inPlace: true\n  inPlaceBranch: current\nverification:\n  requireRedPhase: true\n");
  w(".spc/fake.yaml", "executor:\n  T001:\n    status: completed\n    summary: x\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const paths = spcPaths(repo);
  const compiled = compileSpecFile(path.join(repo, "specs", "oir.yaml"));
  const digest = compiled.ok && compiled.ir ? compiled.ir.digest : "";
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(paths.planFile("plan-oir"), JSON.stringify(planFor(digest), null, 2));
  const report = await applyPlan({ repoRoot: repo, planFile: paths.planFile("plan-oir") }, { providerFactory: async () => executorWith(changes), log: () => {} });
  // The run that just executed (latest by createdAt for spec oir).
  let best = { id: "", at: "" };
  for (const run of readdirSync(paths.runsDir)) {
    const mf = path.join(paths.runsDir, run, "metadata.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8")) as { specId?: string; createdAt?: string };
    if (m.specId !== "oir") continue;
    if (m.createdAt !== undefined && m.createdAt >= best.at) {
      best = { id: run, at: m.createdAt };
    }
  }
  return {
    report,
    runId: best.id,
    events: readFileSync(path.join(paths.runsDir, best.id, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    evidence: readFileSync(path.join(paths.runsDir, best.id, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

describe("OIR-001/002: the rectification shape - fix impl AND correct the oracle", () => {
  let run: FixtureRun;
  it("the flip is ESTABLISHED via counterfactual replay: the final oracle against the base implementation goes RED", async () => {
    run = await scenario("rectify", [
      { path: "packages/demo/impl.js", content: "module.exports = () => 0; // fixed" },
      { path: "packages/demo/check.js", content: 'const v = require("./impl.js")();\nif (v !== 0) process.exit(1); // corrected oracle\n' },
    ]);
    expect(run.report.status).toBe("succeeded");
    // The replay event: outcome red, both revisions, the overlaid path, counterfactualFlip provenance.
    const evt = run.events.find((e) => e.type === "COUNTERFACTUAL_REPLAY");
    expect(evt).toBeDefined();
    const p = evt?.payload ?? {};
    expect(String(p["outcome"])).toMatch(/red|contradicted/i);
    expect(String(p["provenance"])).toBe("counterfactualFlip");
    expect(String(JSON.stringify(p["overlaid"]))).toContain("check.js");
    expect(String(p["criterionId"])).toBe("OIR-A");
  }, 240_000);

  it("the requirement renders SATISFIED (replay red -> green under one oracle establishes)", () => {
    expect(run.report.status).toBe("succeeded");
    const summary = run.report;
    void summary;
    // status succeeded above is the assertion; the state detail must
    // not be indeterminate.
    expect(run.events.some((e) => e.type === "SYNTHESIS_REJECTED")).toBe(false);
  });
});

describe("OIR-001/002: the weakened-oracle shape - change ONLY the instrument", () => {
  let run: FixtureRun;
  it("the flip is REFUSED: replay goes GREEN against the unchanged broken implementation - green->green, indeterminate", async () => {
    run = await scenario("weaken", [
      { path: "packages/demo/check.js", content: "process.exit(0); // weakened: passes anything\n" },
    ]);
    const evt = run.events.find((e) => e.type === "COUNTERFACTUAL_REPLAY");
    expect(evt).toBeDefined();
    const p = evt?.payload ?? {};
    expect(String(p["outcome"])).toMatch(/green|supported/i);
    // The requirement renders indeterminate - never an unqualified flip.
    const summary = readFileSync(path.join(root, "weaken", ".spc", "runs", run.runId, "summary.md"), "utf8");
    expect(summary).toMatch(/indeterminate/);
  }, 240_000);
});

describe("OIR-003: creation-time oracle snapshots in evidence", () => {
  it("command-criterion evidence carries oracleSnapshot with the referenced files' digests at the evaluated revision", async () => {
    const run = await scenario("snapshot", [
      { path: "packages/demo/impl.js", content: "module.exports = () => 0; // fixed" },
      { path: "packages/demo/check.js", content: 'const v = require("./impl.js")();\nif (v !== 0) process.exit(1);\n' },
    ]);
    const ev = run.evidence.find((e) => e.criterionId === "OIR-A" && (e.payload ?? {})["oracleSnapshot"] !== undefined);
    expect(ev).toBeDefined();
    const snap = ev?.payload?.["oracleSnapshot"] as { files?: { path: string; digest: string }[] };
    expect(JSON.stringify(snap.files)).toContain("check.js");
    expect(String(snap.files?.[0]?.digest)).toMatch(/^sha256:/);
  }, 240_000);
});
