import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareDisposableWorktree } from "./prepare.js";

// Oracle for specs/verification-preparation.yaml (VP-001): the shared
// preparation helper for disposable worktrees - offline pnpm install,
// root node_modules link, or an honest none.
const root = mkdtempSync(path.join(tmpdir(), "spc-prep-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gitsh(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

describe("prepareDisposableWorktree (VP-001)", () => {
  it("installs offline in a pnpm workspace, capturing failure detail", () => {
    const repo = path.join(root, "pnpm-repo");
    mkdirSync(path.join(repo), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "p", private: true }), "utf8");
    // A garbage lockfile: the frozen offline install fails deterministically.
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "this is not a lockfile\n", "utf8");
    gitsh(["init", "-q", "-b", "main"], repo);
    gitsh(["config", "user.email", "t@t"], repo);
    gitsh(["config", "user.name", "t"], repo);
    gitsh(["add", "."], repo);
    gitsh(["commit", "-q", "-m", "base"], repo);
    const wt = path.join(root, "pnpm-wt");
    const r = prepareDisposableWorktree(repo, wt);
    expect(r.mode).toBe("failed");
    expect(r.detail).toBeTruthy();
  });

  it("links the root node_modules when there is no lockfile", () => {
    const repo = path.join(root, "plain-repo");
    const wt = path.join(root, "plain-wt");
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    const r = prepareDisposableWorktree(repo, wt);
    expect(r.mode).toBe("linked");
    const link = spawnSync("test", ["-d", path.join(wt, "node_modules")]);
    expect(link.status).toBe(0);
  });

  it("reports none honestly when there is nothing to install or link", () => {
    const repo = path.join(root, "bare-repo");
    const wt = path.join(root, "bare-wt");
    mkdirSync(repo, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const r = prepareDisposableWorktree(repo, wt);
    expect(r.mode).toBe("none");
  });
});
