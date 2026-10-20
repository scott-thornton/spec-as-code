import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-timedout-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[], timeout = 20000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}`);
}

// One spec whose only criterion is an agent judgment: with provider
// harness and a tiny response window, an unanswered verifier request
// kills the run mid-sweep.
const SPEC = [
  "apiVersion: spc.dev/v1alpha1",
  "kind: Spec",
  "metadata:",
  "  id: timedout",
  "  title: Timed out",
  "goal: fixture",
  "requirements:",
  "  - id: TO-001",
  "    statement: An agent judges this.",
  "    priority: must",
  "    acceptance:",
  "      - id: TO-001-A",
  "        type: agent",
  "        instruction: judge it",
  "",
].join("\n");

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, "specs", "timedout.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, ".spc", "config.yaml"), [
  "version: 1",
  "provider:",
  "  name: harness",
  "execution:",
  "  harnessResponseTimeoutMs: 1500",
  "verification:",
  "  requireRedPhase: false",
  "",
].join("\n"), "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

describe("timed_out persistence", () => {
  it("a verify run killed by the harness timeout finalizes as timed_out, with a summary", () => {
    // Never answer the request: the sweep times out.
    const r = sh(["verify", "specs/timedout.yaml"], 20000);
    expect(r.status).not.toBe(0);
    const runsDir = path.join(root, ".spc", "runs");
    const { readdirSync } = require("node:fs");
    const vruns = readdirSync(runsDir).filter((f: string) => f.startsWith("v-"));
    expect(vruns.length).toBe(1);
    const runDir = path.join(runsDir, vruns[0]);
    const state = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")) as { status: string };
    expect(state.status).toBe("timed_out");
    expect(() => readFileSync(path.join(runDir, "summary.md"))).not.toThrow();
    // The pending request is expired out of the live queue immediately.
    const pending = readdirSync(path.join(root, ".spc", "harness", "pending")).length;
    expect(pending).toBe(0);
  }, 25000);
});
