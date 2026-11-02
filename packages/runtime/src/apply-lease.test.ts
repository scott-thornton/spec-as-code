import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { commitAll, gitOk } from "@spc/repo";
import { applyPlan } from "./apply.js";
import { spcPaths } from "./paths.js";

// Oracle for specs/apply-lease.yaml: one live apply per workspace. The
// receipts: a mis-fed second apply mid-flight, a sibling double-start
// (two live processes, one queue), and a phase-11 zombie still requeuing
// in a later phase's workspace. The lease converts all three from silent
// coexistence into APPLY_ALREADY_RUNNING - identity-rich, spec surfaced
// with a refusal-time file resolution, remedy vocabulary check-then-decide
// (never wait), dead-pid leases reclaimed silently, --allow-concurrent as
// the only door past a live holder.
const root = mkdtempSync(path.join(tmpdir(), "spc-al-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: alspec
  title: Lease fixture spec
goal: A file exists.
requirements:
  - id: AL-F
    statement: File exists.
    priority: must
    acceptance:
      - id: AL-F-A
        type: file
        path: src/mod.mjs
        assert:
          contains: "ok"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml, "utf8");
  writeFileSync(path.join(repo, ".spc", "config.yaml"), "version: 1\nprovider:\n  name: fake\n  script: .spc/fake-script.yaml\n");
  writeFileSync(path.join(repo, ".spc", "fake-script.yaml"), "planner:\n  value: {}\n");
  commitAll(repo, "init");
  return repo;
}
function writePlan(repo: string): void {
  const paths = spcPaths(repo);
  mkdirSync(paths.plansDir, { recursive: true });
  writeFileSync(
    paths.planFile("plan-al"),
    JSON.stringify({
      apiVersion: "spc.dev/v1alpha1",
      kind: "Plan",
      metadata: { id: "plan-al", createdAt: new Date().toISOString() },
      spec: { id: "alspec", digest: ir.digest },
      repository: { revision: "0".repeat(40), snapshotDigest: `sha256:${"0".repeat(64)}` },
      tasks: [{ id: "T001", title: "c", kind: "modify", intent: "i", dependsOn: [], satisfies: ["AL-F"], targets: { write: ["src/mod.mjs"] } }],
    }),
    "utf8",
  );
}
const PROVIDER = () =>
  new FakeProvider(
    parseFakeScript(
      ["planner:", "  value: {}", "executor:", "  T001:", "    status: completed", "    summary: w", "    changes:",
       "      - op: create", "        path: src/mod.mjs", "        content: |", '          export const ok = 1;', ""].join("\n"),
    ),
  );

interface Lease {
  pid: number;
  host: string;
  runId: string;
  planId: string;
  specId: string;
  specTitle: string;
  specDigest: string;
  mode: string;
  startedAt: string;
}
function plantLease(repo: string, over: Partial<Lease>): void {
  writeFileSync(
    path.join(repo, ".spc", "apply.lease"),
    JSON.stringify({
      pid: process.pid, // alive by construction
      host: os.hostname(),
      runId: "run-holder-1",
      planId: "plan-holder",
      specId: "alspec",
      specTitle: "Lease fixture spec",
      specDigest: ir.digest,
      mode: "in-place",
      startedAt: new Date(Date.now() - 3 * 3600_000 - 12 * 60_000).toISOString(),
      ...over,
    }),
    "utf8",
  );
}
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
  return r.pid ?? -1; // exited by now; recycling within the test is vanishingly rare
}

describe("apply lease (AL-001..003)", () => {
  it("a live lease refuses with the full identity, spec file resolved now, check-then-decide remedies, never wait", { timeout: 120_000 }, async () => {
    const repo = setupRepo("refuse");
    writePlan(repo);
    plantLease(repo, {});
    const err = await applyPlan({ repoRoot: repo }, { providerFactory: async () => PROVIDER(), log: () => {} }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.code).toBe("APPLY_ALREADY_RUNNING");
    const msg = err!.message;
    expect(msg).toContain("run-holder-1");
    expect(msg).toContain("alspec");
    expect(msg).toContain("Lease fixture spec");
    expect(msg).toContain("plan-holder");
    expect(msg).toContain(String(process.pid));
    expect(msg).toContain("3h12m");
    expect(msg).toContain("specs/spec.yaml"); // resolved at refusal time
    expect(msg).toContain("spc run show run-holder-1");
    expect(msg).toContain("spc run cancel run-holder-1");
    expect(msg).not.toMatch(/wait/i);
    // Same-spec double-start line: the incoming plan's spec equals the lease's.
    expect(msg).toMatch(/SAME spec/);
  });

  it("a lease for a spec with no live file names the stale-file signal; a different-spec holder drops the SAME-spec line", { timeout: 120_000 }, async () => {
    const repo = setupRepo("ghost");
    writePlan(repo);
    plantLease(repo, { specId: "phase11-old", specTitle: "Phase 11 era", runId: "run-zombie-9" });
    const err = await applyPlan({ repoRoot: repo }, { providerFactory: async () => PROVIDER(), log: () => {} }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe("APPLY_ALREADY_RUNNING");
    expect(err!.message).toContain("no live spec file for phase11-old");
    expect(err!.message).not.toMatch(/SAME spec/);
  });

  it("a dead-pid lease is silently reclaimed and the apply proceeds; no lease at all proceeds; the lease is released at finalization", { timeout: 120_000 }, async () => {
    const repo = setupRepo("reclaim");
    writePlan(repo);
    plantLease(repo, { pid: deadPid() });
    const r1 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => PROVIDER(), log: () => {} });
    expect(r1.status).toBe("succeeded");
    // Released at finalization: a fresh apply needs no flag.
    writePlan(repo);
    const r2 = await applyPlan({ repoRoot: repo }, { providerFactory: async () => PROVIDER(), log: () => {} });
    expect(r2.status).toBe("succeeded");
  });

  it("allowConcurrent proceeds past a live holder with a warning naming it", { timeout: 120_000 }, async () => {
    const repo = setupRepo("forced");
    writePlan(repo);
    plantLease(repo, {});
    const lines: string[] = [];
    const r = await applyPlan({ repoRoot: repo, allowConcurrent: true }, { providerFactory: async () => PROVIDER(), log: (l) => lines.push(l) });
    expect(r.status).toBe("succeeded");
    expect(lines.some((l) => l.includes("run-holder-1") && /concurrent/i.test(l))).toBe(true);
  });
});
