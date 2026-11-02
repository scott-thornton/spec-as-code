import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/patch-apply.yaml: the composer's missing third leg.
// Receipt: the slerp agent's hand-rolled Python patcher for a sanctioned
// between-runs oracle update - str.replace hitting every occurrence, no
// digests, per-file partial writes. patch apply is the SAME applicator
// exposed to the client: all-or-nothing staging, uniqueness, digests, a
// durable local provenance line - and the batch form taught in every
// message and skill that still routes agents to the --after pattern.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-pa-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});
function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

mkdirSync(path.join(root, "lib"), { recursive: true });
writeFileSync(path.join(root, "lib", "chain.txt"), "alpha\nbeta\n", "utf8");
writeFileSync(path.join(root, "lib", "dup.txt"), "same\nsame\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");

// A good two-op chain: chained patches on one path plus a create.
import { createHash } from "node:crypto";
const digest = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");
const GOOD = [
  { op: "patch", path: "lib/chain.txt", baseDigest: digest("alpha\nbeta\n"), anchor: "alpha", replacement: "ALPHA" },
  { op: "patch", path: "lib/chain.txt", baseDigest: digest("ALPHA\nbeta\n"), anchor: "beta", replacement: "BETA" },
  { op: "create", path: "lib/new.ts", content: "export const n = 1;\n" },
];
writeFileSync(path.join(root, "good.json"), JSON.stringify(GOOD), "utf8");

// All-or-nothing: second op's anchor absent.
writeFileSync(
  path.join(root, "bad.json"),
  JSON.stringify([
    { op: "patch", path: "lib/chain.txt", baseDigest: digest("alpha\nbeta\n"), anchor: "alpha", replacement: "ALPHA" },
    { op: "patch", path: "lib/chain.txt", baseDigest: digest("ALPHA\nbeta\n"), anchor: "NOT_PRESENT", replacement: "x" },
  ]),
  "utf8",
);

// Uniqueness: anchor occurs twice.
writeFileSync(
  path.join(root, "dup.json"),
  JSON.stringify([{ op: "patch", path: "lib/dup.txt", baseDigest: digest("same\nsame\n"), anchor: "same", replacement: "DIFF" }]),
  "utf8",
);

describe("spc patch apply (PA-001, PA-002)", () => {
  it("applies a verified chain, all-or-nothing on refusal, uniqueness enforced, and logs provenance", () => {
    const r = sh(["patch", "apply", "good.json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/applied 2 op\(s\) across 2 path\(s\)/);
    expect(readFileSync(path.join(root, "lib", "chain.txt"), "utf8")).toBe("ALPHA\nBETA\n");
    expect(readFileSync(path.join(root, "lib", "new.ts"), "utf8")).toContain("export const n");

    // PA-002: the durable local provenance line.
    const log = readFileSync(path.join(root, ".spc", "patch-log.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(log[log.length - 1]!) as { command?: string; ops?: { path: string }[] };
    expect(entry.command).toBe("patch apply");
    expect(entry.ops?.map((o) => o.path)).toContain("lib/chain.txt");

    // All-or-nothing: nothing written, a named composition code (the
    // fixture's digests were composed against the pre-apply tree, so the
    // refusal may fire as BASE_MISMATCH before the absent anchor - both
    // are the same contract: nothing writes).
    const bad = sh(["patch", "apply", "bad.json"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/PATCH_(ANCHOR_ABSENT|BASE_MISMATCH)/);
    expect(readFileSync(path.join(root, "lib", "chain.txt"), "utf8")).toBe("ALPHA\nBETA\n");

    // Uniqueness: the Python patcher's silent multi-replacement, refused.
    const dup = sh(["patch", "apply", "dup.json"]);
    expect(dup.status).toBe(1);
    expect(dup.stdout).toMatch(/PATCH_ANCHOR_NOT_UNIQUE/);
    expect(readFileSync(path.join(root, "lib", "dup.txt"), "utf8")).toBe("same\nsame\n");
  });
});

describe("the batch form taught where agents learn (PA-003)", () => {
  it("the applicator's refusal message names --batch", () => {
    // Stale expect-digest on a single build triggers PATCH_BASE_MISMATCH.
    const r = sh(["patch", "build", "lib/chain.txt", "--anchor", "ALPHA", "--replacement", "X", "--expect-digest", digest("wrong\n")]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/PATCH_BASE_MISMATCH/);
    expect(r.stdout).toMatch(/--batch/);
  });
});
