import { rmSync } from "node:fs";
import path from "node:path";
import { globMatchAny, isSafeRelativePath, normalizeRelPath } from "@spc/core";
import type { CommandsConfig } from "@spc/schema";
import { contentDelta, contentSnapshot, git, gitOk } from "@spc/repo";
import { runCommand, type CommandRunResult } from "./commands.js";

export const TOUCH_SET_VIOLATION = "TOUCH_SET_VIOLATION";
export const COMMAND_DENIED = "COMMAND_DENIED";
export const COMMAND_FAILED = "COMMAND_FAILED";

export interface DeclaredCommand {
  command: string;
  touchSet?: string[];
}

export interface DeclaredCommandsOpts {
  commandsConfig: CommandsConfig;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandRunSummary {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type DeclaredCommandsOutcome =
  | { ok: true; results: CommandRunSummary[]; untouched: string[] }
  | { ok: false; code: string; message: string };

// The runtime's own bookkeeping in in-place runs; never a command's write.
const SPC_STATE_PREFIXES = [
  ".spc/runs/",
  ".spc/plans/",
  ".spc/worktrees/",
  ".spc/cache/",
  ".spc/harness/",
];

/**
 * Revert paths a command had no right to touch so the violation STICKS:
 * without this, a retry inherits the already-written file, its delta comes
 * back empty, and the retry completes with the forbidden change in the
 * tree. Tracked paths restore from the index; untracked files are removed.
 */
export function revertPaths(worktreeRoot: string, paths: readonly string[]): void {
  for (const p of paths) {
    // Unsafe relative paths escape the worktree; never act on them with rm.
    if (!isSafeRelativePath(p)) continue;
    const tracked = git(worktreeRoot, ["ls-files", "--error-unmatch", p]).ok;
    if (tracked) {
      gitOk(worktreeRoot, ["checkout", "--", p]);
    } else {
      rmSync(path.join(worktreeRoot, p), { force: true });
    }
  }
}

function changedPathsSince(before: ReturnType<typeof contentSnapshot>, worktreeRoot: string): string[] {
  const delta = contentDelta(before, contentSnapshot(worktreeRoot));
  for (const p of [...delta.keys()]) {
    if (SPC_STATE_PREFIXES.some((prefix) => p.startsWith(prefix))) delta.delete(p);
  }
  return [...delta.keys()];
}

/**
 * Run declared commands sequentially under the policy engine with the
 * declaration contract: the observed content delta of each command must
 * fall inside its declared touch-set. A command that writes anything
 * without declaring a touch-set refuses fail-closed. Violating writes are
 * reverted before the refusal so a retry cannot launder them. Denied
 * categories never execute. Declared-but-unchanged entries are reported,
 * not punished: they are the cheap "the model was wrong about reality"
 * signal.
 */
export async function runDeclaredCommands(
  worktreeRoot: string,
  commands: readonly DeclaredCommand[],
  opts: DeclaredCommandsOpts,
): Promise<DeclaredCommandsOutcome> {
  const results: CommandRunSummary[] = [];
  const untouched: string[] = [];

  for (const declared of commands) {
    const before = contentSnapshot(worktreeRoot);
    const run: CommandRunResult = await runCommand(declared.command, {
      cwd: worktreeRoot,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      commandsConfig: opts.commandsConfig,
    });

    if (!run.allowed) {
      return {
        ok: false,
        code: COMMAND_DENIED,
        message: `${COMMAND_DENIED}: "${declared.command}" was not executed - ${run.deniedReason ?? "denied by command policy"}`,
      };
    }

    const changed = changedPathsSince(before, worktreeRoot);
    if (changed.length > 0) {
      const declaredSet = declared.touchSet ?? [];
      const offending = changed.filter((p) => !globMatchAny(declaredSet, normalizeRelPath(p)));
      if (declaredSet.length === 0) {
        revertPaths(worktreeRoot, offending);
        return {
          ok: false,
          code: TOUCH_SET_VIOLATION,
          message: `${TOUCH_SET_VIOLATION}: "${declared.command}" wrote [${offending.join(", ")}] without declaring a touch-set; writes reverted. Declare the paths this command will touch, or keep it read-only`,
        };
      }
      if (offending.length > 0) {
        revertPaths(worktreeRoot, offending);
        return {
          ok: false,
          code: TOUCH_SET_VIOLATION,
          message: `${TOUCH_SET_VIOLATION}: "${declared.command}" wrote outside its declared touch-set: ${offending.join(", ")}; writes reverted`,
        };
      }
    }

    if (declared.touchSet) {
      for (const pattern of declared.touchSet) {
        if (!changed.some((p) => globMatchAny([pattern], normalizeRelPath(p)))) untouched.push(pattern);
      }
    }

    if (run.exitCode !== 0 || run.timedOut) {
      return {
        ok: false,
        code: COMMAND_FAILED,
        message: `${COMMAND_FAILED}: "${declared.command}" exited ${run.exitCode ?? "without an exit code"}${run.timedOut ? " (timed out)" : ""}${run.stderr ? `: ${run.stderr.slice(0, 500)}` : ""}`,
      };
    }

    results.push({
      command: declared.command,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      timedOut: run.timedOut,
    });
  }

  return { ok: true, results, untouched };
}
