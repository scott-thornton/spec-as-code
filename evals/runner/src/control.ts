import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LLMProvider } from "@spc/llm";
import { commitAll, currentRevision } from "@spc/repo";
import type { LoadedTask } from "./task.js";

/**
 * Control arm (§66): the same model receives the task, the repository, and
 * Markdown planning instructions. One invocation writes PLAN.md; a second
 * implements. There is no write scope, no independent verification and no
 * evidence — completion is whatever the agent claims.
 */

export const baselinePlanSchema = z.strictObject({
  planMarkdown: z.string().min(1),
});

export const baselineImplementSchema = z.strictObject({
  summary: z.string().min(1),
  changes: z
    .array(
      z.discriminatedUnion("op", [
        z.strictObject({ op: z.literal("create"), path: z.string(), content: z.string() }),
        z.strictObject({ op: z.literal("update"), path: z.string(), content: z.string() }),
        z.strictObject({ op: z.literal("delete"), path: z.string() }),
      ]),
    )
    .default([]),
  claimedDone: z.boolean().default(false),
  ranTests: z.boolean().default(false),
});

export type BaselineImplement = z.infer<typeof baselineImplementSchema>;

export interface ControlResult {
  baseRevision: string;
  resultRevision: string | null;
  claimedDone: boolean;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
}

export async function runControlArm(options: {
  task: LoadedTask;
  repoDir: string;
  provider: LLMProvider;
  baselineInstructions: string;
  repoFiles?: { path: string; content: string }[];
}): Promise<ControlResult> {
  const { provider, repoDir } = options;
  const baseRevision = currentRevision(repoDir);
  const system = options.baselineInstructions;
  const taskPayload = { title: options.task.task.title, description: options.task.task.description };
  const repoDump = options.repoFiles ?? [];
  let tokensIn = 0;
  let tokensOut = 0;

  const plan = await provider.generateStructured({
    role: "planner",
    key: "plan",
    requestId: crypto.randomUUID(),
    system,
    prompt: JSON.stringify({ task: taskPayload, repository: repoDump }, null, 2),
    schema: baselinePlanSchema,
    schemaName: "BaselinePlan",
  });
  tokensIn += plan.usage.inputTokens ?? 0;
  tokensOut += plan.usage.outputTokens ?? 0;
  // PLAN.md is the control arm's plan artifact.
  writeFileSync(path.join(repoDir, "PLAN.md"), plan.value.planMarkdown, "utf8");

  const implement = await provider.generateStructured({
    role: "executor",
    key: "implement",
    requestId: crypto.randomUUID(),
    system,
    prompt: JSON.stringify({ task: taskPayload, plan: plan.value.planMarkdown, repository: repoDump }, null, 2),
    schema: baselineImplementSchema,
    schemaName: "BaselineImplement",
  });
  tokensIn += implement.usage.inputTokens ?? 0;
  tokensOut += implement.usage.outputTokens ?? 0;

  for (const change of implement.value.changes) {
    const full = path.join(repoDir, change.path);
    if (change.op === "delete") {
      rmSync(full, { force: true });
    } else {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, change.content, "utf8");
    }
  }
  const resultRevision = commitAll(repoDir, `baseline implementation: ${options.task.task.id}`);
  return {
    baseRevision,
    resultRevision,
    claimedDone: implement.value.claimedDone,
    modelCalls: 2,
    tokensIn,
    tokensOut,
  };
}
