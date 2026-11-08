import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/host-battery-admission.yaml HBA-002-A / HBA-C02-A
// (red, committed pre-run): process-level admission against the real
// CLI - a second verify while a holder holds the host lock exits
// non-zero naming the refusal; a SIGKILLed holder releases immediately
// (the flock death contract, AO-002's shape one level up) and the next
// verify succeeds. Today no admission exists: the second verify runs
// its battery alongside the holder and the refusal assertions fail.
const CLI = path.resolve(import.meta.dirname, "../../cli/dist/main.js");
const root = mkdtempSync(path.join(tmpdir(), "spc-hba-proc-"));
const lockPath = path.join(root, "host-admission.lock");
const repo = path.join(root, "repo");
afterAll(() => {
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

mkdirSync(path.join(repo, "specs"), { recursive: true });
writeFileSync(path.join(repo, "specs", "hba.yaml"),
  'apiVersion: spc.dev/v1alpha1\nkind: Spec\nmetadata:\n  id: hba\n  title: HBA\ngoal: g\nrequirements:\n  - id: HBA-001\n    statement: s\n    priority: must\n    acceptance:\n      - id: HBA-001-A\n        type: command\n        command: node ok.cjs\n        expect:\n          exitCode: 0\n',
  "utf8");
writeFileSync(path.join(repo, "ok.cjs"), "process.exit(0);\n", "utf8");
writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo });
spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: repo });

function startHolder(): ReturnType<typeof spawn> {
  const runtimeDist = path.resolve(import.meta.dirname, "../../runtime/dist");
  const script = `
    const { createRequire } = require("node:module");
    const fsExt = createRequire(${JSON.stringify(runtimeDist)})( "fs-ext");
    const fs = require("node:fs");
    const fd = fs.openSync(${JSON.stringify(lockPath)}, "w");
    fsExt.flockSync(fd, "exnb");
    console.log("HELD");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.once("data", () => {});
  return child;
}

function verify(): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, "verify", "specs/hba.yaml"], {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, SPC_ADMISSION_LOCK: lockPath },
  });
  return { status: r.status, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Await the holder's HELD line before contending. */
function waitHeld(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => child.stdout!.once("data", () => resolve()));
}

describe("HBA-002/HBA-C02: process-level admission (the real CLI)", () => {
  it("a verify under a held host lock: non-zero, the refusal named, never a contradicted battery", { timeout: 60_000 }, async () => {
    const holder = startHolder();
    await waitHeld(holder);
    try {
      const r = verify();
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/admission-refused|admission/i);
      expect(r.stdout).not.toMatch(/contradicted/i);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("a SIGKILLed holder releases immediately - the next verify succeeds (the flock death contract)", { timeout: 60_000 }, async () => {
    const holder = startHolder();
    await waitHeld(holder);
    const exited = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
    holder.kill("SIGKILL");
    await exited;
    const r = verify();
    expect(r.status).toBe(0);
  });
});
