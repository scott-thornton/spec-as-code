import path from "node:path";
import { runQuick } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveRepoRoot } from "../context.js";
import { printReport } from "./apply.js";

/**
 * `spc quick "<intent>" --verify "<command>"`: a compressed SPC
 * transaction. The intent becomes an ephemeral one-requirement spec; the
 * --verify command is the gate you authored; the planner derives the
 * task and its provisional write scope; execution runs through the same
 * machinery as any run (policy, diff scope, revert, evidence, chain,
 * attestation). Escalation is fail-closed: exceeding quick shape fails
 * and says to author a full spec - never silently absorbed.
 */
export async function runQuickCommand(
  intentParts: string[],
  options: { verify: string; cwd?: string },
): Promise<number> {
  const repoRoot = resolveRepoRoot(options.cwd);
  const config = loadRepoConfig(repoRoot);
  const intent = intentParts.join(" ");
  const result = await runQuick(
    { repoRoot, intent, verifyCommand: options.verify },
    {
      providerFactory: async () => createProvider(config, repoRoot),
      log: (line) => console.log(line),
    },
  );
  console.log(`Spec:      ${path.relative(process.cwd(), result.specPath)}`);
  printReport(result.report);
  if (result.exceededQuickShape) {
    console.log("This change exceeded quick shape (scope violation, failure or block).");
    console.log("Author a full spec for it; nothing was silently absorbed.");
    return 1;
  }
  return 0;
}
