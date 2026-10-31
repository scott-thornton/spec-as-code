import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SpcError, type SpecCompileResult } from "@spc/core";
import { compileSpecFile as compileSpecGraphFs } from "@spc/repo";
import type { Config, SpecIR } from "@spc/schema";
import type { LLMProvider } from "@spc/llm";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { OpenAICompatProvider } from "@spc/llm-openai";
import { AnthropicCompatProvider } from "@spc/llm-anthropic";
import { HarnessProvider, HarnessStore } from "@spc/llm-harness";
import { findRepoRoot } from "@spc/repo";
import { loadConfig } from "@spc/runtime";

/**
 * CLI composition root: resolves the repository, loads configuration and
 * wires the provider. The fake provider is a configuration-selectable
 * backend (deterministic demos/tests); core packages never reference it.
 */

export function resolveRepoRoot(explicit?: string): string {
  const start = explicit ?? process.cwd();
  const root = findRepoRoot(start);
  if (!root) {
    throw new SpcError("NOT_A_GIT_REPO", `${start} is not inside a Git repository; spc operates on Git repositories`);
  }
  return root;
}

export function loadRepoConfig(repoRoot: string): Config {
  return loadConfig(path.join(repoRoot, ".spc", "config.yaml"));
}

export function compileSpecFile(file: string): SpecCompileResult {
  if (!existsSync(file)) {
    throw new SpcError("SPEC_FILE_NOT_FOUND", `spec file not found: ${file}`);
  }
  return compileSpecGraphFs(file);
}

/** Resolve which spec to use: explicit file, or the single spec in specs/. */
/**
 * Every spec under specs/ when no explicit file is given - multi-spec
 * repositories are the normal state (this repo has several). An explicit
 * file selects exactly one; zero specs is still an error.
 */
export function resolveAllSpecs(specsDir: string, explicitFile?: string): { file: string; ir: SpecIR }[] {
  if (explicitFile) return [resolveSpec(specsDir, explicitFile)];
  if (!existsSync(specsDir)) {
    throw new SpcError("SPEC_FILE_NOT_FOUND", `no specs directory at ${specsDir}; run spc init or pass a spec file`);
  }
  const entries = readdirSync(specsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  if (entries.length === 0) {
    throw new SpcError("SPEC_FILE_NOT_FOUND", `no spec files found in ${specsDir}`);
  }
  return entries.map((f) => {
    const file = path.join(specsDir, f);
    const result = compileSpecFile(file);
    if (!result.ok || !result.ir) {
      throw new SpcError("SPEC_INVALID", `${file}: ${result.diagnostics.map((d) => d.message).join("\n")}`);
    }
    return { file, ir: result.ir };
  });
}

export function resolveSpec(specsDir: string, explicitFile?: string): { file: string; ir: SpecIR } {
  if (explicitFile) {
    const result = compileSpecFile(explicitFile);
    if (!result.ok || !result.ir) {
      throw new SpcError("SPEC_INVALID", result.diagnostics.map((d) => d.message).join("\n"));
    }
    return { file: explicitFile, ir: result.ir };
  }
  if (!existsSync(specsDir)) {
    throw new SpcError("SPEC_FILE_NOT_FOUND", `no specs directory at ${specsDir}; run spc init or pass a spec file`);
  }
  const entries = readdirSync(specsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (entries.length === 0) {
    throw new SpcError("SPEC_FILE_NOT_FOUND", `no spec files found in ${specsDir}`);
  }
  if (entries.length > 1) {
    throw new SpcError("SPEC_FILE_NOT_FOUND", `multiple specs in ${entries.join(", ")}; pass an explicit file`);
  }
  const file = path.join(specsDir, entries[0]!);
  const result = compileSpecFile(file);
  if (!result.ok || !result.ir) {
    throw new SpcError("SPEC_INVALID", result.diagnostics.map((d) => d.message).join("\n"));
  }
  return { file, ir: result.ir };
}

export async function createProvider(config: Config, repoRoot: string): Promise<LLMProvider | null> {
  switch (config.provider.name) {
    case "none":
      return null;
    case "fake": {
      const script = config.provider.script;
      if (!script) {
        throw new SpcError("PROVIDER_CONFIG", `provider "fake" requires provider.script (path to a scripted YAML file) in .spc/config.yaml`);
      }
      const scriptPath = path.resolve(repoRoot, script);
      if (!existsSync(scriptPath)) {
        throw new SpcError("PROVIDER_CONFIG", `fake provider script not found: ${scriptPath}`);
      }
      return new FakeProvider(parseFakeScript(readFileSync(scriptPath, "utf8")));
    }
    case "openai": {
      const model = config.provider.model;
      if (!model) {
        throw new SpcError("PROVIDER_CONFIG", `provider "openai" requires provider.model in .spc/config.yaml`);
      }
      const envName = config.provider.apiKeyEnv ?? "OPENAI_API_KEY";
      const apiKey = process.env[envName];
      if (!apiKey) {
        throw new SpcError("PROVIDER_CONFIG", `environment variable ${envName} is not set; required by the openai provider`);
      }
      return new OpenAICompatProvider({
        model,
        apiKey,
        ...(config.provider.baseURL ? { baseURL: config.provider.baseURL } : {}),
        ...(config.provider.maxTokens !== undefined ? { maxTokens: config.provider.maxTokens } : {}),
        ...(config.provider.timeoutMs !== undefined ? { timeoutMs: config.provider.timeoutMs } : {}),
        ...(config.provider.reasoningEffort !== undefined ? { reasoningEffort: config.provider.reasoningEffort } : {}),
        ...(config.provider.tokenLimitField !== undefined ? { tokenLimitField: config.provider.tokenLimitField } : {}),
        ...(config.provider.sendTemperature !== undefined ? { sendTemperature: config.provider.sendTemperature } : {}),
        ...(config.provider.cacheControl !== undefined ? { cacheControl: config.provider.cacheControl } : {}),
      });
    }
    case "harness": {
      return new HarnessProvider(
        new HarnessStore(repoRoot),
        config.execution.harnessResponseTimeoutMs,
        undefined,
        undefined,
        config.execution.harnessTimeouts,
      );
    }
    case "anthropic": {
      const model = config.provider.model;
      if (!model) {
        throw new SpcError("PROVIDER_CONFIG", `provider "anthropic" requires provider.model in .spc/config.yaml`);
      }
      const envName = config.provider.apiKeyEnv ?? "ANTHROPIC_API_KEY";
      const apiKey = process.env[envName];
      if (!apiKey) {
        throw new SpcError("PROVIDER_CONFIG", `environment variable ${envName} is not set; required by the anthropic provider`);
      }
      return new AnthropicCompatProvider({
        model,
        apiKey,
        ...(config.provider.baseURL ? { baseURL: config.provider.baseURL } : {}),
        ...(config.provider.maxTokens !== undefined ? { maxTokens: config.provider.maxTokens } : {}),
        ...(config.provider.timeoutMs !== undefined ? { timeoutMs: config.provider.timeoutMs } : {}),
        ...(config.provider.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: config.provider.thinkingBudgetTokens } : {}),
        ...(config.provider.reasoningEffort !== undefined ? { reasoningEffort: config.provider.reasoningEffort } : {}),
        ...(config.provider.sendTemperature !== undefined ? { sendTemperature: config.provider.sendTemperature } : {}),
      });
    }
  }
}
