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
import { runCancel, runExport, runPr, runReplay, runShow } from "./commands/run.js";
import { runAgentList, runAgentRespond, runAgentShow, runAgentValidate, runAgentDryRun, runAgentWait, type AgentShowPart } from "./commands/agent.js";
import { runSkills, runUseSkill } from "./commands/skills.js";
import { runPolicyExplain } from "./commands/policy.js";
import { runQuickCommand } from "./commands/quick.js";
import { runRectify } from "./commands/rectify.js";
import { runAttest } from "./commands/attest.js";
import { runPatchBuild } from "./commands/patch.js";
import { runBrief } from "./commands/brief.js";
import { runUsage } from "./commands/usage.js";
import { runSpecLint } from "./commands/lint.js";

const program = new Command();

program
  .name("spc")
  .description("Spec-as-Code: declarative requirements, validated plans, bounded agent execution, and status proven by running the verification")
  .version("0.2.0");

program
  .command("init")
  .description("create specs/ and .spc/, write default config, report detected commands")
  .option("--cwd <dir>", "target directory", process.cwd())
  .action((opts: { cwd: string }) => {
    runInit(opts.cwd);
  });

program
  .command("skills")
  .description("list available process skills (repo-local .agents/skills override bundled copies)")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((opts: { cwd: string }) => {
    process.exitCode = runSkills(opts.cwd);
  });

program
  .command("use-skill <name>")
  .description("print a skill's instructions for the current agent to follow")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((name: string, opts: { cwd: string }) => {
    process.exitCode = runUseSkill(name, opts.cwd);
  });

