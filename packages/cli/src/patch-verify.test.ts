import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/patch-verify.yaml: composition-time chain validation.
// The verify-dedup incidents burned queue round-trips because the only
// checker of a changes array's internal consistency was the applicator,
// at the far end of the loop. patch verify and respond-side validation
// move that check to composition time: an order-broken array (a chained
// op sorted before its sibling by filename) and a stale first-op digest
// both die locally, named, in a second.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-patchverify-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, "lib"), { recursive: true });
mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(path.join(root, "lib", "chain.txt"), "alpha\nbeta\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

// Two correctly-chained ops on one path, built by the tooling itself.
writeFileSync("/tmp/pv-a.anchor", "alpha");
writeFileSync("/tmp/pv-a.repl", "ALPHA");
writeFileSync("/tmp/pv-b.anchor", "beta");
writeFileSync("/tmp/pv-b.repl", "BETA");
const opA = JSON.parse(sh(["patch", "build", "lib/chain.txt", "--anchor-file", "/tmp/pv-a.anchor", "--replacement-file", "/tmp/pv-a.repl"]).stdout);
writeFileSync(path.join(root, "ops-a.json"), JSON.stringify([opA]), "utf8");
const opB = JSON.parse(sh(["patch", "build", "lib/chain.txt", "--anchor-file", "/tmp/pv-b.anchor", "--replacement-file", "/tmp/pv-b.repl", "--after", "ops-a.json"]).stdout);
writeFileSync(path.join(root, "ops-good.json"), JSON.stringify([opA, opB]), "utf8");
// The verify-dedup incident shape: chained op sorted BEFORE its sibling.
writeFileSync(path.join(root, "ops-reversed.json"), JSON.stringify([opB, opA]), "utf8");

// A pending request fixture for the respond-side tests.
const now = Date.now();
writeFileSync(
  path.join(root, ".spc", "harness", "pending", "executor-PV@1-1.json"),
  JSON.stringify({ id: "executor-PV@1-1", role: "executor", key: "PV@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString() }),
  "utf8",
);
const resultWith = (changes: unknown): string => {
  const f = `answer-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(path.join(root, f), JSON.stringify({ status: "completed", summary: "s", changes, commands: [], observations: [], evidenceCandidates: [], followups: [] }), "utf8");
  return f;
};

describe("spc patch verify (PV-001)", () => {
  it("a correctly-chained array passes; the same ops reversed fail with the position named", () => {
    const good = sh(["patch", "verify", "ops-good.json"]);
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/lib\/chain\.txt/);
    expect(good.stdout).toMatch(/2 ops?/);

    const reversed = sh(["patch", "verify", "ops-reversed.json"]);
    expect(reversed.status).toBe(1);
    expect(reversed.stdout).toMatch(/PATCH_BASE_MISMATCH/);
    expect(reversed.stdout).toMatch(/lib\/chain\.txt/);
    expect(reversed.stdout).toMatch(/patch build --after/);
  });

  it("an array whose first op was built against a since-changed file fails with the stale digest named", () => {
    writeFileSync(path.join(root, "lib", "chain.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const stale = sh(["patch", "verify", "ops-good.json"]);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/PATCH_BASE_MISMATCH/);
    // Restore for the respond tests.
    writeFileSync(path.join(root, "lib", "chain.txt"), "alpha\nbeta\n", "utf8");
  });
});

describe("respond-side validation (PV-002)", () => {
  it("an order-broken changes array is refused locally: nothing written, the request stays pending", () => {
    const broken = resultWith(JSON.parse(readFileSync(path.join(root, "ops-reversed.json"), "utf8")));
    const r = sh(["agent", "respond", "executor-PV@1-1", "--file", broken]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/PATCH_CHAIN_INVALID/);
    expect(r.stdout).toMatch(/PATCH_BASE_MISMATCH/);
    // Nothing was submitted: no answer record, request still pending.
    expect(sh(["agent", "list"]).stdout).toMatch(/executor-PV@1-1/);
  });

  it("a valid chained array submits unchanged (green-keeper)", () => {
    const good = resultWith(JSON.parse(readFileSync(path.join(root, "ops-good.json"), "utf8")));
    // --no-preflight focuses this test on the chain check; the rehearsal
    // guard would (correctly) fire on a chained-op answer with no preflight.
    const r = sh(["agent", "respond", "executor-PV@1-1", "--file", good, "--no-preflight"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Answered executor-PV@1-1/);
  });
});
