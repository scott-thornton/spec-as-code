import { resolveRepoRoot } from "../context.js";
import { runRecovery } from "@spc/runtime";

/** `spc apply recover` - the AO-005 recovery command. */
export function runRecoveryCommand(cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const result = runRecovery(repoRoot);
  switch (result.status) {
    case "recovered":
      console.log(`Recovered: ${result.detail}`);
      return 0;
    case "no-block":
      console.log(`No recovery needed: ${result.detail}`);
      return 0;
    case "lock-held":
      console.log(`Cannot recover: ${result.detail}`);
      return 1;
    case "incomplete":
      console.log(`Recovery incomplete: ${result.detail}`);
      console.log(`The safety block remains. Resolve the issue and retry: spc apply recover`);
      return 1;
    default:
      console.log(`Unknown recovery status: ${result.status}`);
      return 1;
  }
}