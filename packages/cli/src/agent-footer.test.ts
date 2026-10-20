import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-footer-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "executor-T001@1-1.json"),
  JSON.stringify({ id: "executor-T001@1-1", role: "executor", key: "T001@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: new Date().toISOString() }),
  "utf8",
);
const r0 = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
if (r0.status !== 0) throw new Error(r0.stderr?.toString() ?? "git init failed");

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("agent list footer affordances", () => {
  it("points at validate and dry-run where the answering agent already looks", () => {
    const r = sh(["agent", "list"]);
    expect(r.status).toBe(1); // pending requests present
    expect(r.stdout).toContain("De-risk with:");
    expect(r.stdout).toContain("spc agent validate");
    expect(r.stdout).toContain("spc agent dry-run");
  });
});
