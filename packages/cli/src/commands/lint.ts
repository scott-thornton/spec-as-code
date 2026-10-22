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

/**
 * Provenance registry (the ratchet's lineage record): every active rule
 * carries its motivating finding, BOTH fixtures (negative: catches the
 * original defect; positive: permits acceptable criteria), the human
 * approver, and optional supersession. Superseded rules stay, marked,
 * and never fire - the ratchet is not a one-way accumulation of
 * increasingly restrictive mistakes.
 */
export interface LintRuleProvenance {
  id: string;
  motivation: string;
  negativeFixture: string;
  positiveFixture: string;
  approvedBy: string;
  supersededBy?: string;
}

export const LINT_RULES: LintRuleProvenance[] = [
  {
    id: "LINT-DECORATION",
    motivation: "A criterion whose command trivially succeeds cannot fail, so it tests nothing; the field's first broken oracle included exactly such a tautology.",
    negativeFixture: "A command criterion running bare 'true' warns LINT-DECORATION.",
    positiveFixture: "A command criterion running a real check (vitest, node --test, grep) does not warn.",
    approvedBy: "scott",
  },
  {
    id: "LINT-BARE-IDENTIFIER",
    motivation: "Bare-identifier greps match fixtures, generated code and docs that merely mention the thing; slerp's merged specs carried 'localStorage' and 'csrf' as full-criterion greps.",
    negativeFixture: "A file criterion contains:'faviconUrl' (single token, no structure) warns.",
    positiveFixture: "An access expression like 'images.faviconUrl' or a structural assertion does not warn.",
    approvedBy: "scott",
  },
  {
    id: "LINT-UNPROTECTED-ORACLE",
    motivation: "A test RUNNER executing a suite the graded tasks may rewrite is not an independent oracle; slerp's original config gap let tasks author their own guard test. Runner-gated after the first corpus run fired on git-diff exclusion strings.",
    negativeFixture: "npx vitest run on a path not under protectedPaths warns.",
    positiveFixture: "Test paths inside git-diff exclusion regexes, and directory references already covered by protectedPaths globs, do NOT warn.",
    approvedBy: "scott",
  },
  {
    id: "LINT-UNPROTECTED-ORACLE-V1",
    motivation: "The original narrow form: substring-matched test paths anywhere in a command. Fired on git-diff exclusion regexes and a protected directory - 0-for-3 true positives on the first real corpus.",
    negativeFixture: "Any command merely containing a .spec.ts substring warned, executed or not.",
    positiveFixture: "N/A - the rule could not distinguish execution from mention; superseded for this reason.",
    approvedBy: "scott",
    supersededBy: "LINT-UNPROTECTED-ORACLE",
  },
  {
    id: "LINT-DUPLICATE-COMMAND",
    motivation: "Identical commands with differing expected exit codes pay full tool boot per differing expectation on every sweep.",
    negativeFixture: "Two criteria naming the same command with expect exitCode 0 and 1 warn.",
    positiveFixture: "The same command with the same expectation (the sweep's internal cache handles it) does not warn.",
    approvedBy: "scott",
  },
  {
    id: "LINT-EMPTY-OUT-OF-SCOPE",
    motivation: "outOfScope is the promise about what will not change; unwritten, plans wander without a boundary to respect.",
    negativeFixture: "A spec declaring no outOfScope entries warns.",
    positiveFixture: "Any declared exclusion silences the rule.",
    approvedBy: "scott",
  },
  {
    id: "LINT-QUOTED-BACKSLASH",
    motivation: "YAML double-quoted scalars reinterpret backslash escapes, so the criterion that runs is not the criterion written (CHK3555: \\/ became /, failed at base and result, validate passed it).",
    negativeFixture: "A double-quoted command scalar containing a backslash warns LINT-QUOTED-BACKSLASH.",
    positiveFixture: "Single-quoted or block scalars, and double-quoted commands without backslashes, do not warn.",
    approvedBy: "scott",
  },
  {
    id: "LINT-PLAN-SHARED-ORACLE",
    motivation: "Sequential tasks writing the same paths whose satisfied properties share a discriminating command criterion are unverifiable in every intermediate step - the shared oracle stays red until the last task lands, so mid-sequence preflights whisper (the preflight-gates run shipped corrupted source through exactly this shape).",
    negativeFixture: "packages/cli/src/composition-hardening.test.ts: the sliced plan (T001/T002 sequential on src/** satisfying CHF-001/CHF-002 sharing one command) prints PLAN-SHARED-ORACLE at spc plan validate.",
    positiveFixture: "packages/cli/src/composition-hardening.test.ts: the merged single task prints no finding.",
    approvedBy: "human (composition-hardening spec, 2026-10-22)",
  },
];


