import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessProvider } from "./harness.js";
import { HarnessStore } from "./store.js";

// Oracle for specs/prompt-stability.yaml (PST-002): the volatile
// request id moves to the tail of the harness instructions, so the
// shared prefix across requests of the same role covers the ENTIRE
// constant text. Today the id sits mid-block and cuts the answering
// agent's stable prefix at the instructions' first line mentioning it.
const root = mkdtempSync(path.join(tmpdir(), "spc-pst-harness-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let t = Date.now();

async function capturePrompt(key: string): Promise<string> {
  const store = new HarnessStore(root, () => t);
  const id = `executor-${key}-1`;
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
  const provider = new HarnessProvider(store, 30 * 60_000, sleep, () => t);
  await provider.generateStructured({
    role: "executor", key, requestId: `r-${key}`, system: "s", prompt: "TASK BODY",
    schema: z.object({ ok: z.boolean() }), schemaName: "TestOut",
  });
  return prompt!;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

describe("harness instruction stability (PST-002)", () => {
  it("two requests of the same role share their prefix through the entire constant instruction text", { timeout: 60_000 }, async () => {
    const a = await capturePrompt("KA");
    const b = await capturePrompt("KB");
    const shared = a.slice(0, commonPrefixLength(a, b));
    // The constant block runs through the run-continues sentence - the
    // id must not appear before it. Today the prefix cuts at the first
    // embedded id, well before this sentence.
    expect(shared).toContain("run continues automatically");
    // And the ids themselves sit in the diverging tail, present in each
    // prompt after the constant text.
    const tailA = a.slice(commonPrefixLength(a, b));
    expect(tailA).toContain("executor-KA-1");
  });
});
