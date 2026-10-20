import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HarnessStore } from "@spc/llm-harness";

const root = mkdtempSync(path.join(tmpdir(), "spc-queuehygiene-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeRequest(id: string, createdAt: string): void {
  mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
  writeFileSync(
    path.join(root, ".spc", "harness", "pending", `${id}.json`),
    JSON.stringify({ id, role: "executor", key: "x@1", schemaName: "ExecutorResult", jsonSchema: { type: "object" }, system: "s", prompt: "p", createdAt }),
    "utf8",
  );
}
function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

mkdirSync(path.join(root, ".spc"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
git(["init", "-q", "-b", "main"]);
git(["add", "."]);
git(["commit", "-q", "-m", "base", "--allow-empty"]);

// A stale request (far older than any window) and a live one.
writeRequest("executor-OLD@1-1", "2026-10-01T00:00:00.000Z");
writeRequest("executor-LIVE@1-1", new Date().toISOString());

describe("harness queue hygiene", () => {
  it("listPending excludes stale requests but a --since/--include-stale surface shows them", () => {
    const store = new HarnessStore(root);
    const pending = store.listPending();
    expect(pending.map((r) => r.id)).toContain("executor-LIVE@1-1");
    expect(pending.map((r) => r.id)).not.toContain("executor-OLD@1-1");
    const all = store.listPendingIncludingStale();
    expect(all.map((r) => r.id).sort()).toEqual(["executor-LIVE@1-1", "executor-OLD@1-1"]);
  });

  it("the provider never dispatches a stale request again once swept", () => {
    const store = new HarnessStore(root);
    expect(store.sweepStale(24 * 60 * 60 * 1000)).toBe(1);
    // Swept requests are not deleted - they are records - but they are
    // out of the live queue, filed where nothing dispatches them.
    expect(store.listPending().map((r) => r.id)).toEqual(["executor-LIVE@1-1"]);
    expect(store.listPendingIncludingStale().length).toBe(2);
  });

  it("a fresh request is never swept regardless of count", () => {
    const store = new HarnessStore(root);
    expect(store.sweepStale(24 * 60 * 60 * 1000)).toBe(0);
  });
});
