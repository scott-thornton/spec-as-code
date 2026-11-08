import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/criterion-challenge.yaml CHAL-001-B (red,
// committed pre-run): the CLI surface - spc challenge <fixture>
// exists, reports the four-outcome contract, and refuses unknown
// fixtures by name. Today the command does not exist.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-chal-cli-"));
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });

// Exit-code contract fixtures (adversarial pass, 2026-11-08): no
// oracle pinned exit 1 (non-discriminating - the verifier failed to
// reject a known defect) vs exit 2 (invalid-baseline / inconclusive
// - nothing proven); swapping the two arms passed every oracle.
// File criteria, no package root - the prepare is skipped and these
// stay cheap.
mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "challenges"), { recursive: true });
writeFileSync(path.join(root, "specs", "nd.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: chal-nd\n  title: ND\ngoal: g\nrequirements:\n  - id: ND-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: ND-001-A\n        type: file\n        path: fact-nd.txt\n        assert:\n          exists: true\n', "utf8");
writeFileSync(path.join(root, "fact-nd.txt"), "fact\n", "utf8");
writeFileSync(path.join(root, "challenges", "noop-mutation.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Challenge\nmetadata:\n  id: noop-mutation\n  title: mutation that does not affect the criterion\ncriterion:\n  spec: chal-nd\n  criterionId: ND-001-A\nopsJson: \'[{"op":"create","path":"unrelated-nd.txt","content":"noise"}]\'\nexpectedSignature: \'never-present-token\'\nprovenance:\n  introduced: "0000000"\n  caught: "0000000"\n  diagnostic: "noop"\n', "utf8");
writeFileSync(path.join(root, "specs", "ib.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: chal-ib\n  title: IB\ngoal: g\nrequirements:\n  - id: IB-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: IB-001-A\n        type: file\n        path: absent-ib.txt\n        assert:\n          exists: true\n', "utf8");
writeFileSync(path.join(root, "challenges", "red-baseline.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Challenge\nmetadata:\n  id: red-baseline\n  title: criterion already red at base\ncriterion:\n  spec: chal-ib\n  criterionId: IB-001-A\nopsJson: \'[{"op":"create","path":"unrelated-ib.txt","content":"noise"}]\'\nexpectedSignature: \'never-present-token\'\nprovenance:\n  introduced: "0000000"\n  caught: "0000000"\n  diagnostic: "red base"\n', "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args:[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("CHAL-001-B: spc challenge (CLI surface)", () => {
  it("an unknown fixture refuses by name (non-zero, named error)", { timeout: 30_000 }, () => {
    const r = sh(["challenge", "no-such-fixture"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/challenge/i);
    expect(r.stdout).toMatch(/no-such-fixture|not found|unknown/i);
  });

  it("the command's help names the contract (fixture, outcomes, no confidence metric)", { timeout: 30_000 }, () => {
    const r = sh(["challenge", "--help"]);
    expect(r.stdout).toMatch(/discriminating/i);
    expect(r.stdout).toMatch(/non-discriminating|invalid-baseline|inconclusive/i);
  });

  it("a mutation the criterion does not observe exits 1 - non-discriminating, the named outcome in the report", { timeout: 120_000 }, () => {
    const r = sh(["challenge", "noop-mutation"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/non-discriminating/i);
  });

  it("a criterion already red at base exits 2 - invalid-baseline, nothing proven", { timeout: 120_000 }, () => {
    const r = sh(["challenge", "red-baseline"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/invalid-baseline/i);
  });
});
