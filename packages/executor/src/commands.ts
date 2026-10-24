import { spawn, spawnSync } from "node:child_process";
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

/**
 * Classification with its evidence: the matched category and the exact
 * pattern that matched (or the unknown fallback). Powers `spc policy
 * explain` - deterministic policy should be inspectable, not just
 * enforced.
 */
export function explainClassification(command: string): { category: CommandCategory; matchedBy: string | null } {
  const trimmed = command.trim();
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(trimmed)) return { category, matchedBy: pattern.source };
  }
  return { category: "unknown", matchedBy: null };
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
  /** Termination signal of the spawned shell, when the platform
   *  reports one (our own timeout kill surfaces as SIGKILL). Diagnostic
   *  context ONLY - a signal says HOW a process died, never WHY, and
   *  classifies nothing by itself (review ruling, 2026-10-24). */
  signal: string | null;
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
    signal: null,
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
    // Own a process group on POSIX so a timeout kills the whole tree,
    // not just the shell: with shell:true, SIGKILL to the shell leaves
    // grandchildren running with the pipes - free to keep mutating the
    // worktree after the task's delta check (external review #3).
    const ownsGroup = process.platform !== "win32";
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(ownsGroup ? { detached: true } : {}),
    });
    const killTree = (): void => {
      if (child.pid === undefined) return;
      if (ownsGroup) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // group already gone; fall through to the child
        }
      } else {
        // Windows: taskkill /T walks the spawn tree; /F forces.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    const cap = opts.maxOutputBytes * 8; // hard collection cap; persisted output is truncated further
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString("utf8");
    });
    // Resolve on exit, not close: with shell: true a SIGKILL to the shell
    // leaves the spawned command holding the stdio pipe open on Linux, so
    // "close" would not fire until the command itself finishes.
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const endTime = new Date().toISOString();
      const env = opts.env ?? process.env;
      const cleanOut = redactSecrets(truncate(stdout, opts.maxOutputBytes), env);
      const cleanErr = redactSecrets(truncate(stderr, opts.maxOutputBytes), env);
      resolve({
        ...base,
        exitCode: code,
        signal: signal ?? null,
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
    child.on("error", (e) => {
      clearTimeout(timer);
      const endTime = new Date().toISOString();
      const env = opts.env ?? process.env;
      resolve({
        ...base,
        exitCode: null,
        signal: null,
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
  });
}

function truncate(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}
