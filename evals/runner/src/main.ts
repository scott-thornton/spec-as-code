#!/usr/bin/env node
import { Command } from "commander";
import { isSpcError } from "@spc/core";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LLMProvider } from "@spc/llm";
import { HarnessProvider, HarnessStore } from "@spc/llm-harness";
import { buildRealProviderPair, type ProviderProvenance } from "./providers.js";
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
  .option("--task <id>", "run a single task by id")
  .option("--trials <n>", "trials per task", "1")
  .option("--provider <name>", "fake | openai | anthropic | harness (external agent answers requests)", "fake")
  .option("--harness-dir <dir>", "root dir for harness provider request/response files", "evals/results/harness-reqs")
  .option("--model <id>", "model id for real providers")
  .option("--base-url <url>", "provider base URL (OpenAI- or Anthropic-compatible)")
  .option("--api-key-env <name>", "environment variable holding the API key", "OPENAI_API_KEY")
  .option("--timeout-ms <n>", "per-request timeout for real providers", "180000")
  .option("--thinking-budget-tokens <n>", "thinking budget for the anthropic dialect (the provider-budget field; the adapter validates)")
  .option("--reasoning-effort <level>", "reasoning effort label (dialect-specific; the adapters validate)")
  .option("--max-tokens <n>", "output token limit (the anthropic default of 16384 is preserved when omitted)")
  .option("--keep-work", "keep working copies for debugging")
  .action(
    async (opts: {
      tasks: string;
      out: string;
      category?: string;
      task?: string;
      trials: string;
      provider: string;
      model?: string;
      baseUrl?: string;
      apiKeyEnv: string;
      timeoutMs: string;
      thinkingBudgetTokens?: string;
      reasoningEffort?: string;
      maxTokens?: string;
      harnessDir?: string;
      keepWork?: boolean;
    }) => {
      let providerProvenance: ProviderProvenance | undefined;
      const providerFactory =
        opts.provider === "harness"
          ? (task: LoadedTask): Promise<{ control: LLMProvider; treatment: LLMProvider }> => {
              void task;
              // The model is an external agent answering requests in
              // <harnessDir>/.spc/harness (see the harness provider docs).
              // Both arms share one store; request ids are role-keyed.
              const dir = path.resolve(opts.harnessDir ?? "evals/results/harness-reqs");
              const provider = new HarnessProvider(new HarnessStore(dir), Number(opts.timeoutMs) || 600_000);
              return Promise.resolve({ control: provider, treatment: provider });
            }
          : opts.provider === "openai" || opts.provider === "anthropic"
            ? (task: LoadedTask): Promise<{ control: LLMProvider; treatment: LLMProvider }> => {
                void task;
                const apiKey = process.env[opts.apiKeyEnv];
                if (!apiKey) throw new Error(`${opts.apiKeyEnv} is not set`);
                const timeoutMs = Number(opts.timeoutMs) || 180_000;
                const dialect = opts.provider as "openai" | "anthropic";
                const pair = buildRealProviderPair({
                  provider: dialect,
                  apiKey,
                  timeoutMs,
                  ...(opts.model ? { model: opts.model } : {}),
                  ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
                  ...(opts.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: Number(opts.thinkingBudgetTokens) } : {}),
                  ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
                  ...(opts.maxTokens !== undefined ? { maxTokens: Number(opts.maxTokens) } : {}),
                });
                providerProvenance = pair.provenance;
                return Promise.resolve({ control: pair.control, treatment: pair.treatment });
              }
            : undefined;
      const result = await runBenchmark({
        tasksRoot: opts.tasks,
        outDir: opts.out,
        ...(opts.category ? { category: opts.category } : {}),
        ...(opts.task ? { taskFilter: opts.task } : {}),
        trials: Number(opts.trials) || 1,
        ...(opts.keepWork ? { keepWork: true } : {}),
        ...(providerFactory ? { providerFactory } : {}),
      });
      // Arm provenance: the effective provider options recorded into the
      // benchmark artifacts - a protocol can then be checked against what
      // actually ran (additive; existing consumers unaffected).
      if (providerProvenance) {
        mkdirSync(path.join(process.cwd(), opts.out), { recursive: true });
        writeFileSync(path.join(process.cwd(), opts.out, "provider.json"), JSON.stringify(providerProvenance, null, 2) + "\n", "utf8");
      }
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
