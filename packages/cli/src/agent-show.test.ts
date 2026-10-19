import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-agentshow-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const REQUEST = {
  id: "executor-T001@1-1",
  role: "executor",
  key: "T001@1",
  schemaName: "ExecutorResult",
  jsonSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
  system: "THE SYSTEM CONTRACT",
  prompt: 'Execute the following task. Respond with JSON only.\n\n{"task":{"id":"T001","title":"wire it"},"repositoryExcerpts":[{"path":"src/a.ts"}]}',
  createdAt: "2026-10-19T00:00:00.000Z",
};

mkdirSync(path.join(root, ".spc", "harness", "pending"), { recursive: true });
writeFileSync(
  path.join(root, ".spc", "harness", "pending", `${REQUEST.id}.json`),
  JSON.stringify(REQUEST, null, 2),
  "utf8",
);

function spc(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}

describe("spc agent show decomposition", () => {
  it("--part system prints only the system prompt", () => {
    const r = spc(["agent", "show", REQUEST.id, "--part", "system"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("THE SYSTEM CONTRACT");
  });

  it("--part prompt prints only the prompt", () => {
    const r = spc(["agent", "show", REQUEST.id, "--part", "prompt"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(REQUEST.prompt.trim());
  });

  it("--part schema prints the JSON Schema alone", () => {
    const r = spc(["agent", "show", REQUEST.id, "--part", "schema"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(REQUEST.jsonSchema);
  });

  it("--part payload prints the prompt's embedded JSON object, not the banner text", () => {
    const r = spc(["agent", "show", REQUEST.id, "--part", "payload"]);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.task.id).toBe("T001");
    expect(payload.repositoryExcerpts[0].path).toBe("src/a.ts");
  });

  it("--json prints the whole request as one machine-readable object", () => {
    const r = spc(["agent", "show", REQUEST.id, "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(REQUEST);
  });

  it("default output is headed sections, not one raw JSON blob", () => {
    const r = spc(["agent", "show", REQUEST.id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SYSTEM/i);
    expect(r.stdout).toMatch(/PROMPT/i);
    expect(r.stdout).toMatch(/SCHEMA/i);
  });
});
