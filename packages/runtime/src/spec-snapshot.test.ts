import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createVerifyRun } from "./index.js";
import { compileSpecFile } from "@spc/repo";

// Oracle for specs/records-and-replacement.yaml (RR-002): every run
// directory freezes the spec it obligated against.
const root = mkdtempSync(path.join(tmpdir(), "spc-rr-snap-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: rr-snap-fixture
  title: fixture
goal: fixture
requirements:
  - id: RRS-001
    statement: Gate passes.
    priority: must
    acceptance:
      - id: RRS-001-A
        type: command
        command: node gate.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
writeFileSync(path.join(root, "specs", "rr-snap-fixture.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, "gate.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "t@t"]);
gitsh(["config", "user.name", "t"]);
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

const compiled = compileSpecFile(path.join(root, "specs", "rr-snap-fixture.yaml"));
if (!compiled.ok || !compiled.ir) throw new Error("fixture spec does not compile");

describe("spec snapshots (RR-002)", () => {
  it("a verification run freezes the spec source and digest it obligated against", async () => {
    const report = await createVerifyRun({
      repoRoot: root,
      specIr: compiled.ir,
      config: {
        provider: { name: "harness" },
        execution: { commandTimeoutMs: 10_000, maxOutputBytes: 65536 },
        commands: {},
        verification: {},
      } as never,
      provider: null,
    });
    const snapshotFile = path.join(report.runDir, "spec-snapshot.yaml");
    const snapshot = readFileSync(snapshotFile, "utf8");
    expect(snapshot).toContain(compiled.ir.digest);
    expect(snapshot).toContain("rr-snap-fixture");
    // The frozen source is the actual spec text, reconstructible verbatim.
    expect(snapshot).toContain("The frozen spec source");
  });
});
