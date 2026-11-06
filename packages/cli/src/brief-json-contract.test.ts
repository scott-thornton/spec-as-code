import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/brief-json-contract.yaml BJ-001 (red, committed
// pre-run): brief --format json is a pinned machine contract. Today
// specCount/unresolvedCount do not exist and chainDepth is conditional -
// the contract legs fail. The text format is untouched.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-bjc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function specYaml(id: string): string {
  return `apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: ${id}\n  title: ${id}\ngoal: ${id} holds.\nrequirements:\n  - id: R-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: R-001-A\n        type: command\n        command: "true"\n`;
}

mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "specs", "alpha.yaml"), specYaml("alpha"), "utf8");
writeFileSync(path.join(root, "specs", "beta.yaml"), specYaml("beta"), "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: root });

// alpha carries a run with ONE open blocking followup; beta has no runs.
mkdirSync(path.join(root, ".spc", "runs", "run-alpha-1"), { recursive: true });
writeFileSync(
  path.join(root, ".spc", "runs", "run-alpha-1", "metadata.json"),
  JSON.stringify({ runId: "run-alpha-1", kind: "apply", specId: "alpha", planId: "p", baseRevision: "0".repeat(40), createdAt: new Date().toISOString() }),
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "runs", "run-alpha-1", "state.json"),
  JSON.stringify({ runId: "run-alpha-1", status: "partially_satisfied", specId: "alpha", tasks: {}, requirements: {} }),
  "utf8",
);
writeFileSync(
  path.join(root, ".spc", "runs", "run-alpha-1", "followups.json"),
  JSON.stringify([{ id: "F-001", type: "spec_clarification", blocking: true, status: "open", title: "clarify", description: "d", runId: "run-alpha-1", createdAt: new Date().toISOString() }]),
  "utf8",
);

function briefJson(): Record<string, unknown> {
  const r = spawnSync(process.execPath, [CLI, "brief", "--format", "json"], { cwd: root, encoding: "utf8" });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout as string) as Record<string, unknown>;
}

describe("BJ-001: brief --format json is a pinned contract", () => {
  it("every pinned field name and type; the summary counts; chainDepth always present", () => {
    const b = briefJson();
    // Top-level pinned fields and types.
    expect(Array.isArray(b["specs"])).toBe(true);
    expect(typeof b["specCount"]).toBe("number");
    expect(b["specCount"]).toBe(2);
    expect(typeof b["unresolvedCount"]).toBe("number");
    expect(b["unresolvedCount"]).toBe(1);
    expect(typeof b["pendingHarness"]).toBe("number");
    expect(Array.isArray(b["unmergedRunBranches"])).toBe(true);
    expect(Array.isArray(b["strayWorktrees"])).toBe(true);
    // Per-spec pinned fields.
    const alpha = (b["specs"] as Record<string, unknown>[]).find((s) => s["id"] === "alpha");
    expect(alpha).toBeDefined();
    expect(typeof alpha!["configChanged"]).toBe("boolean");
    expect(Array.isArray(alpha!["openBlockingFollowups"])).toBe(true);
    expect((alpha!["openBlockingFollowups"] as unknown[]).length).toBe(1);
    expect(typeof alpha!["chainDepth"]).toBe("number");
    const lastRun = alpha!["lastRun"] as Record<string, unknown> | null;
    expect(lastRun).not.toBeNull();
    expect(typeof lastRun!["id"]).toBe("string");
    expect(typeof lastRun!["status"]).toBe("string");
    // beta: no runs - lastRun null, chainDepth STILL present (0).
    const beta = (b["specs"] as Record<string, unknown>[]).find((s) => s["id"] === "beta");
    expect(beta!["lastRun"]).toBeNull();
    expect(beta!["chainDepth"]).toBe(0);
  });
});
