import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@spc/schema";
import { verifyCriterion } from "./criteria.js";

// Oracle for specs/port-contention-envelope.yaml PCE-001 (red,
// committed pre-run): a suite-spawned server that cannot bind
// (EADDRINUSE - dev-server contention under parallel execution) is
// environment death, not an assertion red. slerp's letter: "the verify
// tool doesn't distinguish 'the code is broken' from 'the port was
// busy'." Today the listen error contradicts.
const root = mkdtempSync(path.join(tmpdir(), "spc-pce-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(command: string) {
  const criterion = {
    id: "PCEF-001-A",
    type: "command",
    command,
    discriminating: true,
  } as never;
  const property = {
    id: "PCEF-001",
    statement: "Gate.",
    priority: "must",
    acceptance: [criterion],
  } as never;
  const result = await verifyCriterion(criterion, property, {
    runId: "pce-test",
    cwd: root,
    repositoryRevision: "0".repeat(40),
    config: DEFAULT_CONFIG,
    provider: null,
  });
  return { outcome: result.evidence.outcome, payload: result.evidence.payload as Record<string, unknown> };
}

describe("port-contention envelope (port-contention-envelope)", () => {
  it("a genuine failed bind (EADDRINUSE) is inconclusive environment-death: hold a port, then let the suite's server attempt it", { timeout: 30_000 }, async () => {
    writeFileSync(
      path.join(root, "busy-server.cjs"),
      "const n = require('net');\nconst s = n.createServer();\ns.on('error', (e) => { console.error(e.stack || String(e)); process.exit(1); });\ns.listen(47321, () => process.exit(0));\n",
      "utf8",
    );
    // Self-contained race: the same process holds the port, then a
    // second server attempts it - Node's genuine EADDRINUSE listen
    // error (measured: 0.058s, real stack output).
    const r = await run(`node -e "const n=require('net');const h=n.createServer();h.listen(47321,()=>{const s=n.createServer();s.on('error',e=>{console.error(e.stack||String(e));process.exit(1);});s.listen(47321,()=>process.exit(0));});setTimeout(()=>{},2000);"`);
    expect(r.payload["exitCode"]).not.toBe(0);
    expect(r.outcome).toBe("inconclusive");
    expect(r.payload["failureShape"]).toBe("environment-death");
  });

  it("strictness control: an assertion failure mentioning a port in prose stays contradicted", async () => {
    writeFileSync(
      path.join(root, "prose-port.cjs"),
      'console.error("AssertionError: expected port 3000 to be open"); process.exit(1);\n',
      "utf8",
    );
    const r = await run("node prose-port.cjs");
    expect(r.outcome).toBe("contradicts");
  });
});
