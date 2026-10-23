import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/records-and-replacement.yaml (RR-003): explicit
// administrative supersession - recorded, rendered, no inheritance.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-rr-sup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitsh(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "t@t"]);
gitsh(["config", "user.name", "t"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

function makeRun(runId: string, specId: string): void {
  const dir = path.join(root, ".spc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ runId, specId, createdAt: "2026-10-23T00:00:00.000Z" }),
    "utf8",
  );
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ status: "succeeded", tasks: {}, requirements: {} }), "utf8");
  writeFileSync(path.join(dir, "events.jsonl"), "", "utf8");
  writeFileSync(path.join(dir, "evidence.jsonl"), "", "utf8");
}

makeRun("run-sup-old", "rr-sup-fixture");
makeRun("run-sup-new", "rr-sup-fixture");

describe("administrative supersession (RR-003)", () => {
  it("spc run supersede records the relation and renders it", () => {
    const r = sh(["run", "supersede", "run-sup-old", "--by", "run-sup-new"]);
    expect(r.status).toBe(0);
    const meta = JSON.parse(readFileSync(path.join(root, ".spc", "runs", "run-sup-new", "metadata.json"), "utf8")) as {
      supersedesRunId?: string;
    };
    expect(meta.supersedesRunId).toBe("run-sup-old");
    const events = readFileSync(path.join(root, ".spc", "runs", "run-sup-new", "events.jsonl"), "utf8");
    expect(events).toContain("SUPERSEDED_RUN");
    expect(events).toContain("run-sup-old");
    // The superseded run keeps its own records and is rendered as superseded.
    const show = sh(["run", "show", "run-sup-old"]);
    expect(show.stdout).toMatch(/superseded by run-sup-new/);
  });

  it("refuses unknown runs loudly", () => {
    const r = sh(["run", "supersede", "run-nope", "--by", "run-sup-new"]);
    expect(r.status).not.toBe(0);
  });
});
