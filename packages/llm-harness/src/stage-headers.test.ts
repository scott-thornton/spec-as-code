import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessProvider } from "./harness.js";
import { HarnessStore } from "./store.js";

// Oracle for specs/pipeline-signposting.yaml (SG-001): every dispatched
// request states its stage in the embedded instructions - the one
// surface a queue agent is guaranteed to read. A post-compression
// agent reads its position and its local rules on first contact.
const root = mkdtempSync(path.join(tmpdir(), "spc-stageheaders-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let t = Date.now();
const now = (): number => t;

/** Dispatch as a role and capture the request's prompt (instructions
 *  included). Real-spaced ticks, fake clock advancing per tick. */
async function dispatchAndCapture(role: string, key: string): Promise<string> {
  const store = new HarnessStore(root, now);
  const id = `${role}-${key}-1`;
  let prompt: string | undefined;
  const sleep = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    t += 1000;
    if (prompt === undefined) {
      const request = JSON.parse(readFileSync(path.join(root, ".spc", "harness", "pending", `${id}.json`), "utf8")) as { prompt: string };
      prompt = request.prompt;
      store.answer(id, { ok: true });
    }
  };
  const provider = new HarnessProvider(store, 30 * 60_000, sleep, now);
  await provider.generateStructured({
    role: role as never,
    key,
    requestId: `r-${key}`,
    system: "s",
    prompt: "ORIGINAL TASK PROMPT",
    schema: z.object({ ok: z.boolean() }),
    schemaName: "TestOut",
  });
  return prompt!;
}

describe("stage headers (SG-001)", () => {
  it("executor requests carry the answer-discipline stage, the sequence, and the rehearse pointer", { timeout: 60_000 }, async () => {
    const prompt = await dispatchAndCapture("executor", "SH1");
    expect(prompt).toContain("stage: answer discipline");
    expect(prompt).toContain("spc agent validate");
    expect(prompt).toContain("spc agent dry-run");
    expect(prompt).toContain("save-candidate");
    expect(prompt).toContain("spc use-skill rehearse");
    expect(prompt).toContain("ORIGINAL TASK PROMPT");
  });

  it("planner requests carry the plan stage", { timeout: 60_000 }, async () => {
    const prompt = await dispatchAndCapture("planner", "SH2");
    expect(prompt).toContain("stage: plan");
  });

  it("replanner requests carry the replan stage and point at lastError", { timeout: 60_000 }, async () => {
    const prompt = await dispatchAndCapture("replanner", "SH3");
    expect(prompt).toContain("stage: replan");
    expect(prompt).toContain("lastError");
  });

  it("verifier requests carry the verify stage and evidence discipline", { timeout: 60_000 }, async () => {
    const prompt = await dispatchAndCapture("verifier", "SH4");
    expect(prompt).toContain("stage: verify");
    expect(prompt).toMatch(/evidence/);
  });
});
