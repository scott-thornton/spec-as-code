import { afterAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { commitAll, gitOk } from "@spc/repo";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const MONOREPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "spc-harness-e2e-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function spcSync(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run spc asynchronously (it blocks waiting for harness answers). */
function spcAsync(cwd: string, args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
  return child;
}

function harnessDir(repo: string): string {
  return path.join(repo, ".spc", "harness");
}

/** Wait until a pending harness request exists; returns its parsed JSON. */
async function waitForRequest(repo: string, timeoutMs = 30_000): Promise<{ id: string; value: Record<string, unknown> }> {
  const started = Date.now();
  for (;;) {
    const dir = path.join(harnessDir(repo), "pending");
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      if (files.length > 0) {
        try {
          const parsed = JSON.parse(readFileSync(path.join(dir, files[0]!), "utf8")) as Record<string, unknown>;
          if (typeof parsed.id === "string" && typeof parsed.prompt === "string" && parsed.prompt.length > 0) {
            return { id: parsed.id, value: parsed };
          }
        } catch {
          // partially written; retry next tick
        }
      }
    }
    if (Date.now() - started > timeoutMs) throw new Error("no harness request appeared");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("harness provider end to end", () => {
  const repo = path.join(tmpRoot, "greeting");

  it("full loop: agent-as-model through request/response files", async () => {
    cpSync(path.join(MONOREPO, "fixtures", "simple-node-service"), repo, { recursive: true });
    gitOk(repo, ["init", "-b", "main"]);
    // Reconfigure to the harness provider (the fixture ships the fake).
    writeFileSync(
      path.join(repo, ".spc", "config.yaml"),
      ["version: 1", "provider:", "  name: harness", "execution:", "  harnessResponseTimeoutMs: 60000"].join("\n"),
    );
    mkdirSync(path.join(repo, ".spc", "harness"), { recursive: true });
    commitAll(repo, "fixture");

    // Deterministic half first: spec validate needs no model at all.
    const validate = spcSync(repo, ["spec", "validate", "specs/greeting.yaml"]);
    expect(validate.status).toBe(0);
    expect(validate.stdout).toContain("Digest:");

    // Planning: spc plan blocks; the harness request appears; we answer it
    // with the same plan the fixture's scripted planner would produce.
    const fake = readFileSync(path.join(MONOREPO, "fixtures", "simple-node-service", ".spc", "fake-script.yaml"), "utf8");
    const plannedTasks = parseFakePlannerTasks(fake);
    const planChild = spcAsync(repo, ["plan", "specs/greeting.yaml"]);
    const request = await waitForRequest(repo);
    expect(request.value.role).toBe("planner");
    expect(JSON.stringify(request.value.jsonSchema)).toContain("tasks");
    // The request embeds the repository context for the answering agent.
    expect(request.value.prompt).toContain("greeting");

    const answerFile = path.join(tmpRoot, "planner-answer.json");
    writeFileSync(answerFile, JSON.stringify(plannedTasks));
    const respond = spcSync(repo, ["agent", "respond", request.id, "--file", answerFile, "--by", "zcode-agent"]);
    if (respond.status !== 0) console.error("PLANNER RESPOND ERR:", respond.stderr.slice(0, 500), respond.stdout.slice(0, 300));
    expect(respond.status).toBe(0);

    let planOut = "";
    planChild.stdout?.on("data", (d) => { planOut += d; });
    planChild.stderr?.on("data", (d) => { planOut += d; });
    const planExit = await new Promise<number>((resolve) => planChild.on("exit", (c) => resolve(c ?? -1)));
    if (planExit !== 0) console.error("PLAN OUTPUT:", planOut.slice(0, 1500));
    expect(planExit).toBe(0);
    const plans = readdirSync(path.join(repo, ".spc", "plans")).filter((f) => f.endsWith(".json") && !f.endsWith(".approved.json"));
    expect(plans.length).toBe(1);

    // Apply: the only model call is the executor for T001; verification is
    // deterministic (command + file criteria).
    const fakeExecutor = parseFakeExecutor(fake, "T001");
    const applyChild = spcAsync(repo, ["apply"]);
    const execRequest = await waitForRequest(repo);
    expect(execRequest.value.role).toBe("executor");
    expect(String(execRequest.value.key)).toContain("T001");
    expect(String(execRequest.value.prompt)).toContain("src/greeting.mjs");

    const execAnswer = path.join(tmpRoot, "executor-answer.json");
    writeFileSync(execAnswer, JSON.stringify(fakeExecutor));
    const execRespond = spcSync(repo, ["agent", "respond", execRequest.id, "--file", execAnswer]);
    if (execRespond.status !== 0) console.error("EXEC RESPOND ERR:", execRespond.stderr.slice(0, 500));
    expect(execRespond.status).toBe(0);

    let applyOut = "";
    applyChild.stdout?.on("data", (d) => { applyOut += d; });
    applyChild.stderr?.on("data", (d) => { applyOut += d; });
    const applyExit = await new Promise<number>((resolve) => applyChild.on("exit", (c) => resolve(c ?? -1)));
    if (applyExit !== 0) console.error("APPLY OUTPUT:", applyOut.slice(0, 1800));
    expect(applyExit).toBe(0);

    // Machine-readable state for the harness to consume.
    const status = spcSync(repo, ["status", "--format", "json"]);
    expect(status.status).toBe(0);
    const parsed = JSON.parse(status.stdout) as { properties: { id: string; status: string }[] };
    expect(parsed.properties.find((p) => p.id === "GREETING-001")?.status).toBe("satisfied");

    // The answered request is kept as the record of who decided what.
    expect(readdirSync(path.join(harnessDir(repo), "answered")).length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it("agent list shows pending requests as json", () => {
    const repo2 = path.join(tmpRoot, "list-only");
    cpSync(path.join(MONOREPO, "fixtures", "simple-node-service"), repo2, { recursive: true });
    gitOk(repo2, ["init", "-b", "main"]);
    writeFileSync(
      path.join(repo2, ".spc", "config.yaml"),
      ["version: 1", "provider:", "  name: harness"].join("\n"),
    );
    commitAll(repo2, "fixture");
    const r = spcSync(repo2, ["agent", "list", "--format", "json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});

/** Extract the scripted planner value from the fixture's fake script YAML. */
function parseFakePlannerTasks(fake: string): unknown {
  const yaml = require("yaml") as typeof import("yaml");
  const parsed = yaml.parse(fake) as { planner?: { value?: { plan?: { tasks?: unknown } } } };
  const value = { plan: { tasks: parsed.planner?.value?.plan?.tasks ?? [] }, observations: [], assumptions: [], followups: [] };
  return value;
}

function parseFakeExecutor(fake: string, taskId: string): unknown {
  const yaml = require("yaml") as typeof import("yaml");
  const parsed = yaml.parse(fake) as { executor?: Record<string, unknown> };
  return parsed.executor?.[taskId] ?? { status: "completed", summary: "done", changes: [] };
}
