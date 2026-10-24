import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@spc/schema";
import { verifyCriterion } from "./criteria.js";

// Oracle for specs/failure-classification.yaml: infrastructural
// failures record inconclusive under a strict contract - envelope-only
// classification, suite-did-not-run inconclusive, timeout precedence,
// assertion-failure negative fixture, signal as context only.
const root = mkdtempSync(path.join(tmpdir(), "spc-fc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function script(name: string, body: string): string {
  writeFileSync(path.join(root, name), body, "utf8");
  return `node ${name}`;
}

async function run(command: string, timeoutMs?: number) {
  const criterion = {
    id: "FCF-001-A",
    type: "command",
    command,
    discriminating: true,
    ...(timeoutMs ? { timeoutMs } : {}),
  } as never;
  const property = {
    id: "FCF-001",
    statement: "Gate.",
    priority: "must",
    acceptance: [criterion],
  } as never;
  const result = await verifyCriterion(criterion, property, {
    runId: "fc-test",
    cwd: root,
    repositoryRevision: "0".repeat(40),
    config: DEFAULT_CONFIG,
    provider: null,
  });
  return { outcome: result.evidence.outcome, payload: result.evidence.payload as Record<string, unknown> };
}

describe("failure classification (failure-classification)", () => {
  it("an infra-envelope runner crash is inconclusive with environment-death shape (FC-001)", async () => {
    const cmd = script(
      "crash-runner.cjs",
      'console.error("Error: Vitest worker process exited unexpectedly during test run"); process.exit(1);\n',
    );
    const r = await run(cmd);
    expect(r.outcome).toBe("inconclusive");
    expect(r.payload.failureShape).toBe("environment-death");
  });

  it("a suite that fails to LOAD stays red-capable: contradicts with its shape (FC-002)", async () => {
    const cmd = script("no-tests.cjs", 'console.log("Tests  no tests"); process.exit(1);\n');
    const r = await run(cmd);
    // Deliberate semantics: the shape is the visibility mark; the
    // redness establishes the flip for module-import oracles whose
    // implementation does not exist at base.
    expect(r.outcome).toBe("contradicts");
    expect(r.payload.failureShape).toBe("suite-did-not-run");
  });

  it("a timeout stays contradicted and takes precedence (FC-003)", async () => {
    writeFileSync(path.join(root, "hang.cjs"), "setTimeout(() => {}, 10000);\n", "utf8");
    const r = await run("node hang.cjs", 1000);
    expect(r.payload.timedOut).toBe(true);
    expect(r.outcome).toBe("contradicts");
  });

  it("a genuine assertion failure stays contradicted - the negative fixture (FC-003)", async () => {
    const cmd = script(
      "assert-fail.cjs",
      'console.error("AssertionError: expected 1 to be 2"); process.exit(1);\n',
    );
    const r = await run(cmd);
    expect(r.outcome).toBe("contradicts");
    expect(r.payload.failureShape).toBeUndefined();
  });

  it("a child termination signal is recorded as context, never a classifier (FC-003)", async () => {
    const cmd = script("self-kill.cjs", "process.kill(process.pid, 'SIGKILL');\n");
    const r = await run(cmd);
    // Through shell:true the shell reports the child's death as exit
    // code 137; nothing here is infrastructural - a self-killed
    // command contradicts exactly like any other failure.
    expect(r.outcome).toBe("contradicts");
    expect(r.payload.failureShape).toBeUndefined();
  });
});
