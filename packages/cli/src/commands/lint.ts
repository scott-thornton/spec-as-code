import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config, SpecIR } from "@spc/schema";
import { compileSpecFile } from "@spc/repo";
import { gitOk } from "@spc/repo";
import { runCommand } from "@spc/executor";
import { globMatchAny } from "@spc/core";
import { loadRepoConfig, resolveRepoRoot } from "../context.js";

export interface LintWarning {
  rule: string;
  target: string;
  message: string;
}

const DECORATION_COMMANDS = new Set(["true", ":", "pwd", "exit 0", "exit(0)"]);

/**
 * Static craftsmanship rules over a compiled spec - the author-spec
 * skill's prose, mechanized. Pure: reads the IR and config, executes
 * nothing, writes nothing. Warnings never gate.
 */
export function lintSpec(ir: SpecIR, config: Config): LintWarning[] {
  const warnings: LintWarning[] = [];
  const commandUses = new Map<string, { criterion: string; expect?: number }[]>();

  for (const property of ir.properties) {
    for (const criterion of property.acceptance) {
      if (criterion.type === "command" && criterion.command !== undefined) {
        const command = criterion.command;
        const first = command.trim().split(/\s+/)[0] ?? "";
        if (DECORATION_COMMANDS.has(command.trim()) || DECORATION_COMMANDS.has(first)) {
          warnings.push({
            rule: "LINT-DECORATION",
            target: criterion.id,
            message: "command cannot fail (trivially green) - a criterion that cannot fail is decoration; strengthen or delete it",
          });
        }
        const uses = commandUses.get(command) ?? [];
        uses.push({ criterion: criterion.id, expect: criterion.expect?.exitCode });
        commandUses.set(command, uses);

        // Unprotected oracle: a test RUNNER executing a suite the graded
        // tasks may rewrite. A perfectly written test is not an
        // independent oracle if the agent it grades can rewrite it.
        // Runner-gated: paths that merely APPEAR in a command (git diff
        // exclusion regexes, grep patterns) are not executed, and firing
        // on them was 3 false alarms on the first real corpus.
        const RUNNER = /\b(vitest|jest|mocha|node\s+--test|pytest|\.\/node_modules\/\.bin\/\w+)\b/;
        if (RUNNER.test(command)) {
          const testPathMatch = command.match(/[\w./-]*(?:__tests__|tests\/|\.test\.|\.spec\.)[\w./-]*/);
          if (testPathMatch) {
            const referenced = testPathMatch[0].replace(/^\.?\//, "");
            const patterns = config.verification.protectedPaths;
            // Coverage accepts repo-relative and package-relative forms,
            // and directory references (vitest run <dir>) as well as the
            // files inside them.
            const covered =
              globMatchAny(patterns, referenced) ||
              globMatchAny(patterns, `${referenced}/**`) ||
              globMatchAny(patterns, `packages/*/${referenced}`) ||
              globMatchAny(patterns, `packages/*/${referenced}/**`);
            if (!covered) {
              warnings.push({
                rule: "LINT-UNPROTECTED-ORACLE",
                target: criterion.id,
                message: `executes "${referenced}" but it is not under verification.protectedPaths - the tasks this criterion grades can rewrite the suite that grades them`,
              });
            }
          }
        }
      }
      if (criterion.type === "file" && criterion.assert) {
        for (const [kind, value] of Object.entries(criterion.assert)) {
          if ((kind === "contains" || kind === "notContains") && typeof value === "string") {
            // Bare identifier: a single token with no structure - will
            // match fixtures, generated code and docs that merely
            // mention the thing. Grep the access expression instead.
            if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
              warnings.push({
                rule: "LINT-BARE-IDENTIFIER",
                target: criterion.id,
                message: `"${value}" is a bare identifier - it will match fixtures and docs that mention the thing; grep the access expression (object.value) instead`,
              });
            }
          }
        }
      }
    }
  }

  for (const [command, uses] of commandUses) {
    const expects = new Set(uses.map((u) => u.expect));
    if (uses.length > 1 && expects.size > 1) {
      warnings.push({
        rule: "LINT-DUPLICATE-COMMAND",
        target: uses.map((u) => u.criterion).join(", "),
        message: `"${command.slice(0, 60)}" runs with differing expected exit codes - identical commands pay full boot per differing expectation every sweep`,
      });
    }
  }

  if ((ir.spec.outOfScope ?? []).length === 0) {
    warnings.push({
      rule: "LINT-EMPTY-OUT-OF-SCOPE",
      target: ir.spec.metadata.id,
      message: "spec declares no outOfScope - that is a promise left unwritten; plans wander without it",
    });
  }

  return warnings;
}

