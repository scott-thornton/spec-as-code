import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositorySnapshot, SpecIR, Task } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import type { LLMProvider, StructuredRequest } from "@spc/llm";
import { proposedChangeSchema, type ProposedChange } from "./result.js";
import {
  fileDigest,
  PATCH_ANCHOR_ABSENT,
  PATCH_ANCHOR_NOT_UNIQUE,
  PATCH_BASE_MISMATCH,
  PATCH_BASE_MISSING,
  stageChanges,
} from "./patch.js";
import { buildExecutorPrompt, type ExecutorTaskContext } from "./prompts.js";
import { executeTask } from "./execute.js";

const CONTENT = `export function authorize(user: string): boolean {
  const ok = check(user);
  return false;
}

export function logout(): void {
  clear(user);
}
`;

let dirs: string[] = [];
function worktree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spc-patch-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), CONTENT, "utf8");
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function patchOp(over: Partial<Extract<ProposedChange, { op: "patch" }>> = {}): Extract<ProposedChange, { op: "patch" }> {
  return {
    op: "patch",
    path: "src/a.ts",
    baseDigest: fileDigest(CONTENT),
    anchor: "return false;",
    replacement: "return ok;",
    ...over,
  };
}

describe("stageChanges: anchored patch application", () => {
  it("replaces a unique anchor exactly and leaves every other byte untouched", () => {
    const wt = worktree();
    const staged = stageChanges(wt, [patchOp()]);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.writes).toHaveLength(1);
    expect(staged.writes[0]!.label).toBe("patched");
    expect(staged.writes[0]!.content).toBe(CONTENT.replace("return false;", "return ok;"));
  });

  it("anchors a second patch against the first patch's output (sequential overlay)", () => {
    const wt = worktree();
    const first = patchOp({ replacement: "throw new AuthorizationError();" });
    const afterFirst = CONTENT.replace("return false;", "throw new AuthorizationError();");
    const second = patchOp({
      anchor: "throw new AuthorizationError();",
      replacement: "throw new AuthError();",
      baseDigest: fileDigest(afterFirst),
    });
    const staged = stageChanges(wt, [first, second]);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.writes[0]!.content).toBe(CONTENT.replace("return false;", "throw new AuthError();"));
  });

  it("refuses PATCH_BASE_MISSING when the file does not exist", () => {
    const wt = worktree();
    const staged = stageChanges(wt, [patchOp({ path: "src/gone.ts" })]);
    expect(staged).toEqual({ ok: false, code: PATCH_BASE_MISSING, message: expect.stringContaining("src/gone.ts") });
  });

  it("refuses PATCH_BASE_MISMATCH on a stale digest, naming path and both digests", () => {
    const wt = worktree();
    const stale = "sha256:" + "1".repeat(64);
    const staged = stageChanges(wt, [patchOp({ baseDigest: stale })]);
    expect(staged).toEqual({
      ok: false,
      code: PATCH_BASE_MISMATCH,
      message: expect.stringMatching(/src\/a\.ts/),
    });
    if (!staged.ok) {
      expect(staged.message).toContain(stale);
      expect(staged.message).toContain(fileDigest(CONTENT));
    }
  });

  it("refuses PATCH_ANCHOR_ABSENT with exact-byte matching (no whitespace normalization)", () => {
    const wt = worktree();
    const base = CONTENT.replace("return false;", "return false ;");
    writeFileSync(path.join(wt, "src", "a.ts"), base, "utf8");
    const staged = stageChanges(wt, [patchOp({ baseDigest: fileDigest(base) })]);
    expect(staged).toEqual({
      ok: false,
      code: PATCH_ANCHOR_ABSENT,
      message: expect.stringContaining("src/a.ts"),
    });
  });

  it("refuses PATCH_ANCHOR_NOT_UNIQUE naming the occurrence count and a truncated anchor", () => {
    const wt = worktree();
    const base = CONTENT.replace("export function logout", "export function authorizeSecond");
    writeFileSync(path.join(wt, "src", "a.ts"), base, "utf8");
    const staged = stageChanges(wt, [
      patchOp({ anchor: "user", baseDigest: fileDigest(base) }),
    ]);
    expect(staged).toEqual({
      ok: false,
      code: PATCH_ANCHOR_NOT_UNIQUE,
      message: expect.stringMatching(/src\/a\.ts/),
    });
    if (!staged.ok) {
      const expected = base.split("user").length - 1;
      expect(staged.message).toMatch(new RegExp(`\\b${expected}\\b`));
      expect(staged.message).toContain("user");
    }
  });

  it("is all-or-nothing: a valid create plus an invalid patch writes nothing", () => {
    const wt = worktree();
    const staged = stageChanges(wt, [
      { op: "create", path: "src/new.ts", content: "export const x = 1;\n" },
      patchOp({ anchor: "not present anywhere" }),
    ]);
    expect(staged.ok).toBe(false);
    // Nothing was written because staging never touches disk on refusal.
    expect(() => readFileSync(path.join(wt, "src", "new.ts"))).toThrow();
    expect(readFileSync(path.join(wt, "src", "a.ts"), "utf8")).toBe(CONTENT);
  });

  it("is all-or-nothing across two patches when the second refuses", () => {
    const wt = worktree();
    const staged = stageChanges(wt, [patchOp(), patchOp({ anchor: "absent anchor" })]);
    expect(staged.ok).toBe(false);
    expect(readFileSync(path.join(wt, "src", "a.ts"), "utf8")).toBe(CONTENT);
  });
});

