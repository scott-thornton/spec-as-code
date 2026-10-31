import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/verify-dedup.yaml: the execution memo belongs to the
// INVOCATION, not the spec. Two specs whose criteria run the same
// command must produce exactly one physical execution (measured by the
// command's own side effect - never inferred from events), one
// COMMAND_EXECUTED plus one COMMAND_RESULT_REUSED, and evidence records
// sharing the execution identity. The unit of evidence is a criterion;
// the unit of execution can be shared.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-verifydedup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\ncounter.txt\n", "utf8");
// Two specs, identical command criterion: a committed script appends
// one line to counter.txt per PHYSICAL execution - the ground truth,
// measured by side effect, never inferred from events. No shell
// quoting anywhere.
writeFileSync(path.join(root, "counter.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync('counter.txt', 'x\\n');\n", "utf8");
for (const [id, prop] of [["dedup-a", "VDA"], ["dedup-b", "VDB"]] as const) {
  writeFileSync(
    path.join(root, "specs", `${id}.yaml`),
    `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ${id}
  title: ${id}
goal: fixture
requirements:
  - id: ${prop}-001
    statement: holds
    priority: must
    acceptance:
      - id: ${prop}-001-A
        type: command
        command: node counter.mjs
`,
    "utf8",
  );
}
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

interface EventRecord {
  type: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

describe("verify-dedup (CLI --all)", () => {
  it("two specs sharing a command criterion execute it exactly once physically, with reused-event and shared execution identity", { timeout: 180_000 }, () => {
    const r = sh(["verify"]);
    expect(r.status).toBe(0);

    // Ground truth measured by the command's own side effect.
    const executions = readFileSync(path.join(root, "counter.txt"), "utf8").split("\n").filter((l) => l === "x").length;
    expect(executions).toBe(1);

    // Both specs verified; each criterion independently supported.
    expect(r.stdout).toMatch(/dedup-a/);
    expect(r.stdout).toMatch(/dedup-b/);

    // Audit precision across the two run directories: exactly one
    // COMMAND_EXECUTED, exactly one COMMAND_RESULT_REUSED, and the two
    // criteria's evidence records share the execution identity.
    const events: EventRecord[] = [];
    const evidenceByCriterion = new Map<string, Record<string, unknown>>();
    const runsDir = path.join(root, ".spc", "runs");
    for (const run of readdirSync(runsDir)) {
      for (const line of readFileSync(path.join(runsDir, run, "events.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        events.push(JSON.parse(line) as EventRecord);
      }
      try {
        for (const line of readFileSync(path.join(runsDir, run, "evidence.jsonl"), "utf8").split("\n")) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as Record<string, unknown>;
          const cid = ((e as { criterionId?: string }).criterionId) ?? ((e as { payload?: { criterionId?: string } }).payload?.criterionId ?? "");
          if (cid) evidenceByCriterion.set(String(cid), e);
        }
      } catch {
        // no evidence file
      }
    }
    const executed = events.filter((e) => e.type === "COMMAND_EXECUTED");
    const reused = events.filter((e) => e.type === "COMMAND_RESULT_REUSED");
    expect(executed).toHaveLength(1);
    expect(reused).toHaveLength(1);

    // Both criteria's evidence carries the same executionId; the reused
    // one names the originating run.
    const ids = new Set<string>();
    for (const [cid, e] of evidenceByCriterion) {
      expect(cid).toMatch(/VDA-001-A|VDB-001-A/);
      const payload = (e as { payload?: Record<string, unknown> }).payload ?? {};
      const executionId = payload.executionId as string | undefined;
      expect(executionId).toBeTruthy();
      ids.add(executionId!);
    }
    expect(ids.size).toBe(1);
    expect(evidenceByCriterion.size).toBe(2);
  });

  it("single-spec verification still runs its own command (fresh map per sweep, unchanged semantics)", { timeout: 120_000 }, () => {
    rmSync(path.join(root, "counter.txt"), { force: true });
    // --force skips the freshness cache (zero tracked changes since
    // test 1's verified base would otherwise CACHED-skip the spec).
    const r = sh(["verify", "--all", "specs/dedup-a.yaml"]);
    expect(r.status).toBe(0);
    const executions = readFileSync(path.join(root, "counter.txt"), "utf8").split("\n").filter((l) => l === "x").length;
    expect(executions).toBe(1);
  });
});
