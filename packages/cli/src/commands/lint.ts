import { readFileSync } from "node:fs";
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

        // Unprotected oracle: the command executes a test path the
        // graded tasks may rewrite. A perfectly written test is not an
        // independent oracle if the agent it grades can rewrite it.
        const testPathMatch = command.match(/[\w./-]*(?:__tests__|tests\/|\.test\.|\.spec\.)[\w./-]*/);
        if (testPathMatch) {
          const referenced = testPathMatch[0].replace(/^\.?\//, "");
          // Commands inside a filtered package reference paths relative
          // to the package root while protectedPaths are repo-relative;
          // cover either form before warning.
          const covered =
            globMatchAny(config.verification.protectedPaths, referenced) ||
            globMatchAny(config.verification.protectedPaths, `packages/*/${referenced}`);
          if (!covered) {
            warnings.push({
              rule: "LINT-UNPROTECTED-ORACLE",
              target: criterion.id,
              message: `executes "${referenced}" but it is not under verification.protectedPaths - the tasks this criterion grades can rewrite the suite that grades them`,
            });
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
  try {
    for (const { criterion } of discriminating) {
      const run = await runCommand(criterion.command, {
        cwd: worktree,
        timeoutMs: criterion.timeoutMs ?? config.execution.commandTimeoutMs,
        maxOutputBytes: config.execution.maxOutputBytes,
        commandsConfig: config.commands,
      });
      if (!run.allowed) {
        console.log(`LINT-NO-RED-CAPABILITY ${criterion.id}: not-safely-executable (${run.deniedReason ?? "denied by command policy"}) - distinct from pass and fail`);
        continue;
      }
      if (run.timedOut) {
        console.log(`LINT-NO-RED-CAPABILITY ${criterion.id}: not-safely-executable (timed out) - distinct from pass and fail`);
        continue;
      }
      if (run.exitCode === 0) {
        console.log(`LINT-NO-RED-CAPABILITY ${criterion.id}: discriminating criterion passes at baseline: it cannot establish red evidence - either it cannot detect the change, or it is a regression invariant mislabeled as discriminating (drop the flag)`);
      }
      // exitCode !== 0: fails at baseline - healthy, no warning.
    }
  } finally {
    try {
      gitOk(repoRoot, ["worktree", "remove", "--force", worktree]);
    } catch {
      // best effort
    }
  }
  return 0;
}
