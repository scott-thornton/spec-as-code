import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Oracle for specs/verify-selection.yaml: spc verify takes one or more
// selectors (file path, file stem or spec id) and verifies exactly
// those, in order, each once; an unknown selector fails the whole
// invocation before anything verifies. At base the command accepts a
// single file only, so every selection case below fails on its
// assertion - two arguments are rejected as "too many arguments", a bare
// id is treated as a missing file path. No criterion of this spec uses
// a title filter: the whole file runs.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-versel-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T = { timeout: 60_000 };

function specYaml(id: string): string {
  return [
    "apiVersion: spc.dev/v1alpha1",
    "kind: Spec",
    "metadata:",
    `  id: ${id}`,
    `  title: ${id}`,
    `goal: ${id} holds.`,
    "requirements:",
    "  - id: R-001",
    "    statement: The marker file exists.",
    "    priority: must",
    "    acceptance:",
    "      - id: R-001-A",
    "        type: file",
    `        path: marker-${id}.txt`,
    "        assert:",
    "          exists: true",
    "",
  ].join("\n");
}

interface FixtureSpec {
  file: string;
  id: string;
  /** Default true; false leaves the marker out, so the spec is unsatisfied. */
  ok?: boolean;
}

function setupRepo(name: string, specs: FixtureSpec[]): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  for (const s of specs) {
    writeFileSync(path.join(repo, "specs", `${s.file}.yaml`), specYaml(s.id));
    if (s.ok !== false) writeFileSync(path.join(repo, `marker-${s.id}.txt`), "ok\n");
  }
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

function spc(cwd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const THREE: FixtureSpec[] = [
  { file: "alpha", id: "alpha" },
  { file: "bravo", id: "bravo" },
  { file: "charlie", id: "charlie" },
];

describe("spc verify with an explicit selection", () => {
  it("two file paths: verifies exactly those two, in order, each reported", T, () => {
    const repo = setupRepo("two-paths", THREE);
    const r = spc(repo, ["verify", "specs/alpha.yaml", "specs/bravo.yaml"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Spec: alpha");
    expect(r.out).toContain("Spec: bravo");
    expect(r.out).not.toContain("charlie");
    expect(r.out.indexOf("Spec: alpha")).toBeLessThan(r.out.indexOf("Spec: bravo"));
  });

  it("bare selectors: resolve by file stem and by spec id", T, () => {
    const repo = setupRepo("ids", [...THREE, { file: "odd-name", id: "zulu" }]);
    const r = spc(repo, ["verify", "bravo", "zulu"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Spec: bravo");
    expect(r.out).toContain("Spec: zulu");
    expect(r.out).not.toContain("alpha");
    expect(r.out).not.toContain("charlie");
  });

  it("one selector by id keeps the single-spec output", T, () => {
    const repo = setupRepo("one-id", THREE);
    const r = spc(repo, ["verify", "charlie"]);
    expect(r.status).toBe(0);
    expect(r.out.match(/Verification run:/g) ?? []).toHaveLength(1);
    expect(r.out).not.toContain("Spec: ");
    expect(r.out).not.toContain("alpha");
  });

  it("a selector given twice, by id and by path, verifies once", T, () => {
    const repo = setupRepo("twice", THREE);
    const r = spc(repo, ["verify", "alpha", "specs/alpha.yaml"]);
    expect(r.status).toBe(0);
    expect(r.out.match(/Verification run:/g) ?? []).toHaveLength(1);
    expect(r.out).not.toContain("Spec: ");
  });

  it("an unknown selector fails the whole invocation before anything verifies", T, () => {
    const repo = setupRepo("unknown", THREE);
    const r = spc(repo, ["verify", "specs/alpha.yaml", "nope"]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("SPEC_FILE_NOT_FOUND");
    expect(r.out).toContain("nope");
    expect(r.out).not.toContain("Verification run:");
  });

  it("worst-of across the selection: one failing selected spec exits 1, the passing one still reports", T, () => {
    const repo = setupRepo("worst", [
      { file: "alpha", id: "alpha" },
      { file: "bravo", id: "bravo", ok: false },
      { file: "charlie", id: "charlie" },
    ]);
    const r = spc(repo, ["verify", "alpha", "bravo"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Spec: alpha");
    expect(r.out).toContain("Spec: bravo");
    expect(r.out).not.toContain("charlie");
  });

  it("json: one report per selected spec in selection order, then the failures array", T, () => {
    const repo = setupRepo("json", THREE);
    const r = spc(repo, ["verify", "charlie", "alpha", "--format", "json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.out) as Record<string, unknown>[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((p) => p.spec)).toEqual(["charlie", "alpha", undefined]);
    expect(parsed[parsed.length - 1]).toHaveProperty("failures");
  });
});

describe("controls: no selector and one file keep their behavior", () => {
  it("no selector verifies every spec under specs/", T, () => {
    const repo = setupRepo("all", THREE);
    const r = spc(repo, ["verify"]);
    expect(r.status).toBe(0);
    for (const s of THREE) expect(r.out).toContain(`Spec: ${s.id}`);
  });

  it("one file path verifies exactly that spec, single-spec output", T, () => {
    const repo = setupRepo("one-file", THREE);
    const r = spc(repo, ["verify", "specs/alpha.yaml"]);
    expect(r.status).toBe(0);
    expect(r.out.match(/Verification run:/g) ?? []).toHaveLength(1);
    expect(r.out).not.toContain("Spec: ");
    expect(r.out).not.toContain("bravo");
  });
});
