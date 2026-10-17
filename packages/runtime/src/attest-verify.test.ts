import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileSpecSource } from "@spc/core";
import { commitAll, gitOk } from "@spc/repo";
import { cancelRun } from "./cancel.js";
import { createVerifyRun } from "./queries.js";
import { replayRun } from "./replay.js";
import { loadConfig } from "./run.js";
import { spcPaths } from "./paths.js";
import { EventStore } from "./events.js";
import { initialState } from "./state.js";

const root = mkdtempSync(path.join(tmpdir(), "spc-attestv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: attest-v
  title: Attested verify
goal: The module exists.
requirements:
  - id: FEAT-A
    statement: The module exists.
    priority: must
    acceptance:
      - id: FEAT-A-A
        type: file
        path: src/mod.cjs
        assert:
          contains: "ok"
`;
const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;

function setupRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  gitOk(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".spc/runs/\n.spc/plans/\n");
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, "src", "mod.cjs"), 'module.exports = "ok";\n');
  commitAll(repo, "init");
  return repo;
}

describe("attestation for verify and cancelled runs", () => {
  it("a standalone verify run writes a prefix attestation that replays verified", async () => {
    const repo = setupRepo("verify");
    const report = await createVerifyRun({
      repoRoot: repo,
      specIr: ir,
      config: loadConfig(path.join(repo, ".spc", "config.yaml")),
      provider: null,
    });
    const paths = spcPaths(repo);
    const attestationFile = path.join(paths.runDir(report.runId), "attestation.json");
    expect(existsSync(attestationFile)).toBe(true);
    const attestation = JSON.parse(readFileSync(attestationFile, "utf8")) as { status: string; eventCount: number };
    expect(attestation.status).toBe("succeeded");

    const events = readFileSync(paths.eventsFile(report.runId), "utf8");
    expect(events).toContain("RUN_ATTESTED");
    const replay = replayRun(paths.runsDir, report.runId, null);
    expect(replay.ok).toBe(true);
    expect(replay.attestation).toBe("verified");
    expect(replay.chainStatus).toBe("chained");
  }, 120_000);

  it("cancelling an interrupted run attests its prefix", () => {
    const repo = setupRepo("cancel");
    const paths = spcPaths(repo);
    // Hand-craft the on-disk state of an interrupted running apply run.
    const runId = "run-interrupted";
    mkdirSync(paths.runDir(runId), { recursive: true });
    const meta = { runId, kind: "apply", specId: "attest-v", specDigest: ir.digest, createdAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(paths.metadataFile(runId), JSON.stringify(meta), "utf8");
    const events = new EventStore(paths.eventsFile(runId), runId, () => "2026-01-01T00:00:00.000Z");
    events.append("RUN_CREATED", { runId });
    const state = { ...initialState(meta, null), status: "running" };
    writeFileSync(paths.stateFile(runId), JSON.stringify(state), "utf8");

    const cancelled = cancelRun(repo, runId);
    expect(cancelled.status).toBe("cancelled");
    const attestationFile = path.join(paths.runDir(runId), "attestation.json");
    expect(existsSync(attestationFile)).toBe(true);
    const attestation = JSON.parse(readFileSync(attestationFile, "utf8")) as { status: string };
    expect(attestation.status).toBe("cancelled");
    const ev = readFileSync(paths.eventsFile(runId), "utf8");
    expect(ev).toContain("RUN_ATTESTED");
  }, 120_000);
});
