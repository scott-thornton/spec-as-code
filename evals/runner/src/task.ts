import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { SpcError } from "@spc/core";

/**
 * Benchmark task definition. The repository under `repo/` is what the agent
 * sees; `grading/` is withheld until metrics time (hidden grading tests).
 * Both arms receive the same task text and the same repository.
 */

export const verifyCheckSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("command"),
    command: z.string().min(1),
    expectExitCode: z.number().int().default(0),
  }),
  z.strictObject({
    type: z.literal("file"),
    path: z.string().min(1),
    contains: z.string().optional(),
    notContains: z.string().optional(),
  }),
]);

export const groundTruthSchema = z.strictObject({
  requirements: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        description: z.string().min(1),
        verify: verifyCheckSchema,
      }),
    )
    .min(1),
  regression: z
    .strictObject({
      command: z.string().min(1),
      expectBefore: z.enum(["pass", "fail"]).default("pass"),
    })
    .optional(),
  forbidden: z.array(z.string()).default([]),
});

export const benchmarkTaskSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  category: z.string().min(1),
  title: z.string().min(1),
  trap: z.string().optional(),
  description: z.string().min(1),
  baselineInstructions: z.string().optional(),
  spec: z.string().min(1),
  groundTruth: groundTruthSchema,
});

export type VerifyCheck = z.infer<typeof verifyCheckSchema>;
export type BenchmarkTask = z.infer<typeof benchmarkTaskSchema>;

export interface LoadedTask {
  task: BenchmarkTask;
  dir: string;
  repoDir: string;
  gradingDir: string | null;
  controlScriptPath: string;
  treatmentScriptPath: string;
}

/** Markdown-plan baseline instructions (§66 control arm), overridable per task. */
export const DEFAULT_BASELINE_INSTRUCTIONS = `You are working in a Git repository. Read the task below and the repository.

1. Write a plan in Markdown (PLAN.md) describing the files you will change and the order of work.
2. Implement the change described in the task.
3. Run the tests before declaring the task done.

Work autonomously; when you believe the task is complete, report which requirements you satisfied and that you are done.`;

export function loadTask(dir: string): LoadedTask {
  const taskFile = path.join(dir, "task.yaml");
  if (!existsSync(taskFile)) throw new SpcError("EVAL_TASK_INVALID", `missing task.yaml in ${dir}`);
  let data: unknown;
  try {
    data = parseYaml(readFileSync(taskFile, "utf8"));
  } catch (e) {
    throw new SpcError("EVAL_TASK_INVALID", `task.yaml in ${dir} is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = benchmarkTaskSchema.safeParse(data);
  if (!parsed.success) {
    throw new SpcError(
      "EVAL_TASK_INVALID",
      `task.yaml in ${dir} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const repoDir = path.join(dir, "repo");
  if (!existsSync(repoDir)) throw new SpcError("EVAL_TASK_INVALID", `missing repo/ in ${dir}`);
  const gradingDir = path.join(dir, "grading");
  const controlScriptPath = path.join(dir, "control-script.yaml");
  const treatmentScriptPath = path.join(dir, "treatment-script.yaml");
  if (!existsSync(controlScriptPath)) throw new SpcError("EVAL_TASK_INVALID", `missing control-script.yaml in ${dir}`);
  if (!existsSync(treatmentScriptPath)) throw new SpcError("EVAL_TASK_INVALID", `missing treatment-script.yaml in ${dir}`);
  return {
    task: parsed.data,
    dir,
    repoDir,
    gradingDir: existsSync(gradingDir) ? gradingDir : null,
    controlScriptPath,
    treatmentScriptPath,
  };
}

export function listTasks(tasksRoot: string, filterCategory?: string): LoadedTask[] {
  if (!existsSync(tasksRoot)) throw new SpcError("EVAL_TASK_INVALID", `tasks directory not found: ${tasksRoot}`);
  const out: LoadedTask[] = [];
  for (const category of readdirSync(tasksRoot).sort()) {
    const categoryDir = path.join(tasksRoot, category);
    if (category.startsWith("_") || category.startsWith(".")) continue;
    if (filterCategory && category !== filterCategory) continue;
    for (const entry of readdirSync(categoryDir).sort()) {
      const dir = path.join(categoryDir, entry);
      if (!existsSync(path.join(dir, "task.yaml"))) continue;
      out.push(loadTask(dir));
    }
  }
  return out;
}