const spec = program.command("spec").description("specification compilation");
spec
  .command("validate <file>")
  .description("validate a spec file and print its digest")
  .option("--format <format>", "text | json (machine-readable)", "text")
  .option("--show-commands", "print every command criterion's parsed string (post-YAML) after validation")
  .action((file: string, opts: { format: string; showCommands?: boolean }) => {
    process.exitCode = runSpecValidate(file, opts.format === "json" ? "json" : "text", opts.showCommands === true);
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
  .option("--stay", "leave the checkout on the run branch instead of restoring (in-place run-branch mode)")
  .option("--parent <runId>", "explicit chain parent (validated: same spec digest, git-ancestor predecessor)")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action(
    async (
      planFile: string | undefined,
      opts: { resume?: string; allowDirty?: boolean; force?: boolean; stay?: boolean; cwd: string },
    ) => {
      process.exitCode = await runApply({
        planFile,
        resumeRunId: opts.resume,
        allowDirty: opts.allowDirty,
        force: opts.force,
        stay: opts.stay,
        cwd: opts.cwd,
      });
    },
  );

program
  .command("verify [specFile]")
  .description("run acceptance criteria against the current tree (every spec in specs/ when no file is given, exit worst-of)")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--format <format>", "text | github | json", "text")
  .option("--bundle <dir>", "verify an exported run bundle (integrity + derivation, no repo)")
  .option("--run <runId>", "verify a run's acceptance criteria against its result revision (temporary worktree)")
  .action(async (specFile: string | undefined, opts: { cwd: string; format: string; bundle?: string; run?: string }) => {
    const vfmt = opts.format === "github" ? "github" : opts.format === "json" ? "json" : "text";
    process.exitCode = await runVerify(specFile, opts.cwd, vfmt, opts.bundle, opts.run);
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
  .description("effective chain status by default (head run's persisted requirements with provenance); --run <id> for a single run's own view")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--format <format>", "text | json (machine-readable)", "text")
  .option("--run <runId>", "render exactly this run's own states (single-run view, no chain aggregation)")
  .action((specFile: string | undefined, opts: { cwd: string; format: string; run?: string }) => {
    process.exitCode = runStatus(specFile, opts.cwd, opts.format === "json" ? "json" : "text", opts.run);
  });

program
  .command("diff [specFile]")
  .description("desired vs observed property states (every spec in specs/ when no file is given)")
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
  .description("print a pending request; decompose with --part system|prompt|schema|payload|json")
  .option("--part <part>", "system | prompt | schema | payload | json")
  .option("--json", "print the whole request as one JSON object (same as --part json)")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((id: string, opts: { part?: string; json?: boolean; cwd: string }) => {
    const part = opts.json ? "json" : opts.part;
    if (part !== undefined && !["system", "prompt", "schema", "payload", "json"].includes(part)) {
      console.error(`unknown part "${part}"; use system, prompt, schema, payload or json`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = runAgentShow(id, opts.cwd, part as AgentShowPart | undefined);
  });
agent
  .command("wait")
  .description("block until a harness request is pending, then print it (no sleep-polling)")
  .option("--timeout <ms>", "give up after this many milliseconds (default 15 minutes)", "900000")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action(async (opts: { timeout: string; cwd: string }) => {
    process.exitCode = await runAgentWait({ timeoutMs: Number(opts.timeout) || 900000, cwd: opts.cwd });
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
agent
  .command("validate <id>")
  .description("preflight-check a draft answer against the request's schema before submitting")
  .requiredOption("--file <path>", "file containing the draft JSON value")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((id: string, opts: { file: string; cwd: string }) => {
    process.exitCode = runAgentValidate({ id, file: opts.file, cwd: opts.cwd });
  });
agent
  .command("dry-run <id>")
  .description("stage a draft answer in a throwaway worktree and run the task's deterministic criteria (advisory, never gates)")
  .requiredOption("--file <path>", "file containing the draft JSON value")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action(async (id: string, opts: { file: string; cwd: string }) => {
    process.exitCode = await runAgentDryRun({ id, file: opts.file, cwd: opts.cwd });
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
run
  .command("replay <runId>")
  .description("verify the event log, chain, projection and attestation of a finished run")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((runId: string, opts: { cwd: string }) => {
    process.exitCode = runReplay(runId, opts.cwd);
  });
run
  .command("export <runId>")
  .description("emit a self-contained evidence bundle (spec, plan, events, diff, hashes)")
  .option("--out <dir>", "bundle directory (default .spc/exports/<runId>)")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((runId: string, opts: { cwd: string; out?: string }) => {
    process.exitCode = runExport(runId, opts);
  });

program
  .command("attest <propertyId>")
  .description("record a human-review evidence record for a property (the human tier's ceremony)")
  .requiredOption("--by <name>", "the attestor's identity")
  .option("--note <text>", "context recorded with the attestation")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action(async (propertyId: string, opts: { by: string; note?: string; cwd: string }) => {
    process.exitCode = await runAttest({ propertyId, by: opts.by, note: opts.note, cwd: opts.cwd });
  });

program
  .command("quick <intent...>")
  .description("compressed SPC transaction: ephemeral spec + one gate (--verify), same machinery")
  .requiredOption("--verify <command>", "the gate you author: a side-effect-free check command")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--write <path>", "skip the planner: one mechanical task with this write target")
  .option("--stay", "leave the checkout on the run branch instead of restoring")
  .action(async (intent: string[], opts: { verify: string; cwd: string; write?: string; stay?: boolean }) => {
    process.exitCode = await runQuickCommand(intent, opts);
  });

program
  .command("rectify [runId]")
  .description("scaffold a rectification spec from findings (run's unsatisfied properties + investigations, or --findings file)")
  .option("--findings <file>", "external findings JSON file ([{id, statement, ...}])")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((runId: string | undefined, opts: { findings?: string; cwd: string }) => {
    process.exitCode = runRectify({ runId, findingsFile: opts.findings, cwd: opts.cwd });
  });

program
  .command("usage")
  .description("corpus economics from recorded state: model calls, op distribution, exact emitted bytes, patch usage, refusals (read-only)")
  .option("--format <format>", "text | json", "text")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((opts: { format: string; cwd: string }) => {
    process.exitCode = runUsage(opts.cwd, opts.format === "json" ? "json" : "text");
  });

program
  .command("brief")
  .description("session orientation: specs, last runs, queue, config posture, unmerged branches - read-only")
  .option("--format <format>", "text | json", "text")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((opts: { format: string; cwd: string }) => {
    process.exitCode = runBrief(opts.cwd, opts.format === "json" ? "json" : "text");
  });

spec
  .command("lint [file]")
  .description("craftsmanship warnings: static rules plus the red-capability check in a disposable worktree (warnings never gate); --provenance prints the rule registry")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .option("--provenance", "print the lint rule registry (lineage, fixtures, approver, supersession) and exit")
  .action(async (file: string | undefined, opts: { cwd: string; provenance?: boolean }) => {
    process.exitCode = await runSpecLint(file, opts.cwd, opts.provenance === true);
  });

const patch = program.command("patch").description("anchored patch composition (verifies, never decides)");
patch
  .command("build <path>")
  .description("emit a verified patch op for <path>: digest from the actual tree, anchor uniqueness checked")
  .option("--anchor <text>", "anchor text (exact bytes)")
  .option("--anchor-file <file>", "read anchor from file (exact bytes)")
  .option("--replacement <text>", "replacement text (exact bytes)")
  .option("--replacement-file <file>", "read replacement from file (exact bytes)")
  .option("--after <ops.json>", "JSON array of prior change ops to overlay before anchoring")
  .option("--expect-digest <sha256>", "refuse if the tree's digest differs from this (what the request showed you)")
  .option("--root <dir>", "tree root (defaults to cwd)")
  .action((path: string, opts) => {
    process.exitCode = runPatchBuild(path, opts);
  });

const policy = program.command("policy").description("command policy inspection");
policy
  .command("explain <command...>")
  .description("show how a command is classified and which policy applies")
  .option("--cwd <dir>", "repository directory", process.cwd())
  .action((command: string[], opts: { cwd: string }) => {
    process.exitCode = runPolicyExplain(command, opts.cwd);
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
