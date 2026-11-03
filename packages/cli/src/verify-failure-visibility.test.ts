import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Oracle for specs/verify-failure-visibility.yaml VF-001/VF-002 (red,
// committed pre-run): a failing verification must END with the failing
// fact - an Unsatisfied block after the Executions line in text mode,
// a failures array in json mode - naming exactly the unsatisfied
// requirements. Today the failing spec prints once mid-stream among
// all specs and the tail shows only green plus the exit code.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-vfvis-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function specYaml(id: string, requirementId: string, markerFile: string, withCommandCriterion: boolean): string {
  const criteria = [
    `      - id: ${requirementId}-A`,
    "        type: file",
    `        path: ${markerFile}`,
    "        assert:",
    '          contains: "done"',
  ];
  if (withCommandCriterion) {
    // One cheap command criterion so the invocation records COMMAND_
    // EXECUTED and the Executions accounting line prints - the block's
    // "after the Executions line" position is only observable when an
    // executions line exists.
    criteria.push(
      `      - id: ${requirementId}-B`,
      "        type: command",
      `        command: echo ${id}-marker`,
      "        expect:",
      "          exitCode: 0",
    );
  }
  return [
    "apiVersion: spc.dev/v1alpha1",
    "kind: Spec",
    "metadata:",
    `  id: ${id}`,
    `  title: ${id}`,
    `goal: ${id} holds.`,
    "requirements:",
    `  - id: ${requirementId}`,
    "    statement: The marker file carries the done mark.",
    "    priority: must",
    "    acceptance:",
    ...criteria,
    "",
  ].join("\n");
}

/** One passing spec (vf-good) and one failing spec (vf-bad, marker absent). */
function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "vf-good.yaml"), specYaml("vf-good", "GOOD-001", "marker-good.txt", true));
  writeFileSync(path.join(repo, "specs", "vf-bad.yaml"), specYaml("vf-bad", "BAD-001", "marker-bad.txt", false));
  writeFileSync(path.join(repo, "marker-good.txt"), "done\n"); // satisfied
  // marker-bad.txt deliberately absent: BAD-001-A is contradicted
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: repo });
  return repo;
}

function spc(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The text output's terminal failure block (everything after the LAST "Unsatisfied" marker). */
function unsatisfiedBlock(stdout: string): string | null {
  const idx = stdout.lastIndexOf("Unsatisfied");
  return idx === -1 ? null : stdout.slice(idx);
}

/** Locate the failures array whether json emitted an array or a single object. */
function extractFailures(parsed: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(parsed)) {
    for (const e of parsed) {
      if (e && typeof e === "object" && Array.isArray((e as { failures?: unknown }).failures)) {
        return (e as { failures: Array<Record<string, unknown>> }).failures;
      }
    }
    return null;
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { failures?: unknown }).failures)) {
    return (parsed as { failures: Array<Record<string, unknown>> }).failures;
  }
  return null;
}

describe("VF-001: terminal failure block (text format)", () => {
  it("a failing --all verification ends with an Unsatisfied block naming exactly the failing requirement, after the Executions line", () => {
    const repo = setupRepo("text");
    const r = spc(repo, ["verify", "--all"]);
    expect(r.status).not.toBe(0);
    const block = unsatisfiedBlock(r.stdout);
    expect(block).not.toBeNull();
    // The block names the failing spec, requirement, and the recorded
    // reason (criterion id + verdict).
    expect(block!).toMatch(/vf-bad/);
    expect(block!).toMatch(/BAD-001/);
    expect(block!).toMatch(/BAD-001-A/);
    expect(block!).toMatch(/contradicted/);
    // The passing spec's requirement is not in the block.
    expect(block!).not.toMatch(/GOOD-001/);
    // The block is the TERMINAL fact: it appears after the Executions
    // summary line, so a tail reader sees the failure last.
    const execIdx = r.stdout.lastIndexOf("Executions:");
    const blockIdx = r.stdout.lastIndexOf("Unsatisfied");
    expect(execIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(execIdx);
  });

  it("a failing single-spec verification prints the same terminal block", () => {
    const repo = setupRepo("text-single");
    const r = spc(repo, ["verify", "specs/vf-bad.yaml"]);
    expect(r.status).not.toBe(0);
    const block = unsatisfiedBlock(r.stdout);
    expect(block).not.toBeNull();
    expect(block!).toMatch(/BAD-001/);
    expect(block!).not.toMatch(/GOOD-001/);
  });

  it("a green verification prints no block (output unchanged)", () => {
    const repo = setupRepo("text-green");
    const r = spc(repo, ["verify", "specs/vf-good.yaml"]);
    expect(r.status).toBe(0);
    expect(unsatisfiedBlock(r.stdout)).toBeNull();
  });
});

describe("VF-002: structured failures array (json format)", () => {
  it("a failing --all verification reports a failures array containing the unsatisfied requirement as data", () => {
    const repo = setupRepo("json");
    const r = spc(repo, ["verify", "--all", "--format", "json"]);
    expect(r.status).not.toBe(0);
    const parsed = JSON.parse(r.stdout) as unknown;
    const failures = extractFailures(parsed);
    expect(failures).not.toBeNull();
    expect(failures!.length).toBe(1);
    expect(failures![0]!).toMatchObject({ spec: "vf-bad", requirement: "BAD-001" });
    expect(String(failures![0]!.reason)).toMatch(/BAD-001-A/);
  });

  it("an all-green verification reports an empty failures array and exits 0", () => {
    const repo = setupRepo("json-green");
    const r = spc(repo, ["verify", "specs/vf-good.yaml", "--format", "json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as unknown;
    const failures = extractFailures(parsed);
    expect(failures).toEqual([]);
  });
});
