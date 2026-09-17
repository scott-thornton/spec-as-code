#!/usr/bin/env node
import { Command } from "commander";
import { isSpcError } from "@spc/core";
import { runInit } from "./commands/init.js";
import { runSpecShow, runSpecValidate } from "./commands/spec.js";
import { runPlan, runPlanApprove, runPlanShow, runPlanValidate } from "./commands/plan.js";
import { runApply } from "./commands/apply.js";
import { runVerify } from "./commands/verify.js";
import { runReconcile } from "./commands/reconcile.js";
import { runDiff, runStatus } from "./commands/status.js";
import { runFollowupResolve, runFollowups } from "./commands/followups.js";
import { runCancel, runPr, runShow } from "./commands/run.js";
import { runAgentList, runAgentRespond, runAgentShow } from "./commands/agent.js";

const program = new Command();

program
  .name("spc")
  .description("Spec-as-Code: declarative requirements, validated plans, evidence-backed satisfaction")
  .version("0.1.0");

program
  .command("init")
  .description("create specs/ and .spc/, write default config, report detected commands")
  .option("--cwd <dir>", "target directory", process.cwd())
  .action((opts: { cwd: string }) => {
    runInit(opts.cwd);
  });

const spec = program.command("spec").description("specification compilation");
spec
  .command("validate <file>")
  .description("validate a spec file and print its digest")
  .option("--format <format>", "text | json (machine-readable)", "text")
  .action((file: string, opts: { format: string }) => {
    process.exitCode = runSpecValidate(file, opts.format === "json" ? "json" : "text");
  });
spec
  .command("show <file>")
  .description("render a spec (generated view)")
  .option("--format <format>", "markdown | text", "markdown")
  .action((file: string, opts: { format: string }) => {
    const format = opts.format === "text" ? ("text" as const) : ("markdown" as const);
    process.exitCode = runSpecShow(file, format);
  });

const plan = program
  .command("plan")
  .description("planning (default: generate a plan for a spec file)")
  .argument("[specFile]", "spec file to plan")
  .action(async (specFile: string | undefined) => {
    if (!specFile) {
      program.help();
      return;
    }
    process.exitCode = await runPlan(specFile);
  });
plan
  .command("validate [file]")
  .description("validate a persisted plan against its spec")
  .action((file: string | undefined) => {
    process.exitCode = runPlanValidate(file);
  });
plan
  .command("show [file]")
  .description("render a plan")
  .option("--format <format>", "text | json (the plan document itself)", "text")
  .action((file: string | undefined, opts: { format: string }) => {
    process.exitCode = runPlanShow(file, opts.format === "json" ? "json" : "text");
  });
plan
  .command("approve <planId>")
  .description("approve a plan (for execution.requirePlanApproval)")
  .action((planId: string) => {
    process.exitCode = runPlanApprove(planId);
  });

program
  .command("apply [planFile]")
  .description("execute a plan in an isolated worktree, then verify")
  .option("--resume <runId>", "resume an interrupted run")
  .option("--allow-dirty", "skip the clean-worktree preflight")
  .option("--force", "proceed despite open blocking follow-ups")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action(
    async (
      planFile: string | undefined,
      opts: { resume?: string; allowDirty?: boolean; force?: boolean; cwd: string },
    ) => {
      process.exitCode = await runApply({
        planFile,
        resumeRunId: opts.resume,
        allowDirty: opts.allowDirty,
        force: opts.force,
        cwd: opts.cwd,
      });
    },
  );

program
  .command("verify [specFile]")
  .description("run acceptance criteria against the current working tree")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--format <format>", "text | github | json", "text")
  .action(async (specFile: string | undefined, opts: { cwd: string; format: string }) => {
    const vfmt = opts.format === "github" ? "github" : opts.format === "json" ? "json" : "text";
    process.exitCode = await runVerify(specFile, opts.cwd, vfmt);
  });

