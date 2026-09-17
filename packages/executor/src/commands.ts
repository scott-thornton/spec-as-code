import { spawn } from "node:child_process";
import { digestOf } from "@spc/core";
import type { CommandsConfig, PolicyValue } from "@spc/schema";

/**
 * Command policy: categorize every command, decide allowability in code.
 * Prompting is never a security boundary. V0 has no interactive approval,
 * so "approval" categories are denied with an actionable reason.
 */

export type CommandCategory =
  | "inspect"
  | "build"
  | "test"
  | "lint"
  | "typecheck"
  | "packageInstall"
  | "network"
  | "publish"
  | "gitPush"
  | "deployment"
  | "migration"
  | "destructive"
  | "unknown";

const CATEGORY_PATTERNS: [CommandCategory, RegExp][] = [
  ["destructive", /(^|\s)(rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)|mkfs|dd\s+if=|git\s+(push\s+--force|reset\s+--hard|clean\s+-fd)|drop\s+(table|database)|shutdown|reboot)(\s|$)/i],
  ["gitPush", /^git\s+push(\s|$)/],
  ["publish", /(^|\s)(npm|pnpm|yarn|bun)\s+(publish|release)(\s|$)|(^|\s)(cargo\s+publish|twine\s+upload)(\s|$)/],
  ["deployment", /(^|\s)(kubectl|helm|terraform\s+apply|serverless\s+deploy|vercel\s+deploy|netlify\s+deploy)(\s|$)/],
  ["migration", /(^|\s)migrate(\s|$)|prisma\s+migrate|rails\s+db:migrate|typeorm\s+migration/],
  ["packageInstall", /^(npm|pnpm|yarn|bun)\s+(install|i|add|remove|rm|update|upgrade|ci)(\s|$)|^(pip|pip3)\s+install(\s|$)|^(cargo|go)\s+(add|get)(\s|$)/],
  ["network", /^(curl|wget|ssh|scp|rsync|ftp|telnet|nc|netcat)(\s|$)|https?:\/\//],
  ["test", /(^|\s)(node\s+--test|vitest|jest|mocha|pytest|go\s+test|cargo\s+test|ruby\s+-Itest)(\s|$)|^(npm|pnpm|yarn|bun)\s+(run\s+)?test(\s|$)|^(npm|pnpm|yarn|bun)\s+run\s+[\w:.:-]*test(\s|$)/],
  ["typecheck", /(^|\s)(tsc\s+--noEmit|pyright|mypy|flow)(\s|$)|^(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|tsc)(\s|$)/],
  ["build", /^(npm|pnpm|yarn|bun)\s+(run\s+)?build(\s|$)|^(make|cargo\s+build|go\s+build|gradle)(\s|$)/],
  ["lint", /(^|\s)(eslint|biome|ruff|flake8|rubocop|golangci-lint)(\s|$)|^(npm|pnpm|yarn|bun)\s+(run\s+)?lint(\s|$)/],
  ["inspect", /^(git|ls|cat|head|tail|grep|rg|find|fd|wc|stat|file|du|which|env|pwd)(\s|$)/],
];

export function classifyCommand(command: string): CommandCategory {
  const trimmed = command.trim();
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(trimmed)) return category;
  }
  return "unknown";
}

const POLICY_KEY: Partial<Record<CommandCategory, keyof CommandsConfig>> = {
  network: "network",
  packageInstall: "packageInstall",
  migration: "migration",
  deployment: "deployment",
  publish: "publish",
  gitPush: "gitPush",
  destructive: "destructive",
  unknown: "unknown",
};

export interface CommandDecision {
  category: CommandCategory;
  policy: PolicyValue;
  allowed: boolean;
  reason: string;
}

export function evaluateCommandPolicy(command: string, config: CommandsConfig): CommandDecision {
  const category = classifyCommand(command);
  const key = POLICY_KEY[category];
  if (key === undefined) {
    return { category, policy: "allow", allowed: true, reason: `${category} commands are allowed by default` };
  }
  const policy = config[key];
  if (policy === "allow") {
    return { category, policy, allowed: true, reason: `${category} commands are allowed by configuration` };
  }
  if (policy === "approval") {
    return {
      category,
      policy,
      allowed: false,
      reason: `${category} commands require approval; V0 has no interactive approval, configure "commands.${key}: allow" if this is intended`,
    };
  }
  return { category, policy, allowed: false, reason: `${category} commands are denied by configuration` };
}

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)/i;

/** Redact secret values from text before persistence. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    out = out.split(value).join(`<redacted:${name}>`);
  }
  return out;
}

export interface CommandRunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  commandsConfig: CommandsConfig;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutDigest: string;
  stderrDigest: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  timedOut: boolean;
  category: CommandCategory;
  policy: PolicyValue;
  allowed: boolean;
  deniedReason?: string;
}

/** Execute a shell command with policy, timeout, bounded redacted output. */
export function runCommand(command: string, opts: CommandRunOptions): Promise<CommandRunResult> {
  const decision = evaluateCommandPolicy(command, opts.commandsConfig);
  const startTime = new Date().toISOString();
  const start = Date.now();
  const base = {
    command,
    cwd: opts.cwd,
    startTime,
    category: decision.category,
    policy: decision.policy,
    allowed: decision.allowed,
  };
  if (!decision.allowed) {
    const endTime = new Date().toISOString();
    return Promise.resolve({
      ...base,
      exitCode: null,
      stdout: "",
      stderr: decision.reason,
      stdoutDigest: digestOf(""),
      stderrDigest: digestOf(decision.reason),
      startTime,
      endTime,
      durationMs: 0,
      timedOut: false,
      deniedReason: decision.reason,
    });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    const cap = opts.maxOutputBytes * 8; // hard collection cap; persisted output is truncated further
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      const endTime = new Date().toISOString();
      const env = opts.env ?? process.env;
      resolve({
        ...base,
        exitCode: null,
        stdout: redactSecrets(truncate(stdout, opts.maxOutputBytes), env),
        stderr: redactSecrets(e.message, env),
        stdoutDigest: digestOf(stdout),
        stderrDigest: digestOf(e.message),
        startTime,
        endTime,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const endTime = new Date().toISOString();
      const env = opts.env ?? process.env;
      const cleanOut = redactSecrets(truncate(stdout, opts.maxOutputBytes), env);
      const cleanErr = redactSecrets(truncate(stderr, opts.maxOutputBytes), env);
      resolve({
        ...base,
        exitCode: code,
        stdout: cleanOut,
        stderr: cleanErr,
        stdoutDigest: digestOf(stdout),
        stderrDigest: digestOf(stderr),
        startTime,
        endTime,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

function truncate(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}
