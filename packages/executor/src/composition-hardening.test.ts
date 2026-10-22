import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LLMProvider } from "@spc/llm";
import { compileSpecFile, observeRepository } from "@spc/repo";
import { executeTask } from "./execute.js";
import { EXECUTOR_SYSTEM } from "./prompts.js";

// Oracle for specs/composition-hardening.yaml (CH-005): write-target files
// get an honest excerpt budget (24KB) while read targets stay at 6KB, and
// the executor contract says excerpts include prior tasks' applied changes
// so sequential edits chain patch ops instead of resending whole files.
const root = mkdtempSync(path.join(tmpdir(), "spc-ch-exec-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ch-exec-fixture
  title: fixture
goal: fixture
requirements:
  - id: CHE-001
    statement: The gate passes.
    priority: must
    acceptance:
      - id: CHE-001-A
        type: command
        command: node gates.cjs
        discriminating: true
`;

mkdirSync(path.join(root, "specs"), { recursive: true });
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, "data"), { recursive: true });
writeFileSync(path.join(root, "specs", "ch-exec-fixture.yaml"), SPEC, "utf8");
// 10KB files whose tail markers sit far beyond the old 6KB window: the
// write-target excerpt must reach its marker, the read-target must not.
writeFileSync(path.join(root, "src", "big.ts"), "export const head = 1;\n" + "x".repeat(10 * 1024) + "\n// WRITE-TAIL-MARK\n", "utf8");
writeFileSync(path.join(root, "data", "big-read.txt"), "y".repeat(10 * 1024) + "\n// READ-TAIL-MARK\n", "utf8");
// observeRepository reads HEAD, so the fixture needs a real commit.
for (const args of [
  ["init", "-q", "-b", "main"],
  ["config", "user.email", "test@example.com"],
  ["config", "user.name", "test"],
  ["add", "."],
  ["commit", "-q", "-m", "base"],
]) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

describe("write-target excerpts get an honest budget (CH-005)", () => {
  it("write-target excerpt reaches beyond 6KB; read-target stays capped; contract names chaining", async () => {
    const compiled = compileSpecFile(path.join(root, "specs", "ch-exec-fixture.yaml"));
    if (!compiled.ok || !compiled.ir) throw new Error("fixture spec does not compile");

    let prompt = "";
    const provider = {
      name: "fake",
      model: "fake",
      generateStructured: async (args: { prompt: string }) => {
        prompt = args.prompt;
        return {
          value: {
            status: "completed",
            summary: "s",
            changes: [],
            commands: [],
            observations: [],
            evidenceCandidates: [],
            followups: [],
          },
          usage: {},
        };
      },
    } as unknown as LLMProvider;

    const outcome = await executeTask(
      {
        task: {
          id: "T001",
          title: "t",
          kind: "modify",
          intent: "i",
          targets: { read: ["data/**"], write: ["src/**"] },
        } as never,
        specIr: compiled.ir,
        snapshot: observeRepository(root, null) as never,
        worktreeRoot: root,
        attempt: 1,
        priorResults: [],
        observations: [],
      },
      { provider, onUsage: () => {} },
    );
    expect(outcome.status).toBe("completed");

    const payload = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
      repositoryExcerpts: { path: string; content: string }[];
    };
    const writeExcerpt = payload.repositoryExcerpts.find((e) => e.path === "src/big.ts");
    const readExcerpt = payload.repositoryExcerpts.find((e) => e.path === "data/big-read.txt");
    expect(writeExcerpt).toBeDefined();
    expect(readExcerpt).toBeDefined();
    expect(writeExcerpt!.content).toContain("WRITE-TAIL-MARK");
    expect(readExcerpt!.content).not.toContain("READ-TAIL-MARK");
    expect(readExcerpt!.content.length).toBeLessThanOrEqual(6144 + 64);

    // The contract tells executors what the code guarantees: excerpts are
    // current at dispatch, so chains anchor on them.
    expect(EXECUTOR_SYSTEM).toContain("prior tasks");
  });
});