const DECORATION_COMMANDS = new Set(["true", ":", "pwd", "exit 0", "exit(0)"]);

/**
 * Static craftsmanship rules over a compiled spec - the author-spec
 * skill's prose, mechanized. Pure: reads the IR and config, executes
 * nothing, writes nothing. Warnings never gate.
 */
export function lintSpec(ir: SpecIR, config: Config, source?: string): LintWarning[] {
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

  // Double-quoted command scalars silently reinterpret backslash
  // escapes (field case: \/ became /), so the criterion that runs is
  // not the criterion the author wrote. Source-level rule.
  if (source !== undefined && /command:\s*"[^"\n]*\\/.test(source)) {
    warnings.push({
      rule: "LINT-QUOTED-BACKSLASH",
      target: ir.spec.metadata.id,
      message: "double-quoted command scalar contains a backslash - YAML reinterprets escape sequences, so the command that runs may not be the command written; use a single-quoted or block scalar (spec validate --show-commands shows the parsed result)",
    });
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
/**
 * `spc spec lint --provenance`: print the rule registry - lineage,
 * fixtures, approver, supersession - without linting anything.
 */
export function runSpecLintProvenance(): number {
  for (const rule of LINT_RULES) {
    const status = rule.supersededBy ? `SUPERSEDED by ${rule.supersededBy}` : "active";
    console.log(`${rule.id}  [${status}]  approved by ${rule.approvedBy}`);
    console.log(`  motivation: ${rule.motivation}`);
    console.log(`  negative fixture: ${rule.negativeFixture}`);
    console.log(`  positive fixture: ${rule.positiveFixture}`);
    console.log("");
  }
  return 0;
}

export async function runSpecLint(specFile: string | undefined, cwd?: string, provenance = false): Promise<number> {
  if (provenance) {
    return runSpecLintProvenance();
  }
  if (!specFile) {
    console.error("spec lint requires a file (or --provenance for the registry)");
    return 2;
  }
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadRepoConfig(repoRoot);
  const compiled = compileSpecFile(path.resolve(repoRoot, specFile));
  if (!compiled.ok || !compiled.ir) {
    console.error(`spec does not compile; run spc spec validate first`);
    return 1;
  }
  const ir = compiled.ir;
  printWarnings(lintSpec(ir, config, readFileSync(path.resolve(repoRoot, specFile), "utf8")));

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
  const failsAtBaseline: string[] = [];
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
      else failsAtBaseline.push(criterion.id);
      // A spec whose work is DONE has every right to pass at baseline:
      // red-capability is an authoring-time question. It only becomes a
      // finding when sibling criteria still fail - proof the work is
      // incomplete - making a passing criterion genuinely suspect.
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
  if (passesAtBaseline.length > 0 && failsAtBaseline.length > 0) {
    console.log(
      `LINT-NO-RED-CAPABILITY ${ir.spec.metadata.id}: ${passesAtBaseline.length} discriminating ${passesAtBaseline.length > 1 ? "criteria pass" : "criterion passes"} at baseline (${passesAtBaseline.join(", ")}) while ${failsAtBaseline.length} still ${failsAtBaseline.length > 1 ? "fail" : "fails"} - the work is incomplete, so a criterion passing where it should be red cannot establish flip evidence. Either it cannot detect the change, or it is a regression invariant mislabeled as discriminating (drop the ${passesAtBaseline.length > 1 ? "flags" : "flag"})`,
    );
  }
  // All green: the spec's work is in the tree. An old spec is an old
  // spec - authoring-time questions are not retroactive findings.
  return 0;
}
