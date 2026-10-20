import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-ergonomics-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 15000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}`);
}

mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "executor-T001@1-1.json"),
  JSON.stringify({ id: "executor-T001@1-1", role: "executor", key: "T001@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
  "utf8",
);
git(["init", "-q", "-b", "main"]);

describe("harness ergonomics", () => {
  it("agent list shows each request's age", () => {
    const r = sh(["agent", "list"]);
    expect(r.stdout).toMatch(/5m|5 min|age/i);
  });

  it("agent wait prints the pending request immediately when one exists", () => {
    const r = sh(["agent", "wait", "--timeout", "3000"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("executor-T001@1-1");
  });

  it("agent wait exits nonzero on timeout with none pending", () => {
    // clear the queue first
    require("node:fs").rmSync(path.join(root, ".spc", "harness", "pending", "executor-T001@1-1.json"));
    const r = sh(["agent", "wait", "--timeout", "1000"]);
    expect(r.status).not.toBe(0);
  });
});