describe("change protocol schema", () => {
  it("accepts the patch variant with all four fields", () => {
    const parsed = proposedChangeSchema.safeParse(patchOp());
    expect(parsed.success).toBe(true);
  });

  it("rejects a patch op missing anchor or carrying unknown fields", () => {
    const noAnchor = patchOp() as Record<string, unknown>;
    delete noAnchor.anchor;
    expect(proposedChangeSchema.safeParse(noAnchor).success).toBe(false);
    expect(proposedChangeSchema.safeParse({ ...patchOp(), extra: 1 }).success).toBe(false);
  });
});

describe("digests and the executor prompt", () => {
  it("fileDigest is sha256 over utf8 content", () => {
    const expected = "sha256:" + createHash("sha256").update(CONTENT, "utf8").digest("hex");
    expect(fileDigest(CONTENT)).toBe(expected);
  });

  it("buildExecutorPrompt carries the excerpt digest the runtime computed", () => {
    const ctx = {
      task: { id: "T001", title: "t", kind: "modify", intent: "i" } as Task,
      properties: [],
      readFiles: [{ path: "src/a.ts", content: CONTENT, digest: fileDigest(CONTENT) }],
      priorResults: [],
      observations: [],
      allowedReadPaths: ["src/**"],
      allowedWritePaths: ["src/**"],
    } satisfies Partial<ExecutorTaskContext> as ExecutorTaskContext;
    const specIr = fixtureSpecIr();
    const prompt = buildExecutorPrompt(ctx, specIr, fixtureSnapshot());
    const payload = JSON.parse(prompt.split("\n").slice(2).join("\n"));
    expect(payload.repositoryExcerpts[0].digest).toBe(fileDigest(CONTENT));
  });
});

describe("executeTask wiring", () => {
  it("applies a completed patch op and reports it as patched", async () => {
    const wt = worktree();
    const outcome = await runExecutorTask(wt, (prompt) => {
      const payload = JSON.parse(prompt.split("\n").slice(2).join("\n"));
      expect(payload.repositoryExcerpts[0].digest).toBe(fileDigest(CONTENT));
      return completed([patchOp()]);
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.appliedChanges).toContainEqual({ path: "src/a.ts", change: "patched" });
    expect(readFileSync(path.join(wt, "src", "a.ts"), "utf8")).toBe(CONTENT.replace("return false;", "return ok;"));
  });

  it("fails the task on a stale base digest and leaves the tree untouched", async () => {
    const wt = worktree();
    const outcome = await runExecutorTask(wt, () =>
      completed([patchOp({ baseDigest: "sha256:" + "2".repeat(64) })]),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.code).toBe(PATCH_BASE_MISMATCH);
    expect(readFileSync(path.join(wt, "src", "a.ts"), "utf8")).toBe(CONTENT);
  });

  it("writes nothing when a later op in the array refuses", async () => {
    const wt = worktree();
    const outcome = await runExecutorTask(wt, () =>
      completed([
        { op: "create", path: "src/new.ts", content: "export const x = 1;\n" },
        patchOp({ anchor: "no such anchor" }),
      ]),
    );
    expect(outcome.status).toBe("failed");
    expect(() => readFileSync(path.join(wt, "src", "new.ts"))).toThrow();
    expect(readFileSync(path.join(wt, "src", "a.ts"), "utf8")).toBe(CONTENT);
  });
});

function completed(changes: ProposedChange[]) {
  return {
    status: "completed" as const,
    summary: "patch applied",
    changes,
    commands: [],
    observations: [],
    evidenceCandidates: [],
    followups: [],
  };
}

function fakeProvider(answer: (prompt: string) => ReturnType<typeof completed>): LLMProvider {
  return {
    name: "fake",
    model: "fake",
    async generateStructured<T>(_request: StructuredRequest<T>) {
      const prompt = _request.prompt;
      return { value: answer(prompt) as unknown as T, usage: { model: "fake", durationMs: 1 } };
    },
  };
}

const MINIMAL_SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: patch-fixture
  title: Patch fixture
goal: fixture spec for executor wiring tests
requirements:
  - id: PF-001
    statement: fixture property.
    priority: must
    acceptance:
      - id: PF-001-A
        type: command
        command: "true"
`;

let cachedIr: SpecIR | null = null;
function fixtureSpecIr(): SpecIR {
  cachedIr ??= compileSpecSource(MINIMAL_SPEC, "patch-fixture.yaml").ir!;
  return cachedIr;
}

function fixtureSnapshot(): RepositorySnapshot {
  return {
    revision: "r",
    dirty: false,
    languages: [],
    manifests: [],
    directories: [],
    tests: [],
    commands: {},
    relevantArtifacts: [],
    createdAt: "2026-10-19T00:00:00.000Z",
    digest: `sha256:${"0".repeat(64)}`,
  };
}

async function runExecutorTask(
  wt: string,
  answer: (prompt: string) => ReturnType<typeof completed>,
) {
  return executeTask(
    {
      task: {
        id: "T001",
        title: "apply a patch",
        kind: "modify",
        intent: "edit src/a.ts via an anchored patch",
        targets: { read: ["src/**"], write: ["src/**"] },
      },
      specIr: fixtureSpecIr(),
      snapshot: fixtureSnapshot(),
      worktreeRoot: wt,
      attempt: 1,
      priorResults: [],
      observations: [],
    },
    { provider: fakeProvider(answer) },
  );
}
