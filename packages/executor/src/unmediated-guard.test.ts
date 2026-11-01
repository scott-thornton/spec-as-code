import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateSubmission, type AttributionRecord } from "./unmediated-guard.js";
import { fileDigest, stageChanges } from "./patch.js";

// Oracle for specs/unmediated-change-guard.yaml (UCG-001, UCG-004): the
// submission-boundary predicate. A task cannot submit unmediated
// changes under its write targets regardless of whether its patch
// proposal is empty - a nonempty proposal does not disguise a direct
// edit on another path. Attribution is exact (content identity, never
// attempt numbers), committed edits do not pass on a clean status, and
// UCG-004 pins the staging semantics the guard does NOT change:
// compose-after-edit validates because stageChanges binds to CURRENT
// content, and create/update carry no digest binding at all.
const root = mkdtempSync(path.join(tmpdir(), "spc-ucg-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function head(): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
}

mkdirSync(path.join(root, "lib"), { recursive: true });
writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
writeFileSync(path.join(root, "lib", "b.ts"), "export const b = 2;\n", "utf8");
writeFileSync(path.join(root, "other.txt"), "unrelated\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);
const baseline = head();

const TARGETS = ["lib/a.ts", "lib/b.ts"];
const NO_ATTRIBUTION: AttributionRecord = { writes: [] };
const attrOf = (p: string, content: string): AttributionRecord => ({
  writes: [{ path: p, digest: fileDigest(content), kind: "applied" }],
});

describe("evaluateSubmission decision table (UCG-001)", () => {
  it("clean tree + empty proposal allows; clean tree + patch proposal is normal processing", () => {
    expect(evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: [], attribution: NO_ATTRIBUTION }).decision).toBe("allow");
    expect(evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: ["lib/a.ts"], attribution: NO_ATTRIBUTION }).decision).toBe("allow");
  });

  it("dirty under targets + no attribution + EMPTY proposal refuses with the named diagnostic and paths", () => {
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 2;\n", "utf8");
    const r = evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: [], attribution: NO_ATTRIBUTION });
    expect(r.decision).toBe("refuse");
    expect(r.code).toBe("UNMEDIATED_CHANGES");
    expect(r.unattributed).toContain("lib/a.ts");
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });

  it("dirty under targets + no attribution + NONEMPTY proposal refuses - the disguise case", () => {
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 2;\n", "utf8");
    const r = evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: ["lib/b.ts"], attribution: NO_ATTRIBUTION });
    expect(r.decision).toBe("refuse");
    expect(r.unattributed).toContain("lib/a.ts");
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });

  it("exact attribution allows legitimate recovery; stale attribution (content changed since) refuses", () => {
    const edited = "export const a = 2;\n";
    writeFileSync(path.join(root, "lib", "a.ts"), edited, "utf8");
    expect(evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: [], attribution: attrOf("lib/a.ts", edited) }).decision).toBe("allow");
    const stale = evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: [], attribution: attrOf("lib/a.ts", "export const a = 1;\n") });
    expect(stale.decision).toBe("refuse");
    expect(stale.unattributed).toContain("lib/a.ts");
  });

  it("attribution plus additional unexplained changes refuses naming the unexplained path", () => {
    writeFileSync(path.join(root, "lib", "b.ts"), "export const b = 3;\n", "utf8");
    const r = evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: [], attribution: attrOf("lib/a.ts", "export const a = 2;\n") });
    expect(r.decision).toBe("refuse");
    expect(r.unattributed).toEqual(["lib/b.ts"]);
    writeFileSync(path.join(root, "lib", "b.ts"), "export const b = 2;\n", "utf8");
  });

  it("a committed edit refuses on baseline divergence even though git status is clean", () => {
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 99;\n", "utf8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "direct commit bypass"]);
    const r = evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: [], attribution: NO_ATTRIBUTION });
    expect(r.decision).toBe("refuse");
    expect(r.code).toBe("UNMEDIATED_CHANGES");
    git(["reset", "-q", "--hard", baseline]);
  });

  it("dirt outside the task's write targets never triggers", () => {
    writeFileSync(path.join(root, "other.txt"), "changed elsewhere\n", "utf8");
    expect(evaluateSubmission({ worktreeRoot: root, baselineRevision: baseline, writeTargets: TARGETS, proposedPaths: [], attribution: NO_ATTRIBUTION }).decision).toBe("allow");
    writeFileSync(path.join(root, "other.txt"), "unrelated\n", "utf8");
  });
});

describe("staging semantics pinned as they are (UCG-004)", () => {
  it("compose-after-edit validates: stageChanges binds baseDigest to CURRENT content, not dispatch excerpts", () => {
    const edited = "export const a = 2;\n";
    writeFileSync(path.join(root, "lib", "a.ts"), edited, "utf8");
    const staged = stageChanges(root, [
      { op: "patch", path: "lib/a.ts", baseDigest: fileDigest(edited), anchor: "a = 2", replacement: "a = 3" },
    ]);
    expect(staged.ok).toBe(true); // pins the honesty claim: the guard does NOT close compose-after-edit
    writeFileSync(path.join(root, "lib", "a.ts"), "export const a = 1;\n", "utf8");
  });

  it("create and update carry no digest binding - declared content applies regardless of tree state", () => {
    const staged = stageChanges(root, [
      { op: "update", path: "lib/a.ts", content: "anything at all\n" },
      { op: "create", path: "lib/new.ts", content: "brand new\n" },
    ]);
    expect(staged.ok).toBe(true);
  });
});
