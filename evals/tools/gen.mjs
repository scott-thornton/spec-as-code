/**
 * Benchmark task generator. Authoring 30 tasks by hand as YAML would be
 * unmanageable; this generator holds the per-task data compactly and emits
 * the on-disk format the runner consumes. Committed for reproducibility:
 *   node evals/tools/gen.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as toYaml } from "yaml";
import { TASKS_PART_1 } from "./tasks-part1.mjs";
import { TASKS_PART_2 } from "./tasks-part2.mjs";

// ---------- emitter ----------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tasks");

function emit(t) {
  const dir = path.join(ROOT, t.category, t.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const taskYaml = {
    id: t.id,
    category: t.category,
    ...(t.trap ? { trap: t.trap } : {}),
    title: t.title,
    description: t.description,
    ...(t.baselineInstructions ? { baselineInstructions: t.baselineInstructions } : {}),
    spec: toYaml(t.spec),
    groundTruth: {
      requirements: t.groundTruth.requirements,
      ...(t.groundTruth.regression ? { regression: t.groundTruth.regression } : {}),
      ...(t.groundTruth.forbidden?.length ? { forbidden: t.groundTruth.forbidden } : { forbidden: [] }),
    },
  };
  writeFileSync(path.join(dir, "task.yaml"), toYaml(taskYaml));

  for (const [p, content] of Object.entries(t.repoFiles)) {
    const full = path.join(dir, "repo", p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const [p, content] of Object.entries(t.gradingFiles ?? {})) {
    const full = path.join(dir, "grading", p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  const controlScript = {
    planner: { value: { planMarkdown: t.control.planMarkdown } },
    executor: {
      implement: {
        summary: t.control.summary,
        changes: t.control.changes,
        claimedDone: t.control.claimedDone,
        ranTests: t.control.ranTests ?? false,
      },
    },
  };
  writeFileSync(path.join(dir, "control-script.yaml"), toYaml(controlScript));

  const treatmentScript = {
    planner: {
      value: {
        plan: { tasks: t.treatment.planTasks },
        observations: [],
        assumptions: t.treatment.assumptions ?? [],
        followups: t.treatment.followups ?? [],
      },
    },
    ...(t.treatment.executor ? { executor: t.treatment.executor } : {}),
    ...(t.treatment.replanner ? { replanner: t.treatment.replanner } : {}),
  };
  writeFileSync(path.join(dir, "treatment-script.yaml"), toYaml(treatmentScript));
}

const all = [...TASKS_PART_1, ...TASKS_PART_2];
for (const t of all) emit(t);
console.log(`generated ${all.length} tasks under ${ROOT}`);
