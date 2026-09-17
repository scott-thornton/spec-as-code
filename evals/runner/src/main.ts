#!/usr/bin/env node
import { Command } from "commander";
import { isSpcError } from "@spc/core";
import { OpenAICompatProvider } from "@spc/llm-openai";
import type { LLMProvider } from "@spc/llm";
import { runBenchmark } from "./benchmark.js";
import type { LoadedTask } from "./task.js";

const program = new Command();

program
  .name("spc-evals")
  .description("spc benchmark harness: Markdown-plan baseline vs spc workflow")
  .version("0.1.0")
  .option("--tasks <dir>", "benchmark tasks root", "evals/tasks")
  .option("--out <dir>", "output directory", "evals/results/latest")
  .option("--category <name>", "run a single category")
  .option("--trials <n>", "trials per task", "1")
  .option("--provider <name>", "fake | openai (openai requires OPENAI_API_KEY and a configured model)", "fake")
  .option("--model <id>", "model id for --provider openai")
  .option("--keep-work", "keep working copies for debugging")
  .action(
    async (opts: {
      tasks: string;
      out: string;
      category?: string;
      trials: string;
      provider: string;
      model?: string;
      keepWork?: boolean;
    }) => {
      const providerFactory =
        opts.provider === "openai"
          ? (task: LoadedTask): Promise<{ control: LLMProvider; treatment: LLMProvider }> => {
              const model = opts.model ?? "gpt-4.1";
              const apiKey = process.env.OPENAI_API_KEY;
              if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
              const make = (): OpenAICompatProvider => new OpenAICompatProvider({ model, apiKey });
              void task;
              return Promise.resolve({ control: make(), treatment: make() });
            }
          : undefined;
      const result = await runBenchmark({
        tasksRoot: opts.tasks,
        outDir: opts.out,
        ...(opts.category ? { category: opts.category } : {}),
        trials: Number(opts.trials) || 1,
        ...(opts.keepWork ? { keepWork: true } : {}),
        ...(providerFactory ? { providerFactory } : {}),
      });
      const errors = result.results.filter((r) => r.error);
      console.log(`Benchmark complete: ${result.results.length} task result(s), ${errors.length} error(s).`);
      console.log(`Report: ${opts.out}/summary.md`);
      for (const e of errors) console.error(`  ${e.taskId} (trial ${e.trial}): ${e.error}`);
      process.exitCode = errors.length > 0 ? 1 : 0;
    },
  );

program.parseAsync(process.argv).catch((e: unknown) => {
  if (isSpcError(e)) {
    console.error(`error ${e.code}: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exitCode = 2;
});
