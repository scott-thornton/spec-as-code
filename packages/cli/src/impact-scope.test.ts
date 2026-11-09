import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeImpactRepo, type ImpactFixture } from "./impact-fixture.js";

// Oracle for specs/evidence-impact-report.yaml IMP-002 (red,
// committed pre-run): the projection matrix. File criteria project by
// exact path membership; command criteria project by the DECLARED
// filter scope (unscoped commands are undetermined - they declare the
// whole workspace); disjoint only when the scope's tracked files and
// the changed paths are provably disjoint; unresolvable suite
// references are undetermined. Never speculative disjointness. Today
// the command does not exist - this is red.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
let fx: ImpactFixture;
beforeAll(() => {
  fx = makeImpactRepo();
});
afterAll(() => cleanup(fx));

function impactJson(base: string, head: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, [CLI, "impact", `${base}..${head}`, "--json"], {
    cwd: fx.root, encoding: "utf8", timeout: 60_000,
  });
  expect(r.status).toBe(0);
  return JSON.parse((r.stdout ?? "") + (r.stderr ?? "")) as Record<string, unknown>;
}

function projectionOf(report: Record<string, unknown>, criterionId: string): { projection: string; source?: string } {
  const specs = report["specs"] as { id: string; criteria: { id: string; projection: string; source?: string }[] }[];
  const spec = specs.find((s) => s.id === "impact-demo")!;
  return spec.criteria.find((c) => c.id === criterionId)!;
}

describe("IMP-002: the projection matrix", () => {
  it("pkg-a changed: the scoped command intersects, the untouched file is disjoint, the unscoped command and the unresolvable suite are undetermined", () => {
    const report = impactJson(fx.base, fx.head);
    const b = projectionOf(report, "IMPD-001-B");
    expect(b.projection).toBe("scope-intersected");
    expect(b.source).toMatch(/@demo\/pkg-a/);
    const a = projectionOf(report, "IMPD-001-A");
    expect(a.projection).toBe("scope-disjoint");
    const c = projectionOf(report, "IMPD-001-C");
    expect(c.projection).toBe("undetermined");
    expect((c.source ?? "") + JSON.stringify(c)).toMatch(/unscoped|whole workspace/i);
    const d = projectionOf(report, "IMPD-001-D");
    expect(d.projection).toBe("undetermined");
    expect((d.source ?? "") + JSON.stringify(d)).toMatch(/suite|resolve/i);
  });

  it("only fact.txt changed: the file criterion intersects and the scoped command is PROVABLY disjoint (pkg-a untouched)", () => {
    writeFileSync(path.join(fx.root, "fact.txt"), "the fact, changed\n", "utf8");
    const gc = (args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: fx.root, encoding: "utf8" });
    expect(gc(["add", "-A"]).status).toBe(0);
    expect(gc(["commit", "-qm", "touch fact"]).status).toBe(0);
    const head2 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fx.root, encoding: "utf8" }).stdout.trim();
    // The range must contain ONLY the fact.txt change - fx.head is the
    // commit that touched pkg-a, so diffing from fx.base would still
    // carry a.ts in the changed set.
    const report = impactJson(fx.head, head2);
    expect(projectionOf(report, "IMPD-001-A").projection).toBe("scope-intersected");
    const b = projectionOf(report, "IMPD-001-B");
    expect(b.projection).toBe("scope-disjoint");
    expect(b.source).toMatch(/@demo\/pkg-a/);
  });
});

// Rectification oracles (adversarial pass on run-mw8q4nhg, F1s 1-3):
// disjointness is asserted ONLY from complete, declared structural
// scopes. Three channels produced false scope-disjoint - today these
// are red.
describe("IMP-002 rectification: completeness of the declared scope", () => {
  const gc = (args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: fx.root, encoding: "utf8" });

  it("a changed TRACKED dist artifact inside the scope directory is never disjoint - the filtered file set is incomplete, so undetermined", () => {
    writeFileSync(path.join(fx.root, "packages/pkg-a/dist/gen.js"), "console.log(2);\n", "utf8");
    expect(gc(["add", "-A"]).status).toBe(0);
    expect(gc(["commit", "-qm", "touch dist artifact"]).status).toBe(0);
    const head3 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fx.root, encoding: "utf8" }).stdout.trim();
    const report = impactJson(fx.head, head3);
    const b = projectionOf(report, "IMPD-001-B");
    expect(b.projection).toBe("undetermined");
  });

  it("a workspace-union scope (pnpm -r) intersects when the workspace-DEFINING config changes - the -r closure is defined by those files", () => {
    writeFileSync(path.join(fx.root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - tools/*\n", "utf8");
    expect(gc(["add", "-A"]).status).toBe(0);
    expect(gc(["commit", "-qm", "touch workspace config"]).status).toBe(0);
    const head4 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fx.root, encoding: "utf8" }).stdout.trim();
    const report = impactJson(fx.head, head4);
    const e = projectionOf(report, "IMPD-001-E");
    expect(e.projection).toBe("scope-intersected");
    // A package-scoped criterion is NOT affected by the root config: pkg-a itself is untouched.
    const b = projectionOf(report, "IMPD-001-B");
    expect(b.projection).toBe("scope-disjoint");
  });

  it("a declared package that does not resolve makes the scope incomplete - undetermined, never disjoint", () => {
    const report = impactJson(fx.base, fx.head);
    const f = projectionOf(report, "IMPD-001-F");
    expect(f.projection).toBe("undetermined");
    expect((f.source ?? "") + JSON.stringify(f)).toMatch(/ghost|does not resolve|unresolved/i);
  });
});
