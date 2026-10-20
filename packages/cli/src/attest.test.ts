import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-attest-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}`);
}

const SPEC = [
  "apiVersion: spc.dev/v1alpha1",
  "kind: Spec",
  "metadata:",
  "  id: attested",
  "  title: Attested",
  "goal: fixture",
  "requirements:",
  "  - id: AT-001",
  "    statement: A machine-checkable property.",
  "    priority: must",
  "    acceptance:",
  "      - id: AT-001-A",
  "        type: command",
  "        command: node -e \"require('fs').writeFileSync('marker.txt','x')\"",
  "  - id: AT-002",
  "    statement: A human judges the design.",
  "    priority: should",
  "    acceptance:",
  "      - id: AT-002-A",
  "        type: human",
  "        instruction: sign off on the design",
  "",
].join("\n");

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, "specs", "attested.yaml"), SPEC, "utf8");
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);

describe("spc attest", () => {
  it("records a human-review evidence record for a property and status reflects it", () => {
    const r = sh(["attest", "AT-002", "--by", "scott", "--note", "design reviewed in person"]);
    expect(r.status).toBe(0);
    // The attestation lands in the evidence store of a new verify run.
    const runsDir = path.join(root, ".spc", "runs");
    const latest = readdirSync(runsDir).sort().pop()!;
    const evidence = readFileSync(path.join(runsDir, latest, "evidence.jsonl"), "utf8");
    expect(evidence).toContain("AT-002");
    expect(evidence).toContain("scott");
    expect(evidence).toContain("design reviewed in person");
    // And the property's status flips from indeterminate to satisfied
    // with human-review provenance.
    const state = JSON.parse(readFileSync(path.join(runsDir, latest, "state.json"), "utf8"));
    expect(state.requirements["AT-002"].status).toBe("satisfied");
  });

  it("refuses unknown property ids and runs with no such property", () => {
    const r = sh(["attest", "NOPE-999", "--by", "scott"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("NOPE-999");
  });
});