function printWarnings(warnings: LintWarning[]): void {
  for (const w of warnings) {
    console.log(`${w.rule} ${w.target}: ${w.message}`);
  }
}

/**
 * `spc spec lint <file>`: static rules plus, in the explicitly-invoked
 * lint only, the dynamic red-capability check - each discriminating
 * command criterion executed ONCE in a disposable worktree under the
 * command policy. Three outcome classes; not-safely-executable is
 * never reported as pass or fail. The working tree is never touched.
 */
export async function runSpecLint(specFile: string, cwd?: string): Promise<number> {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadRepoConfig(repoRoot);
  const compiled = compileSpecFile(path.resolve(repoRoot, specFile));
  if (!compiled.ok || !compiled.ir) {
    console.error(`spec does not compile; run spc spec validate first`);
    return 1;
  }
  const ir = compiled.ir;
  printWarnings(lintSpec(ir, config));

  const discriminating = ir.properties.flatMap((p) =>
    p.acceptance
      .filter((c) => c.type === "command" && c.discriminating === true && c.command !== undefined)
      .map((c) => ({ propertyId: p.id, criterion: c as { id: string; command: string; timeoutMs?: number } })),
  );
  if (discriminating.length === 0) return 0;

  const worktree = path.join(repoRoot, ".spc", "worktrees", `lint-${ir.spec.metadata.id}`);
  try {
    gitOk(repoRoot, ["worktree", "remove", "--force", worktree]);
  } catch {
    // absent - fine
  }
  gitOk(repoRoot, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const passesAtBaseline: string[] = [];
  const notExecutable: string[] = [];
  const hasDeps = existsSync(path.join(worktree, "node_modules"));
  try {
    for (const { criterion } of discriminating) {
      // A bare worktree has no installed dependencies: npx/pnpm/npm
      // resolution there is unreliable (cache luck can exit 0 without
      // running the project's tests - a false pass-at-baseline). Such
      // commands are honestly unexecutable here, never green.
      if (/\b(npx|pnpm|yarn|npm)\b/.test(criterion.command) && !hasDeps) {
        notExecutable.push(criterion.id);
        continue;
      }
      // Lint runs on its own tight budget: the run-timeout can be ten
      // minutes, which is right for apply and absurd for a lint pass.
      // Capped, and a breach classifies as not-safely-executable.
      const lintTimeoutMs = Math.min(
        criterion.timeoutMs ?? config.execution.commandTimeoutMs,
        60_000,
      );
      const run = await runCommand(criterion.command, {
        cwd: worktree,
        timeoutMs: lintTimeoutMs,
        maxOutputBytes: config.execution.maxOutputBytes,
        commandsConfig: config.commands,
      });
      if (!run.allowed) {
        notExecutable.push(`${criterion.id} (${run.deniedReason ?? "denied by command policy"})`);
        continue;
      }
      if (run.timedOut) {
        notExecutable.push(`${criterion.id} (timed out)`);
        continue;
      }
      if (run.exitCode === 0) passesAtBaseline.push(criterion.id);
      // exitCode !== 0: fails at baseline - healthy, no warning.
    }
  } finally {
    try {
      gitOk(repoRoot, ["worktree", "remove", "--force", worktree]);
    } catch {
      // best effort
    }
  }
  if (notExecutable.length > 0) {
    console.log(
      `LINT-NOT-EXECUTABLE ${ir.spec.metadata.id}: ${notExecutable.length} criteria not-safely-executable by lint (distinct from pass and fail): ${notExecutable.join(", ")}`,
    );
  }
  if (passesAtBaseline.length > 0) {
    console.log(
      `LINT-NO-RED-CAPABILITY ${ir.spec.metadata.id}: ${passesAtBaseline.length} discriminating ${passesAtBaseline.length > 1 ? "criteria pass" : "criterion passes"} at baseline (${passesAtBaseline.join(", ")}) - the work appears already in the tree; a criterion that passes where it should be red cannot establish flip evidence. Either it cannot detect the change, or these are regression invariants mislabeled as discriminating (drop the ${passesAtBaseline.length > 1 ? "flags" : "flag"})`,
    );
  }
  return 0;
}
