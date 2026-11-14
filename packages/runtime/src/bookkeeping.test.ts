import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { gitOk } from "@spc/repo";
import type { Plan } from "@spc/schema";
import { applyPlan, type ApplyReport } from "./apply.js";
import { spcPaths } from "./paths.js";
import { claimPlanId } from "./run.js";

// Oracle for specs/bookkeeping-honesty.yaml (red, committed pre-run):
// (BH-001) every path the finalize commit carries OUTSIDE the union of
// declared write targets is named in an OUT_OF_TARGET_COMMITS event
// and a non-blocking follow-up - reported, never gating, the ledger's
// silence was the defect (the HBA cancelled-run F2); (BH-002) plan-id
// minting claims exclusively before generation - two concurrent
// sessions can no longer mint the same id (demonstrated twice:
// plans 20261110-007 and 20261111-005). Today neither exists - red.

const root = mkdtempSync(path.join(tmpdir(), "spc-bookkeeping-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function initRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n");
  return repo;
}

// BH-001 fixture: the criterion command dirties stray.txt (a tracked
// path no task declares as a write target) on every execution; the
// finalize commit sweeps it in; the plan-drift computation (replans,
// amendments) records zero. The silence is the defect.
const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: bk
  title: Bookkeeping
goal: one criterion whose command dirties an out-of-target path.
requirements:
  - id: BK-001
    statement: the fact exists and is checked by a command that also dirties a stray path.
    priority: must
    acceptance:
      - id: BK-001-A
        type: command
        command: node check.js
        expect: {exitCode: 0}
`;

function plan(): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-bk", createdAt: "2026-11-14T00:00:00.000Z" },
    spec: { id: "bk", digest: "sha256:" + "0".repeat(64) },
    repository: { revision: "r", snapshotDigest: "sha256:" + "0".repeat(64) },
    tasks: [
      {
        id: "T001",
        title: "Create the fact",
        kind: "modify",
        intent: "create fact.txt",
        dependsOn: [],
        satisfies: ["BK-001"],
        targets: { read: ["specs/bk.yaml"], write: ["fact.txt"] },
      },
    ],
  } as unknown as Plan;
}

function script(): FakeProvider {
  return new FakeProvider(
    parseFakeScript(
      [
        "executor:",
        "  T001:",
        "    status: completed",
        "    summary: created the fact",
        "    changes:",
        "      - op: create",
        "        path: fact.txt",
        '        content: "the fact"',
      ].join("\n") + "\n",
    ),
  );
}

describe("BH-001: out-of-target commits are named in the ledger", () => {
  let repo: string;
  let report: ApplyReport;
  beforeAll(async () => {
    repo = initRepo("bh001");
    mkdirSync(path.join(repo, "specs"), { recursive: true });
    writeFileSync(path.join(repo, "specs", "bk.yaml"), specYaml);
    // The criterion command: checks the fact AND dirties stray.txt -
    // a tracked path outside every task's declared write targets.
    writeFileSync(
      path.join(repo, "check.js"),
      [
        'const { readFileSync, writeFileSync, existsSync } = require("node:fs");',
        "if (!existsSync(\"fact.txt\")) process.exit(1);",
        "writeFileSync(\"stray.txt\", \"dirtied by the criterion command\\n\");",
        "process.exit(readFileSync(\"fact.txt\", \"utf8\").includes(\"fact\") ? 0 : 1);",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(repo, ".spc.config.stamp"), ""); // no-op keeps shape stable
    rmSync(path.join(repo, ".spc.config.stamp"));
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("plan-bk"), JSON.stringify(plan(), null, 2));
    const git = (args: string[]): void => gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);
    report = await applyPlan({ repoRoot: repo }, { providerFactory: async () => script(), log: () => {} });
  }, 180_000);

  it("the run succeeds (the accounting never gates)", () => {
    expect(report.status).toBe("succeeded");
  });

  it("the finalize commit carried the out-of-target path (the premise holds)", () => {
    // stray.txt was dirty when finalize ran; commitAll swept it in.
    const committed = gitOk(repo, ["show", "--name-only", "--format=", "HEAD~1"]);
    expect(committed).toContain("stray.txt");
  });

  it("the ledger names it: an OUT_OF_TARGET_COMMITS event with the path, and a non-blocking follow-up", () => {
    const paths = spcPaths(repo);
    const runs = readdirSync(paths.runsDir).filter((d) => d.startsWith("run-"));
    const events = runs
      .map((r) => path.join(paths.runsDir, r, "events.jsonl"))
      .filter(existsSync)
      .map((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> }))
      .flat();
    const evt = events.find((e) => e.type === "OUT_OF_TARGET_COMMITS");
    expect(evt).toBeDefined();
    expect(JSON.stringify(evt?.payload)).toContain("stray.txt");
    const followups = runs
      .map((r) => path.join(paths.runsDir, r, "followups.json"))
      .filter(existsSync)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(followups).toMatch(/out-of-target|outside.*write target/i);
    expect(followups).toContain("stray.txt");
  });
});

describe("BH-002: plan-id claims are collision-safe", () => {
  it("claimPlanId claims exclusively - a pre-existing claim for -001 forces -002, and the claim file exists at the final path", () => {
    const plansDir = path.join(root, "plans-claim");
    mkdirSync(plansDir, { recursive: true });
    // A concurrent session already claimed today's -001 (a zero-byte wx claim).
    const d = new Date();
    const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const existing = path.join(plansDir, `plan-${date}-001.json`);
    const fd = openSync(existing, "wx");
    closeSync(fd);
    const claim = claimPlanId(plansDir);
    expect(claim.planId).toBe(`plan-${date}-002`);
    expect(existsSync(path.join(plansDir, `plan-${date}-002.json`))).toBe(true);
  });

  it("a fresh directory claims -001 and the file exists", () => {
    const plansDir = path.join(root, "plans-fresh");
    mkdirSync(plansDir, { recursive: true });
    const claim = claimPlanId(plansDir);
    const d = new Date();
    const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    expect(claim.planId).toBe(`plan-${date}-001`);
    expect(existsSync(path.join(plansDir, claim.planId + ".json"))).toBe(true);
  });
});
