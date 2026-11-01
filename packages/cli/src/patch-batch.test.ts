import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/patch-build-batch.yaml: the composer's batch form.
// Receipt: a 15-hunk change drove the answering agent to shadow-build a
// python driver looping `patch build --after` per hunk. One invocation
// must compose the whole chain - explicit array order, per-position
// anchor uniqueness, all-or-nothing refusal with the existing codes,
// output that `patch verify` accepts and an answer's changes array
// carries unchanged.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-pbb-"));
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});
function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

mkdirSync(path.join(root, "lib"), { recursive: true });
mkdirSync(path.join(root, "src"), { recursive: true });
writeFileSync(path.join(root, "lib", "chain.txt"), "alpha\nbeta\ngamma\n", "utf8");
writeFileSync(path.join(root, "src", "solo.ts"), "export const x = 1;\nexport const y = 2;\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");

const batch = path.join(root, "batch.json");
writeFileSync(
  batch,
  JSON.stringify([
    { op: "patch", path: "lib/chain.txt", anchor: "alpha", replacement: "ALPHA" },
    { op: "patch", path: "lib/chain.txt", anchor: "beta", replacement: "BETA" }, // chains on the overlay after ALPHA
    { op: "patch", path: "src/solo.ts", anchor: "y = 2", replacement: "y = 3" },
    { op: "create", path: "src/new.ts", content: "export const n = 1;\n" },
    { op: "delete", path: "src/solo.ts" },
  ]),
  "utf8",
);

describe("patch build --batch (PBB-001, PBB-002)", () => {
  it("one invocation composes the whole chain, in array order; the output verifies and carries create/delete verbatim", () => {
    const out = path.join(root, "ops-out.json");
    const r = sh(["patch", "build", "--batch", batch, "--out", out]);
    expect(r.status).toBe(0);
    const ops = JSON.parse(readFileSync(out, "utf8")) as { op: string; path: string }[];
    expect(ops.map((o) => `${o.op}:${o.path}`)).toEqual([
      "patch:lib/chain.txt",
      "patch:lib/chain.txt",
      "patch:src/solo.ts",
      "create:src/new.ts",
      "delete:src/solo.ts",
    ]);
    // The composed array is consumable by the existing chain checker.
    const v = sh(["patch", "verify", out]);
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/5 ops?/);
  });

  it("stdout mode prints the array as JSON", () => {
    const r = sh(["patch", "build", "--batch", batch]);
    expect(r.status).toBe(0);
    const ops = JSON.parse(r.stdout) as unknown[];
    expect(ops).toHaveLength(5);
  });

  it("a mid-batch refusal aborts the whole set: named code, no --out file, no partial array", () => {
    const bad = path.join(root, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify([
        { op: "patch", path: "lib/chain.txt", anchor: "alpha", replacement: "ALPHA" },
        { op: "patch", path: "lib/chain.txt", anchor: "NOT_PRESENT", replacement: "x" },
      ]),
      "utf8",
    );
    const out = path.join(root, "bad-out.json");
    const r = sh(["patch", "build", "--batch", bad, "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/PATCH_ANCHOR_ABSENT/);
    expect(existsSync(out)).toBe(false);
  });

  it("a malformed entry refuses with a named diagnostic, nothing written", () => {
    const ugly = path.join(root, "ugly.json");
    writeFileSync(ugly, JSON.stringify([{ op: "teleport", path: "lib/chain.txt" }]), "utf8");
    const r = sh(["patch", "build", "--batch", ugly]);
    expect(r.status).toBe(1);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(sh(["patch", "build", "--batch", path.join(root, "nope.json")]).status).toBe(1);
  });
});
