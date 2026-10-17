import { evaluateCommandPolicy, explainClassification } from "@spc/executor";
import { DEFAULT_CONFIG, type CommandsConfig } from "@spc/schema";
import { loadRepoConfig, resolveRepoRoot } from "../context.js";

/**
 * `spc policy explain <command>`: show how a command would be classified
 * and which policy applies, with the matching pattern. Classification is
 * deterministic pattern work over the command string - this makes it
 * inspectable before it is consequential.
 */
export function runPolicyExplain(commandParts: string[], cwd?: string): number {
  const command = commandParts.join(" ");
  let config: CommandsConfig;
  let configSource: string;
  try {
    config = loadRepoConfig(resolveRepoRoot(cwd)).commands;
    configSource = ".spc/config.yaml";
  } catch {
    config = DEFAULT_CONFIG.commands;
    configSource = "defaults (not inside a repository)";
  }
  const { category, matchedBy } = explainClassification(command);
  const decision = evaluateCommandPolicy(command, config);
  console.log(`command:       ${command}`);
  console.log(`classified as: ${category}`);
  console.log(`matched by:    ${matchedBy ?? "(no pattern matched; fell through to unknown)"}`);
  console.log(`effective:     ${decision.policy} (commands.${category}, from ${configSource})`);
  console.log(`runs:          ${decision.allowed ? "yes, without asking" : decision.policy === "approval" ? "only after human approval of this exact command" : "never"}`);
  if (category === "unknown") {
    console.log("\nnote: unknown-class commands default to allow; classification is a");
    console.log("guardrail against accidental high-risk operations, not adversarial");
    console.log("construction (see docs/threat-model.md).");
  }
  return 0;
}
