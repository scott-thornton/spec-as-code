import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";

// Oracle for specs/failure-classification.yaml (FC-003B): runCommand
// records the child's termination signal as structured diagnostic
// context - our own timeout kill surfaces as signal SIGKILL alongside
// timedOut, and it never travels alone.
const root = mkdtempSync(path.join(tmpdir(), "spc-sig-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

writeFileSync(path.join(root, "hang.cjs"), "setTimeout(() => {}, 10000);\n", "utf8");

describe("termination-signal capture (FC-003B)", () => {
  it("records signal as context on a timeout kill", async () => {
    const run = await runCommand("node hang.cjs", {
      cwd: root,
      timeoutMs: 1000,
      maxOutputBytes: 65536,
      commandsConfig: { unknown: "allow" } as never,
    });
    expect(run.timedOut).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(run.exitCode).toBeNull();
  });

  it("a clean exit carries no signal", async () => {
    writeFileSync(path.join(root, "ok.cjs"), "process.exit(0);\n", "utf8");
    const run = await runCommand("node ok.cjs", {
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 65536,
      commandsConfig: { unknown: "allow" } as never,
    });
    expect(run.exitCode).toBe(0);
    expect(run.signal ?? null).toBeNull();
  });
});
