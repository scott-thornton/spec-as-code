import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/host-battery-admission.yaml HBA-004-A (red,
// committed pre-run): the CLI surface of ci placement - a local
// verify under execution.verificationPlacement=ci defers its command
// criterion visibly (admission-deferred named in the report, the
// Unsatisfied block carries the deferral, exit non-zero because a
// must cannot be satisfied by a deferral) while the file criterion
// verifies. The revision-bound CI re-execution path (verify --run)
// already exists; this oracle pins the deferral linkage only.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-hba-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(
  path.join(root, "specs", "place.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: place\n  title: P\ngoal: g\nrequirements:\n  - id: PLACE-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: PLACE-001-A\n        type: command\n        command: node ok.cjs\n        expect:\n          exitCode: 0\n      - id: PLACE-001-B\n        type: file\n        path: fact.txt\n        assert:\n          exists: true\n',
  "utf8",
);
writeFileSync(path.join(root, "ok.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, "fact.txt"), "x\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
writeFileSync(
  path.join(root, ".spc", "config.yaml"),
  "version: 1\nprovider:\n  name: harness\nexecution:\n  verificationPlacement: ci\n",
  "utf8",
);
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: root });

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("HBA-004: the CLI surface of ci placement", () => {
  it("verify under ci placement: exit non-zero, the command criterion deferred and named, the file criterion verified", { timeout: 60_000 }, () => {
    const r = sh(["verify", "specs/place.yaml"]);
    // A deferred must cannot satisfy - honest non-zero.
    expect(r.status).not.toBe(0);
    // The deferral is named, not silent.
    expect(r.stdout).toMatch(/admission-deferred|deferred/i);
    // The file criterion ran and passed (visible in the report).
    expect(r.stdout).toMatch(/satisfied\s+PLACE-001|PLACE-001-B/i);
  });

  it("verify --run remains the revision-bound re-execution path (exists unchanged)", { timeout: 30_000 }, () => {
    // Flag presence check only - the machinery predates this spec.
    const r = sh(["verify", "--help"]);
    expect(r.stdout).toMatch(/--run <runId>/);
  });
});