program
  .command("reconcile [specFile]")
  .description("verify desired state; when drifted, plan (and optionally apply) the next transition")
  .option("--apply", "execute the generated transition plan immediately")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action(async (specFile: string | undefined, opts: { apply?: boolean; cwd: string }) => {
    process.exitCode = await runReconcile(specFile, { apply: opts.apply, cwd: opts.cwd });
  });

program
  .command("status [specFile]")
  .description("requirement-oriented status from the latest run")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--format <format>", "text | json (machine-readable)", "text")
  .action((specFile: string | undefined, opts: { cwd: string; format: string }) => {
    process.exitCode = runStatus(specFile, opts.cwd, opts.format === "json" ? "json" : "text");
  });

program
  .command("diff [specFile]")
  .description("desired vs observed property states")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--format <format>", "text | json (machine-readable)", "text")
  .action((specFile: string | undefined, opts: { cwd: string; format: string }) => {
    process.exitCode = runDiff(specFile, opts.cwd, opts.format === "json" ? "json" : "text");
  });

const agent = program.command("agent").description("harness integration: answer pending model requests (§harness provider)");
agent
  .command("list")
  .description("list pending model requests awaiting a harness answer")
  .option("--format <format>", "text | json", "text")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((opts: { format: string; cwd: string }) => {
    process.exitCode = runAgentList(opts.cwd, opts.format === "json" ? "json" : "text");
  });
agent
  .command("show <id>")
  .description("print a pending request in full (prompt + embedded JSON Schema)")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((id: string, opts: { cwd: string }) => {
    process.exitCode = runAgentShow(id, opts.cwd);
  });
agent
  .command("respond <id>")
  .description("answer a pending request with a JSON value")
  .option("--file <path>", "file containing the JSON value")
  .option("--stdin", "read the JSON value from stdin")
  .option("--by <who>", "record who answered")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((id: string, opts: { file?: string; stdin?: boolean; by?: string; cwd: string }) => {
    process.exitCode = runAgentRespond({ id, file: opts.file, stdin: opts.stdin, by: opts.by, cwd: opts.cwd });
  });

const followup = program.command("followup").description("follow-up operations");
followup
  .command("resolve <id>")
  .description("resolve a follow-up with an option and/or note")
  .option("--run <runId>", "run that owns the follow-up (needed when ambiguous)")
  .option("--option <optionId>", "chosen option id")
  .option("--note <text>", "free-form resolution note")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((id: string, opts: { run?: string; option?: string; note?: string; cwd: string }) => {
    process.exitCode = runFollowupResolve({
      followupId: id,
      runId: opts.run,
      optionId: opts.option,
      note: opts.note,
      cwd: opts.cwd,
    });
  });

const followups = program.command("followups").description("list open follow-ups across runs");
followups
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--format <format>", "text | json (machine-readable)", "text")
  .action((opts: { cwd: string; format: string }) => {
    process.exitCode = runFollowups(opts.cwd, opts.format === "json" ? "json" : "text");
  });

const run = program.command("run").description("run inspection");
run
  .command("show <runId>")
  .description("show a run summary")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((runId: string, opts: { cwd: string }) => {
    process.exitCode = runShow(runId, opts.cwd);
  });
run
  .command("cancel <runId>")
  .description("mark an interrupted (running) run as cancelled")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((runId: string, opts: { cwd: string }) => {
    process.exitCode = runCancel(runId, opts.cwd);
  });
run
  .command("pr <runId>")
  .description("generate a PR title/body from run records (nothing is posted)")
  .option("--out <file>", "write the draft to a file instead of stdout")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((runId: string, opts: { cwd: string; out?: string }) => {
    process.exitCode = runPr(runId, opts);
  });

export function main(argv: string[]): void {
  program.parseAsync(argv).catch((e: unknown) => {
    if (isSpcError(e)) {
      console.error(`error ${e.code}: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(e);
    process.exitCode = 2;
  });
}

// Entry point guard: runs when executed as a CLI, importable as a library otherwise.
if (process.argv[1] && process.argv[1].endsWith("main.js")) {
  main(process.argv);
}
