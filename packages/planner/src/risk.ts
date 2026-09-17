import { globMatchAny } from "@spc/core";
import type { Config, PlanAmendment, Task } from "@spc/schema";

/**
 * §31 amendment approval tiers, computed from the amendment's actual
 * operations instead of a single all-or-nothing flag:
 *
 * - low:  addDependency, addTask/replaceTask limited to inspect/test/verify
 *         kinds, or scope-narrowing changeTarget - validate and continue.
 * - medium: any other change that touches no high-risk write patterns -
 *         continue (the spec cannot change via amendment; "no public API
 *         change" is proxied by the high-risk pattern list below).
 * - high: any introduced task with risk "high", or whose write set touches
 *         high-risk paths (dependency manifests/lockfiles, migrations,
 *         deployment/workflow definitions) - require human approval.
 */

/** Paths whose modification is treated as a public-API/infra-scale change. */
export const DEFAULT_HIGH_RISK_PATTERNS: readonly string[] = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "**/migrations/**",
  "Dockerfile",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  ".github/workflows/**",
  "infra/**",
  "terraform/**",
  "k8s/**",
];

export type AmendmentRisk = "low" | "medium" | "high";

export interface AmendmentRiskAssessment {
  risk: AmendmentRisk;
  reasons: string[];
  highRiskPatterns: string[];
}

export function classifyAmendmentRisk(
  amendment: PlanAmendment,
  previousTasks: readonly Task[],
  config: Config,
): AmendmentRiskAssessment {
  const highRiskPatterns = [
    ...DEFAULT_HIGH_RISK_PATTERNS,
    ...extraPatterns(config),
  ];
  const reasons: string[] = [];
  const previousById = new Map(previousTasks.map((t) => [t.id, t]));

  const introducedTasks: Task[] = [];
  for (const op of amendment.operations) {
    if (op.op === "addTask" || op.op === "replaceTask") {
      introducedTasks.push(op.task);
    }
  }

  let high = false;
  for (const task of introducedTasks) {
    if (task.risk === "high") {
      high = true;
      reasons.push(`${task.id} declares risk "high"`);
      continue;
    }
    const writes = task.targets?.write ?? [];
    const hit = writes.find((w) => globMatchAny(highRiskPatterns, w));
    if (hit !== undefined) {
      high = true;
      reasons.push(`${task.id} writes high-risk path "${hit}"`);
    }
  }
  if (high) {
    return { risk: "high", reasons, highRiskPatterns };
  }

  // Medium: anything that changes planned behaviour beyond additions of
  // read-only or test-only tasks (removals/replacements/target changes).
  const structural = amendment.operations.some(
    (op) =>
      op.op === "removeTask" ||
      op.op === "replaceTask" ||
      op.op === "changeTarget" ||
      (op.op === "addTask" && !isReadOnlyTask(op.task)),
  );
  if (structural) {
    return { risk: "medium", reasons: ["amendment restructures planned work"], highRiskPatterns };
  }
  return { risk: "low", reasons: ["dependency-only or read-only additions"], highRiskPatterns };
}

function isReadOnlyTask(task: Task): boolean {
  const writes = task.targets?.write ?? [];
  return writes.length === 0;
}

function extraPatterns(config: Config): string[] {
  return config.execution.highRiskWritePatterns;
}
