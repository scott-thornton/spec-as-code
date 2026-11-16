import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { compileSpecFile, gitOk } from "@spc/repo";
import type { Plan } from "@spc/schema";
import { applyPlan, type ApplyReport } from "./apply.js";
import { spcPaths } from "./paths.js";

// Oracle for specs/inheritance-identity.yaml (red, committed pre-run):
// chain-state inheritance rests on admissible establishment (the
// operator's 2026-16-11 ruling; decision record
// .spc/reviews/inheritance-identity-decision.md). Three scenarios:
// CONTROL - admissible establishment (untouched oracle, in-run flip)
// inherits, stays satisfied. PRE-GATE - an ancestor whose state
// RECORDS satisfied over evidence the gate rejects (the CHAL-004
// shape: label satisfied, no admissible pairing) - today the label
// promotes it; the ruling refuses it. TRANSFER - admissible
// establishment, then the oracle drifts before the inheriting run -
// the establishment does not transfer. Today all three inherit -
// the two refusals are red.
const root = mkdtempSync(path.join(tmpdir(), "spc-inh-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: inh
  title: INH
goal: >
  g
requirements:
  - id: R-001
    statement: s
    priority: must
    acceptance:
      - id: INH-A
        type: command
        command: node packages/demo/check.js
        expect: {exitCode: 0}
        discriminating: true
`;

function executorWith(changes: { path: string; content: string }[]): FakeProvider {
  const lines = ["executor:", "  T001:", "    status: completed", "    summary: work", "    changes:"];
  for (const c of changes) {
    lines.push("      - op: update", `        path: ${c.path}`, "        content: |");
    for (const l of c.content.split("\n")) lines.push(`          ${l}`);
  }
  return new FakeProvider(parseFakeScript(lines.join("\n") + "\n"));
}

function planFor(digest: string): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-inh", createdAt: "2026-11-16T00:00:00.000Z" },
    spec: { id: "inh", digest },
    repository: { revision: "r", snapshotDigest: "sha256:" + "0".repeat(64) },
    tasks: [
      { id: "T001", title: "fix", kind: "modify", intent: "i", dependsOn: [], satisfies: ["R-001"], targets: { read: [], write: ["packages/demo/impl.js", "packages/demo/check.js"] } },
    ],
  } as unknown as Plan;
}

class Repo {
  dir: string;
  git(args: string[]): void {
    gitOk(this.dir, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  }
  w(rel: string, content: string): void {
    mkdirSync(path.dirname(path.join(this.dir, rel)), { recursive: true });
    writeFileSync(path.join(this.dir, rel), content, "utf8");
  }
  rev(): string {
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd: this.dir, encoding: "utf8" }).stdout.trim();
  }
  async run(changes: { path: string; content: string }[]): Promise<ApplyReport> {
    const paths = spcPaths(this.dir);
    const compiled = compileSpecFile(path.join(this.dir, "specs", "inh.yaml"));
    const digest = compiled.ok && compiled.ir ? compiled.ir.digest : "";
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-inh"), JSON.stringify(planFor(digest), null, 2));
    return applyPlan({ repoRoot: this.dir, planFile: paths.planFile("plan-inh") }, { providerFactory: async () => executorWith(changes), log: () => {} });
  }
  latestRun(): { runId: string; summary: string; events: { type: string; payload?: Record<string, unknown> }[] } {
    const paths = spcPaths(this.dir);
    let best = { id: "", at: "" };
    for (const run of readdirSync(paths.runsDir)) {
      const mf = path.join(paths.runsDir, run, "metadata.json");
      if (!existsSync(mf)) continue;
      const m = JSON.parse(readFileSync(mf, "utf8")) as { specId?: string; createdAt?: string };
      if (m.specId !== "inh") continue;
      if (m.createdAt !== undefined && m.createdAt >= best.at) best = { id: run, at: m.createdAt };
    }
    return {
      runId: best.id,
      summary: readFileSync(path.join(paths.runsDir, best.id, "summary.md"), "utf8"),
      events: readFileSync(path.join(paths.runsDir, best.id, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    };
  }
  constructor(name: string) {
    this.dir = path.join(root, name);
    this.w(".gitignore", ".spc/\n");
    this.w("specs/inh.yaml", SPEC);
    this.w("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    this.w("package.json", '{ "name": "root", "private": true }\n');
    this.w("packages/demo/package.json", '{ "name": "@demo/pkg", "private": true }\n');
    this.w("packages/demo/impl.js", "module.exports = () => 1; // broken\n");
    this.w("packages/demo/check.js", 'if (require("./impl.js")() !== 0) process.exit(1);\n');
    this.w(".spc/config.yaml", "version: 1\nprovider:\n  name: fake\n  script: .spc/fake.yaml\nexecution:\n  inPlace: true\n  inPlaceBranch: current\nverification:\n  requireRedPhase: true\n");
    this.w(".spc/fake.yaml", "executor:\n  T001:\n    status: completed\n    summary: x\n");
    this.git(["init", "-q", "-b", "main"]);
    this.git(["add", "-A"]);
    this.git(["commit", "-qm", "base"]);
  }
}

describe("INH-003 control: admissible establishment inherits", () => {
  let repo: Repo;
  let run2: ReturnType<Repo["latestRun"]>;
  beforeAll(async () => {
    repo = new Repo("control");
    // Run 1: fix the impl (oracle untouched) - a clean in-run flip.
    await repo.run([{ path: "packages/demo/impl.js", content: "module.exports = () => 0; // fixed" }]);
    // Run 2: a no-op change; criterion passes at base; inheritance should promote.
    await repo.run([{ path: "notes.txt", content: "noop\n" }]);
    run2 = repo.latestRun();
  }, 240_000);

  it("the property renders SATISFIED via inheritance (the gate adds discipline, not blanket refusal)", () => {
    expect(run2.summary).toMatch(/satisfied\s+R-001|R-001[^\n]*satisfied/);
    expect(run2.events.some((e) => e.type === "PROPERTY_INHERITANCE_REJECTED")).toBe(false);
  });
});

describe("INH-001 pre-gate shape: a satisfied LABEL over drifted evidence does not inherit", () => {
  let repo: Repo;
  let run2: ReturnType<Repo["latestRun"]>;
  beforeAll(async () => {
    repo = new Repo("pregate");
    // Run 1: fix impl AND correct the oracle (rectification shape) -
    // the replay engine establishes it (admissible). Then we CORRUPT
    // the admissibility by rewriting run 1's red-phase evidence to
    // simulate the pre-gate era: append a SECOND red-phase record for
    // INH-A under a DIFFERENT (pre-fix) oracle era? Simpler and
    // honest: run 1 with drift + replay gets counterfactualFlip
    // (admissible). The PRE-GATE simulation instead: run 1's task
    // changes ONLY the oracle (weakened) - replay green->green ->
    // run 1 indeterminate... its STATE would not be satisfied. So:
    // hand-write the ancestor state the way the pre-gate era
    // recorded it: run the weakening run, then overwrite its
    // state.json to say satisfied (exactly what old machinery did).
    await repo.run([{ path: "packages/demo/check.js", content: "process.exit(0); // weakened\n" }]);
    const paths = spcPaths(repo.dir);
    let target = "";
    let at = "";
    for (const run of readdirSync(paths.runsDir)) {
      const mf = path.join(paths.runsDir, run, "metadata.json");
      if (!existsSync(mf)) continue;
      const m = JSON.parse(readFileSync(mf, "utf8")) as { specId?: string; createdAt?: string };
      if (m.specId === "inh" && (m.createdAt ?? "") >= at) {
        target = run;
        at = m.createdAt ?? "";
      }
    }
    const stateFile = path.join(paths.runsDir, target, "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { requirements: Record<string, { status: string }> };
    state.requirements["R-001"] = { ...state.requirements["R-001"]!, status: "satisfied" };
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
    // Run 2: no-op; criterion passes at base (weakened oracle) - the
    // label-based inheritance fires today (red); the ruling refuses.
    await repo.run([{ path: "notes.txt", content: "noop\n" }]);
    run2 = repo.latestRun();
  }, 240_000);

  it("the promotion is REFUSED - PROPERTY_INHERITANCE_REJECTED with the criterion and reason; the property stays indeterminate", () => {
    expect(run2.summary).toMatch(/indeterminate/);
    expect(run2.summary).not.toMatch(/satisfied\s+R-001/);
    const rej = run2.events.find((e) => e.type === "PROPERTY_INHERITANCE_REJECTED");
    expect(rej).toBeDefined();
    const p = rej?.payload ?? {};
    expect(String(p["criterionId"])).toBe("INH-A");
    expect(String(p["reason"])).toMatch(/admissible/i);
  });
});

describe("INH-002 transfer: admissible establishment, then drift before the inheriting run", () => {
  let repo: Repo;
  let run2: ReturnType<Repo["latestRun"]>;
  beforeAll(async () => {
    repo = new Repo("transfer");
    // Run 1: fix impl, oracle untouched - clean admissible flip.
    await repo.run([{ path: "packages/demo/impl.js", content: "module.exports = () => 0; // fixed" }]);
    // Between runs: the oracle drifts (a post-establishment edit).
    repo.w("packages/demo/check.js", 'const v = require("./impl.js")();\nif (v !== 0) process.exit(1);\nif (!require("node:fs").readFileSync("NEW_MARKER", "utf8")) process.exit(1); // drifted instrument\n');
    repo.w("NEW_MARKER", "present\n");
    repo.git(["add", "-A"]);
    repo.git(["commit", "-qm", "oracle drift between runs"]);
    // Run 2: the drifted oracle passes (marker present); the establishment does not transfer.
    await repo.run([{ path: "notes.txt", content: "noop\n" }]);
    run2 = repo.latestRun();
  }, 240_000);

  it("the promotion is REFUSED with reason 'establishing oracle drifted from current'; the property stays indeterminate", () => {
    expect(run2.summary).toMatch(/indeterminate/);
    expect(run2.summary).not.toMatch(/satisfied\s+R-001/);
    const rej = run2.events.find((e) => e.type === "PROPERTY_INHERITANCE_REJECTED");
    expect(rej).toBeDefined();
    const p = rej?.payload ?? {};
    expect(String(p["reason"])).toMatch(/drifted from current|transfer/i);
  });
});
