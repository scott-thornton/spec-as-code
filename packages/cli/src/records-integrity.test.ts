import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/records-and-replacement.yaml (RR-001): a load-refusing
// run is VISIBLE in spc status, not silently skipped.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-rr-int-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: rr-int-fixture
  title: fixture
goal: fixture
requirements:
  - id: RRI-001
    statement: Gate passes.
    priority: must
    acceptance:
      - id: RRI-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
writeFileSync(path.join(root, "specs", "rr-int-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\nnode_modules/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

// A corrupted run for the spec: unreadable evidence log.
const brokenDir = path.join(root, ".spc", "runs", "run-rr-broken");
mkdirSync(brokenDir, { recursive: true });
writeFileSync(
  path.join(brokenDir, "metadata.json"),
  JSON.stringify({ runId: "run-rr-broken", specId: "rr-int-fixture", createdAt: "2026-10-23T00:00:00.000Z" }),
  "utf8",
);
writeFileSync(path.join(brokenDir, "state.json"), JSON.stringify({ status: "succeeded", tasks: {}, requirements: {} }), "utf8");
writeFileSync(path.join(brokenDir, "evidence.jsonl"), "this is not evidence\n");

describe("integrity visibility (RR-001)", () => {
  it("spc status names the unreadable run in an INTEGRITY section", () => {
    const r = sh(["status", "specs/rr-int-fixture.yaml"]);
    expect(r.stdout).toMatch(/INTEGRITY/);
    expect(r.stdout).toContain("run-rr-broken");
  });
});
