import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runRecovery } from "./recovery.js";

// Oracle for specs/recover-confirm.yaml REC-001 (red, committed
// pre-run): recover --confirm proceeds past unverifiable workers with
// every unverified identity NAMED in the record - never silently. A
// SIGTERM-trapping live process plays the wedged worker (the darwin
// shape: identity-bound termination unavailable). Today runRecovery
// takes no confirmation and returns incomplete on the unverified
// worker.
const root = mkdtempSync(path.join(tmpdir(), "spc-rec-"));
const planted: ReturnType<typeof spawn>[] = [];
afterAll(() => {
  for (const c of planted) if (!c.killed) c.kill("SIGKILL");
  if (!process.env.SPC_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
});

/** A live process that ignores SIGTERM - the wedged worker. */
function plantWedgedWorker(): number {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 120000);"], { stdio: "ignore" });
  planted.push(child);
  return child.pid!;
}

function fixture(name: string, workerPid: number): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".spc", "runs", "run-fixture-1"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  writeFileSync(
    path.join(repo, ".spc", "runs", "run-fixture-1", "events.jsonl"),
    JSON.stringify({ seq: 1, id: "fix-0001", type: "RUN_CREATED", runId: "run-fixture-1", timestamp: new Date().toISOString(), payload: { dirty: false }, chain: "sha256:" + "0".repeat(64) }) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(repo, ".spc", "runs", "run-fixture-1", "state.json"),
    JSON.stringify({ runId: "run-fixture-1", status: "running", specId: "fixture", tasks: {} }),
    "utf8",
  );
  writeFileSync(
    path.join(repo, ".spc", "execution-intent.json"),
    JSON.stringify({
      cause: "NONE",
      coordinator: { pid: 1, processStartTime: "2026-11-06T00:00:00.000Z", host: "fixture" },
      workers: [{ pid: workerPid, processStartTime: "2026-11-06T00:00:00.000Z", host: require("node:os").hostname(), startedAt: "2026-11-06T00:00:00.000Z" }],
      startedAt: "2026-11-06T00:00:00.000Z",
      runId: "run-fixture-1",
      planId: "plan-fixture-1",
      restoration: { originalBranch: "main", originalHead: "HEAD", restorationTarget: "main" },
    }),
    "utf8",
  );
  return repo;
}

describe("REC-001: --confirm proceeds past unverifiable workers, recorded", () => {
  it("confirmed with all workers verifiably dead: recovered, NO confirmation marker, detail says all verified stopped", { timeout: 60_000 }, () => {
    const repo = fixture("confirmed-clean", 999_999_999); // nonexistent pid: ESRCH = verified dead
    const r = runRecovery(repo, { confirmed: true });
    expect(r.status).toBe("recovered");
    expect(r.detail).toMatch(/all verified stopped/);
    const events = readFileSync(path.join(repo, ".spc", "runs", "run-fixture-1", "events.jsonl"), "utf8");
    expect(events).not.toMatch(/recoveryConfirmed/);
  });

  it("without confirmation: incomplete, the unverified pid named, intent preserved", { timeout: 60_000 }, () => {
    const pid = plantWedgedWorker();
    const repo = fixture("no-confirm", pid);
    const r = runRecovery(repo);
    expect(r.status).toBe("incomplete");
    expect(r.detail).toContain(String(pid));
    expect(existsSync(path.join(repo, ".spc", "execution-intent.json"))).toBe(true);
  });

  it("with confirmation: recovered, the terminal event carries recoveryConfirmed and the unverified pid, intent cleared", { timeout: 60_000 }, () => {
    const pid = plantWedgedWorker();
    const repo = fixture("confirmed", pid);
    const r = runRecovery(repo, { confirmed: true });
    expect(r.status).toBe("recovered");
    expect(r.detail).toContain(String(pid));
    const events = readFileSync(path.join(repo, ".spc", "runs", "run-fixture-1", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const terminal = events.find((e) => e.type === "RUN_COMPLETED");
    expect(terminal).toBeDefined();
    expect(terminal!.payload?.["recoveryConfirmed"]).toBe(true);
    expect(JSON.stringify(terminal!.payload?.["unverifiedWorkers"])).toContain(String(pid));
    expect(existsSync(path.join(repo, ".spc", "execution-intent.json"))).toBe(false);
  });
});
