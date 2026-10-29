import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/window-rendering.yaml (WR-001): the queue surfaces
// must render the ACTUAL remaining window. Caught live on the slerp
// queue (2026-10-29): every fresh request displayed "0s left in
// window" because the renderer computed time-left by passing a future
// instant to the age formatter, whose negative result clamps to zero.
// The previous oracle matched the word "live" - this one asserts the
// number, on all three surfaces that share the renderer.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-windowrender-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "specs", "window-rendering.yaml"), 'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: window-rendering\n  title: W\ngoal: fixture\nrequirements:\n  - id: WR-001\n    statement: holds\n    priority: must\n    acceptance:\n      - id: WR-001-A\n        type: command\n        command: "true"\n', "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

const now = Date.now();
const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
function putPending(id: string, overrides: Record<string, unknown>): void {
  const base = { id, role: "executor", key: "x@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: iso(-60_000) };
  writeFileSync(path.join(root, ".spc", "harness", "pending", `${id}.json`), JSON.stringify({ ...base, ...overrides }), "utf8");
}

// A fresh request with ~14.5 minutes of window left (the half-minute
// headroom keeps the floored minute stable across the seconds the
// command takes to run), and one whose window closed 26 minutes ago.
putPending("executor-FRESH@1-1", { createdAt: iso(-60_000), expiresAt: iso(14.5 * 60_000) });
putPending("executor-CLOSED@1-1", { createdAt: iso(-30 * 60_000), expiresAt: iso(-26 * 60_000) });

describe("window rendering (CLI)", () => {
  it("agent list renders the actual remaining window, never a clamped zero", () => {
    const r = sh(["agent", "list"]);
    expect(r.status).toBe(1); // pendings exist - the queue wants attention
    expect(r.stdout).toMatch(/executor-FRESH@1-1.*14m left in window/);
    expect(r.stdout).toMatch(/executor-CLOSED@1-1.*window closed 26m ago/);
    // The defect's signature must be gone: no live request ever reads
    // "0s left" while its window stands open.
    expect(r.stdout).not.toMatch(/0s left in window/);
  });

  it("brief renders the same remaining window through the shared renderer", () => {
    const r = sh(["brief"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/executor-FRESH@1-1.*14m left in window/);
    expect(r.stdout).toMatch(/executor-CLOSED@1-1.*window closed 26m ago/);
  });

  it("agent wait renders the same remaining window", () => {
    const r = sh(["agent", "wait", "--timeout", "5000"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/executor-FRESH@1-1.*14m left in window/);
    expect(r.stdout).not.toMatch(/0s left in window/);
  });
});
