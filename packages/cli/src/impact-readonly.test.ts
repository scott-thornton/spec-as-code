import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeImpactRepo, type ImpactFixture } from "./impact-fixture.js";

// Oracle for specs/evidence-impact-report.yaml IMP-C01 (red,
// committed pre-run): impact is a read-only view. It writes no
// supporting evidence, alters no event log, changes no verdict,
// creates no run record, and skips nothing - it executes no criteria
// (pure derivation, no admission lock). Today the command does not
// exist - this is red.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
let fx: ImpactFixture;
beforeAll(() => {
  fx = makeImpactRepo();
});
afterAll(() => cleanup(fx));

function digestTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      hash.update(entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

describe("IMP-C01: impact is a read-only view", () => {
  it("the run store, the working tree, and the spec are byte-identical after a report; no run record is created", () => {
    const spcBefore = digestTree(path.join(fx.root, ".spc"));
    const gitBefore = spawnSync("git", ["status", "--porcelain"], { cwd: fx.root, encoding: "utf8" }).stdout;
    const r = spawnSync(process.execPath, [CLI, "impact", `${fx.base}..${fx.head}`], {
      cwd: fx.root, encoding: "utf8", timeout: 60_000,
    });
    expect(r.status).toBe(0);
    const spcAfter = digestTree(path.join(fx.root, ".spc"));
    const gitAfter = spawnSync("git", ["status", "--porcelain"], { cwd: fx.root, encoding: "utf8" }).stdout;
    expect(spcAfter).toBe(spcBefore);
    expect(gitAfter).toBe(gitBefore);
    // No new run records appeared.
    expect(readdirSync(path.join(fx.root, ".spc", "runs")).filter((d) => d.startsWith("run-"))).toEqual(["run-demo0001-aaaa"]);
    // And it is fast: pure derivation, no criterion execution. A
    // generous ceiling that any spawned battery would blow through.
    const start = Date.now();
    spawnSync(process.execPath, [CLI, "impact", `${fx.base}..${fx.head}`], { cwd: fx.root, encoding: "utf8", timeout: 60_000 });
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(statSync(path.join(fx.root, ".spc")).mtimeMs).toBeGreaterThanOrEqual(0);
  });
});
