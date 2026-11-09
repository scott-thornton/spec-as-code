import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Shared fixture for the impact oracles (specs/evidence-impact-report):
 * a throwaway git workspace with one spec carrying four criteria - a
 * file criterion (fact.txt), a scoped command criterion
 * (pnpm --filter @demo/pkg-a...), an unscoped command criterion
 * (node scripts/check.js - declares the whole workspace), and an
 * unresolvable suite reference - plus one recorded run whose evidence
 * names the file criterion. HEAD moves one file inside pkg-a's scope;
 * fact.txt stays untouched.
 */
export interface ImpactFixture {
  root: string;
  base: string;
  head: string;
  runDir: string;
  factPath: string;
  pkgAFile: string;
}

export function makeImpactRepo(): ImpactFixture {
  const root = mkdtempSync(path.join(tmpdir(), "spc-impact-"));
  const sh = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const write = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content, "utf8");
  };

  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("package.json", '{ "name": "demo-root", "private": true }\n');
  write("packages/pkg-a/package.json", '{ "name": "@demo/pkg-a", "private": true }\n');
  write("packages/pkg-a/src/a.ts", "export const a = 1;\n");
  write("packages/pkg-a/src/b.ts", "export const b = 2;\n");
  // A TRACKED dist artifact: the disjointness check must not treat it
  // as outside a scope that contains it (the filtered-file-set trap).
  write("packages/pkg-a/dist/gen.js", "console.log(1);\n");
  // pkg-b depends on pkg-a through the workspace protocol - exercises
  // the withDeps closure resolution.
  write("packages/pkg-b/package.json", '{ "name": "@demo/pkg-b", "private": true, "dependencies": { "@demo/pkg-a": "workspace:*" } }\n');
  write("packages/pkg-b/src/c.ts", "export const c = 3;\n");
  write("fact.txt", "the fact\n");
  write(
    "specs/impact-demo.yaml",
    [
      "apiVersion: spc.dev/v1alpha1",
      "kind: Spec",
      "metadata:",
      "  id: impact-demo",
      "  title: Impact demo",
      "goal: >",
      "  impact oracle fixture",
      "requirements:",
      "  - id: IMPD-001",
      "    statement: mixed criteria for the projection matrix",
      "    priority: must",
      "    acceptance:",
      "      - id: IMPD-001-A",
      "        type: file",
      "        path: fact.txt",
      "        assert:",
      "          exists: true",
      "      - id: IMPD-001-B",
      "        type: command",
      "        command: pnpm --filter @demo/pkg-a... exec vitest run src/a.test.ts",
      "        expect: {exitCode: 0}",
      "      - id: IMPD-001-C",
      "        type: command",
      "        command: node scripts/check.js",
      "        expect: {exitCode: 0}",
      "      - id: IMPD-001-D",
      "        type: suite",
      "        ref: no-such-suite",
      "      - id: IMPD-001-E",
      "        type: command",
      "        command: pnpm -r run build",
      "        expect: {exitCode: 0}",
      "      - id: IMPD-001-F",
      "        type: command",
      "        command: pnpm --filter @demo/pkg-a --filter @demo/ghost exec vitest run src/a.test.ts",
      "        expect: {exitCode: 0}",
    ].join("\n") + "\n",
    );
  // One recorded apply run whose evidence names the file criterion.
  const runDir = path.join(root, ".spc", "runs", "run-demo0001-aaaa");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "metadata.json"),
    JSON.stringify(
      {
        kind: "apply",
        runId: "run-demo0001-aaaa",
        specId: "impact-demo",
        specDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        planId: "plan-demo-0001",
        baseRevision: "placeholder",
        createdAt: "2026-11-09T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(runDir, "evidence.jsonl"),
    JSON.stringify({
      id: "ev-demo-1",
      runId: "run-demo0001-aaaa",
      criterionId: "IMPD-001-A",
      propertyRefs: ["IMPD-001"],
      kind: "file",
      outcome: "supports",
      producer: { type: "runtime" },
      timestamp: "2026-11-09T00:00:01.000Z",
      repositoryRevision: "placeholder",
      payload: { path: "fact.txt", observed: { exists: true } },
    }) + "\n",
    "utf8",
  );

  sh(["init", "-q", "-b", "main"]);
  sh(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  // Amend the recorded run's revision pin to the real base.
  const metaPath = path.join(runDir, "metadata.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, string>;
  meta.baseRevision = base;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  // HEAD: move one file inside pkg-a's declared scope; fact.txt untouched.
  write("packages/pkg-a/src/a.ts", "export const a = 2;\n");
  sh(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "touch pkg-a"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  return { root, base, head, runDir, factPath: "fact.txt", pkgAFile: "packages/pkg-a/src/a.ts" };
}

export function cleanup(fixture: ImpactFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}
