import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LLMProvider, StructuredRequest } from "@spc/llm";
import { compileSpecFile, observeRepository } from "@spc/repo";
import { executeTask } from "./execute.js";

// Oracle for specs/staging-requeue.yaml (SR-001): a schema-valid answer
// that fails staging with an answer-defect code (the four PATCH_* codes)
// requeues with the applicator's actual refusal as previousRejection -
// same task attempt, new dispatch, bounded rounds - while scope and
// protected-path refusals keep fail-the-attempt behavior. The bound is
// three staging rounds per task attempt, offset by rounds already
// recorded (restart safety), and each rejection is durably recorded via
// the onStageRejection callback BEFORE the next dispatch.
const root = mkdtempSync(path.join(tmpdir(), "spc-sr-exec-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: sr-exec-fixture
  title: fixture
goal: fixture
requirements:
  - id: SRE-001
    statement: The gate passes.
    priority: must
    acceptance:
      - id: SRE-001-A
        type: command
        command: "true"
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "lib"), { recursive: true });
writeFileSync(path.join(root, "specs", "sr-exec-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "lib", "base.txt"), "alpha\nbeta\n", "utf8");
writeFileSync(path.join(root, "lib", "dup.txt"), "same\nsame\n", "utf8");
for (const args of [
  ["init", "-q", "-b", "main"],
  ["config", "user.email", "test@example.com"],
  ["config", "user.name", "test"],
  ["add", "."],
  ["commit", "-q", "-m", "base"],
]) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const BASE = "alpha\nbeta\n";
const baseDigest = "sha256:" + createHash("sha256").update(BASE, "utf8").digest("hex");
const dupDigest = "sha256:" + createHash("sha256").update("same\nsame\n", "utf8").digest("hex");

type Changes = unknown[];
const result = (changes: Changes) => ({
  status: "completed" as const,
  summary: "s",
  changes,
  commands: [],
  observations: [],
  evidenceCandidates: [],
  followups: [],
});
// The corrected answer is a fresh create per call: it always stages and
// never mutates the shared fixture files later tests anchor against.
let seq = 0;
const good = () => result([{ op: "create", path: `lib/out-${++seq}.txt`, content: "ok" }]);
const badMismatch = () => result([{ op: "patch", path: "lib/base.txt", baseDigest: "sha256:" + "0".repeat(64), anchor: "alpha", replacement: "ALPHA" }]);
const badMissing = () => result([{ op: "patch", path: "lib/nope.txt", baseDigest, anchor: "alpha", replacement: "x" }]);
const badAnchor = () => result([{ op: "patch", path: "lib/base.txt", baseDigest, anchor: "zzz-not-there", replacement: "x" }]);
const badNonUnique = () => result([{ op: "patch", path: "lib/dup.txt", baseDigest: dupDigest, anchor: "same", replacement: "once" }]);
const badScope = () => result([{ op: "create", path: "outside/evil.txt", content: "x" }]);

interface Call {
  key?: string;
  previousRejection?: string;
}

/** Scripted provider: one answer per dispatch (last repeats); records
 *  every dispatch's previousRejection; can observe callback ordering. */
function makeStub(script: Array<() => ReturnType<typeof good>>, onFirstRequeue?: () => void) {
  const calls: Call[] = [];
  const rejections: string[] = [];
  let n = 0;
  const provider: LLMProvider = {
    name: "stub",
    model: "stub",
    async generateStructured<T>(request: StructuredRequest<T>) {
      calls.push({ key: request.key, ...(request.previousRejection ? { previousRejection: request.previousRejection } : {}) });
      if (n > 0 && onFirstRequeue) onFirstRequeue();
      const answer = script[Math.min(n, script.length - 1)]!();
      n += 1;
      return { value: answer as unknown as T, usage: {} };
    },
  };
  const deps = {
    provider,
    onUsage: () => {},
    ...(onFirstRequeue ? {} : {}),
    onStageRejection: (code: string) => {
      rejections.push(code);
    },
  };
  return { deps, calls, rejections };
}

async function runTask(deps: unknown, options: { priorStageRejections?: number } = {}) {
  const compiled = compileSpecFile(path.join(root, "specs", "sr-exec-fixture.yaml"));
  if (!compiled.ok || !compiled.ir) throw new Error("fixture spec does not compile");
  return executeTask(
    {
      task: {
        id: "T001",
        title: "t",
        kind: "modify",
        intent: "i",
        targets: { read: ["lib/**"], write: ["lib/**"] },
      } as never,
      specIr: compiled.ir,
      snapshot: observeRepository(root, null) as never,
      worktreeRoot: root,
      attempt: 1,
      priorResults: [],
      observations: [],
      ...(options.priorStageRejections !== undefined ? { priorStageRejections: options.priorStageRejections } : {}),
    } as never,
    deps as never,
  );
}

describe("staging requeue (SR-001)", () => {
  it("PATCH_BASE_MISMATCH requeues with the applicator's refusal; the corrected answer completes the same attempt", async () => {
    let rejectionsAtRequeue = -1;
    const { deps, calls, rejections } = makeStub([badMismatch, good], () => {
      rejectionsAtRequeue = rejections.length;
    });
    const outcome = await runTask(deps);
    expect(outcome.status).toBe("completed");
    expect(calls.length).toBe(2);
    // The re-dispatch carries the actual refusal text, guidance included.
    expect(calls[1]!.previousRejection).toMatch(/PATCH_BASE_MISMATCH/);
    expect(calls[1]!.previousRejection).toMatch(/patch build --after/);
    // The rejection was durably recorded BEFORE the next dispatch.
    expect(rejectionsAtRequeue).toBe(1);
    expect(rejections).toEqual(["PATCH_BASE_MISMATCH"]);
  }, { timeout: 120_000 });

  it.each([
    ["PATCH_BASE_MISSING", badMissing],
    ["PATCH_ANCHOR_ABSENT", badAnchor],
    ["PATCH_ANCHOR_NOT_UNIQUE", badNonUnique],
  ] as const)("eligible code %s requeues the same way", async (code, bad) => {
    const { deps, calls } = makeStub([bad, good]);
    const outcome = await runTask(deps);
    expect(outcome.status).toBe("completed");
    expect(calls.length).toBe(2);
    expect(calls[1]!.previousRejection).toMatch(code);
  }, { timeout: 120_000 });

  it("write-scope violations fail the attempt with a single dispatch", async () => {
    const { deps, calls } = makeStub([badScope]);
    const outcome = (await runTask(deps)) as unknown as { status: string; failure?: { code: string } };
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.code).toBe("OUT_OF_SCOPE_WRITE");
    expect(calls.length).toBe(1);
  }, { timeout: 120_000 });

  it("the bound is three staging rounds: four dispatches total, then the attempt fails without another", async () => {
    const { deps, calls, rejections } = makeStub([badMismatch]);
    const outcome = (await runTask(deps)) as unknown as { status: string; failure?: { code: string } };
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.code).toBe("PATCH_BASE_MISMATCH");
    expect(calls.length).toBe(4); // original + three requeued rounds
    expect(rejections.length).toBe(4);
  }, { timeout: 120_000 });

  it("prior recorded rounds offset the bound (restart safety)", async () => {
    const { deps, calls } = makeStub([badMismatch]);
    // Three rounds already recorded for this attempt: the next rejection
    // is the fourth - the attempt fails with no re-dispatch at all.
    const outcome = (await runTask(deps, { priorStageRejections: 3 })) as unknown as { status: string; failure?: { code: string } };
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.code).toBe("PATCH_BASE_MISMATCH");
    expect(calls.length).toBe(1);
  }, { timeout: 120_000 });

  it("stagingRoundsFor derives the round count from the event log", async () => {
    // Lazily imported: the export lands with the implementation, and a
    // missing export must fail THIS test, not cascade the whole file.
    const { stagingRoundsFrom } = await import("./execute.js");
    const events = [
      { type: "TASK_STARTED", payload: { taskId: "T001", attempt: 1 } },
      { type: "TASK_STAGE_REJECTED", payload: { taskId: "T001", attempt: 1, code: "PATCH_BASE_MISMATCH" } },
      { type: "TASK_STAGE_REJECTED", payload: { taskId: "T001", attempt: 1, code: "PATCH_ANCHOR_ABSENT" } },
      { type: "TASK_STARTED", payload: { taskId: "T001", attempt: 2 } },
      { type: "TASK_STAGE_REJECTED", payload: { taskId: "T001", attempt: 2, code: "PATCH_BASE_MISMATCH" } },
      { type: "TASK_STAGE_REJECTED", payload: { taskId: "T002", attempt: 1, code: "PATCH_BASE_MISMATCH" } },
    ];
    expect(stagingRoundsFrom(events, "T001", 1)).toBe(2);
    expect(stagingRoundsFrom(events, "T001", 2)).toBe(1);
    expect(stagingRoundsFrom(events, "T002", 1)).toBe(1);
    expect(stagingRoundsFrom(events, "T009", 1)).toBe(0);
  });
});
