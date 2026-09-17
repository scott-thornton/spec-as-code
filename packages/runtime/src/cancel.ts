import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import type { RunState } from "@spc/schema";
import { spcPaths } from "./paths.js";
import { EventStore } from "./events.js";
import { persistState } from "./state.js";

/**
 * Mark a run cancelled. Honest scope: this is for runs left `running` by an
 * interrupted process (crash, Ctrl-C) - there is no daemon, so an actively
 * executing CLI process cannot be signalled mid-task. Cancelling makes the
 * terminal state truthful, unblocks preflight's shadow-run detection, and
 * makes `--resume` refuse.
 */
export function cancelRun(repoRoot: string, runId: string, now: () => string = () => new Date().toISOString()): RunState {
  const paths = spcPaths(repoRoot);
  const stateFile = paths.stateFile(runId);
  if (!existsSync(paths.runDir(runId)) || !existsSync(stateFile)) {
    throw new SpcError("RUN_NOT_FOUND", `run ${runId} not found under ${paths.runsDir}`);
  }
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
  if (state.status !== "running") {
    throw new SpcError("RUN_ALREADY_FINISHED", `run ${runId} already finished with status ${state.status}; only running runs can be cancelled`);
  }
  const events = new EventStore(paths.eventsFile(runId), runId, now);
  events.load();
  const updated: RunState = { ...state, status: "cancelled", updatedAt: now() };
  events.append("RUN_COMPLETED", { status: "cancelled", reason: "cancelled by human", tasks: Object.fromEntries(Object.entries(updated.tasks).map(([id, t]) => [id, t.status])) });
  persistState(stateFile, updated);
  return updated;
}
