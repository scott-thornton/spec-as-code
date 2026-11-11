import path from "node:path";
import { tmpdir } from "node:os";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { gitOk, statusPorcelain } from "@spc/repo";
import { renderGithubAnnotations, renderGithubSummary } from "@spc/renderer";
import { createVerifyRun, freshnessCheck, inPlaceHandoffWarning, prepareDisposableWorktree, verifyBundle } from "@spc/runtime";
import { CommandCache, parseFilterScope, resolveScopeDirs, trackedFiles, workspacePackageDirs, type SharedCommandRun } from "@spc/verifier";
import { verifyProperties, EventStore, EvidenceStore, FollowupStore } from "@spc/runtime";
import { git } from "@spc/repo";
import { createProvider, loadRepoConfig, resolveAllSpecs, resolveRepoRoot } from "../context.js";
import { loadSuiteRegistry, type SuiteDefinition } from "@spc/repo";
import type { DesiredProperty } from "@spc/schema";

/**
 * Resolve every suite reference in the selected specs against the
 * registry BEFORE any criterion executes (specs/suite-references,
 * SR-003): a typo'd ref is a compile error, never a skipped criterion
 * or a half-executed sweep. Returns the frozen registry on success.
 */
function resolveSuitesOrFail(specs: { ir: { spec: { metadata: { id: string } }; properties: DesiredProperty[] } }[], registryRoot: string): Map<string, SuiteDefinition> | null {
  let registry: Map<string, SuiteDefinition>;
  try {
    registry = loadSuiteRegistry(registryRoot);
  } catch (e) {
    const err = e as Error & { code?: string };
    console.error(`error ${err.code ?? "SPC_SUITE_INVALID"}: ${err.message}`);
    return null;
  }
  for (const { ir } of specs) {
    for (const property of ir.properties) {
      for (const criterion of property.acceptance) {
        if (criterion.type === "suite" && !registry.has(criterion.ref)) {
          console.error(`error SPC_SUITE_UNKNOWN: criterion ${criterion.id} (spec ${ir.spec.metadata.id}) references suite "${criterion.ref}" which is not defined under suites/`);
          return null;
        }
      }
    }
  }
  return registry;
}

/**
 * `spc verify [specFile]`: verify desired state against the current
 * tree. With no file, verifies EVERY spec under specs/ and exits
 * worst-of (0 only when every spec passes); an explicit file verifies
 * exactly that spec.
 */
export async function runVerify(
  specFile: string | undefined,
  cwd?: string,
  format: "text" | "github" | "json" = "text",
  bundleDir?: string,
  runId?: string,
  forceAll?: boolean,
  scopedDiffBase?: string,
): Promise<number> {
  // Bundle mode: verify an exported run's integrity and derivation
  // WITHOUT the repository. Cannot re-execute commands (threat model).
  if (bundleDir) {
    let report;
    try {
      report = verifyBundle(path.resolve(bundleDir));
    } catch (e) {
      // Strict loaders throw on tampered logs (chain breaks, digest
      // mismatches): render as a bundle failure with the reason, not a
      // crash - the bundle is untrusted input by definition.
      const message = e instanceof Error ? e.message : String(e);
      if (format === "json") {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      } else {
        console.log(`BUNDLE FAILED: ${message}`);
      }
      return 1;
    }
    if (format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Bundle: ${report.bundle}`);
      console.log(`Run ${report.runId}: ${report.ok ? "bundle OK" : "BUNDLE FAILED"}`);
      console.log(`Manifest: ${report.manifest}${report.manifestProblems.length > 0 ? "" : " (every component hashes to its recorded sha256)"}`);
      for (const p of report.manifestProblems) console.log(`  - ${p}`);
      console.log(`Events: ${report.eventCount} (${report.chainStatus}), evidence: ${report.evidenceCount} (digests ${report.evidenceDigests})`);
      console.log(`Projection: ${report.projectionMatches ? "state.json follows from the bundle's event log" : "DIVERGED"}`);
      for (const d of report.projectionDiffs) console.log(`  - ${d}`);
      console.log(`Attestation: ${report.attestation}${report.attestationDetail ? ` (${report.attestationDetail})` : ""}`);
      if (report.chainStatus === "legacy") console.log("note: legacy (pre-chaining) log; integrity holds, chain verification does not apply");
    }
    return report.ok ? 0 : 1;
  }
  // Run mode: verify a run's acceptance criteria against its RESULT
  // revision in a temporary worktree - the field agent's git-show
  // archaeology, first-class. Records still land in the real repo.
  if (runId) {
    const repoRoot = resolveRepoRoot(cwd);
    const runDir = path.join(repoRoot, ".spc", "runs", runId);
    const metaFile = path.join(runDir, "metadata.json");
    if (!existsSync(metaFile)) {
      console.error(`error SPC_RUN_NOT_FOUND: no run ${runId} under ${path.join(repoRoot, ".spc", "runs")}`);
      return 2;
    }
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { specId: string; specDigest?: string };
    const stateFile = path.join(runDir, "state.json");
    const state = existsSync(stateFile)
      ? (JSON.parse(readFileSync(stateFile, "utf8")) as { resultRevision?: string })
      : {};
    if (!state.resultRevision) {
      console.error(`error VERIFY_RUN_NO_RESULT: run ${runId} has no result revision to verify`);
      return 2;
    }
    const spec = resolveAllSpecs(path.join(repoRoot, "specs")).find(
      (s) => s.ir.spec.metadata.id === meta.specId,
    );
    if (!spec) {
      console.error(`error SPEC_NOT_FOUND: run ${runId} references spec ${meta.specId}, which is not under specs/`);
      return 2;
    }
    if (format === "text" && meta.specDigest && meta.specDigest !== spec.ir.digest) {
      console.log(`note: spec ${meta.specId} changed since the run; verifying current spec text against the run's revision`);
    }
    const config = loadRepoConfig(repoRoot);
    const provider = await createProvider(config, repoRoot);
    const worktree = path.join(repoRoot, ".spc", "worktrees", `verify-${runId}`);
    // Defensive pre-clean of a stale verification worktree; nothing to
    // remove on the first run, and that is not an error.
    try {
      gitOk(repoRoot, ["worktree", "remove", "--force", worktree]);
    } catch {
      // absent - fine
    }
    gitOk(repoRoot, ["worktree", "add", "--detach", worktree, state.resultRevision]);
    try {
      console.log(`Verifying run ${runId} at revision ${state.resultRevision.slice(0, 12)} (temporary worktree)`);
      const prepared = prepareDisposableWorktree(repoRoot, worktree);
      const prepLine =
        prepared.mode === "installed"
          ? `Preparing: pnpm install --frozen-lockfile --offline exit ${prepared.exitCode}`
          : prepared.mode === "failed"
            ? `Preparing: FAILED (${prepared.detail ?? "environment not installable"}) - command criteria will be inconclusive, not contradicted`
            : prepared.mode === "linked"
              ? "Preparing: linked repository node_modules"
              : "Preparing: nothing to install or link";
      console.log(prepLine);
      const suites = resolveSuitesOrFail([spec], worktree);
      if (suites === null) return 2;
      const report = await createVerifyRun({
        repoRoot,
        commandCache: new CommandCache(repoRoot, path.join(repoRoot, ".spc", "cache", "verify-commands.json")),
        specIr: spec.ir,
        config,
        provider,
        executionRoot: worktree,
        prepareOutcome: prepared,
        suites,
      });
      if (format === "json") {
        console.log(JSON.stringify({
          runId,
          revision: state.resultRevision,
          properties: report.states.map((s) => ({ id: s.propertyId, status: s.status, ...(s.reason ? { reason: s.reason } : {}) })),
        }, null, 2));
      } else {
        for (const s of report.states) {
          console.log(`  ${s.status.padEnd(12)} ${s.propertyId}${s.reason ? ` - ${s.reason}` : ""}`);
        }
      }
      return report.states.every((s) => s.status === "satisfied" || s.status === "waived") ? 0 : 1;
    } finally {
      gitOk(repoRoot, ["worktree", "remove", "--force", worktree]);
    }
  }
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadRepoConfig(repoRoot);
  const provider = await createProvider(config, repoRoot);
  const specs = resolveAllSpecs(path.join(repoRoot, "specs"), specFile ?? undefined);
  const multi = specs.length > 1;
  // Frozen suite registry: loaded, validated and every reference
  // resolved ONCE per invocation, before the first criterion executes.
  const suites = resolveSuitesOrFail(specs, repoRoot);
  if (suites === null) return 2;
  if (format === "text" && statusPorcelain(repoRoot).dirty) {
    console.log("note: working tree is dirty; verification runs against the current state as-is");
  }

  let worst = 0;
  const jsonReports: unknown[] = [];
  // specs/verify-failure-visibility: every unsatisfied requirement
  // across all verified specs - the terminal failure block (text) and
  // the failures array (json) are built from this, so the worst truth
  // is the last thing on screen, not the seventy-first spec in the
  // alphabetical march.
  const failures: { spec: string; requirement: string; reason: string }[] = [];
  // The execution memo belongs to the INVOCATION (specs/verify-dedup):
  // ONE map threaded through every spec's verification, so repeated
  // commands across specs share a physical execution. Created here,
  // dies here - no module state, no retention beyond this loop.
  // Beneath it, the persisted cache (specs/verify-cache): loaded once,
  // threaded through every spec, persisted at the end - a criterion
  // command whose scope digests are unchanged since its last clean
  // execution reuses the recorded result instead of re-running.
  const invocationCommandRuns = new Map<string, SharedCommandRun>();
  // Invocation accounting (specs/tooling-sweep): executed vs reused
  // counts, freshness-cached spec count, wall time - the reuse figure
  // this session kept hand-counting from events.jsonl.
  const invocationStartedAt = Date.now();
  let cachedSpecs = 0;
  const invocationRunIds: string[] = [];
  const commandCache = new CommandCache(repoRoot, path.join(repoRoot, ".spc", "cache", "verify-commands.json"));
  try {
    commandCache.persist();
  } catch {
    // best-effort cache dir creation; verification proceeds without it
  }
  // specs/diff-scoped-verify: partial mode is a REPORT, not evidence -
  // derived-disjointness skipping, honest partial banner, NO run
  // records, no freshness anchor. The default path below is untouched.
  if (scopedDiffBase !== undefined) {
    return runScopedDiffVerify(specs, repoRoot, scopedDiffBase, format, config, provider, suites);
  }
  for (const { ir } of specs) {
    const handoff = inPlaceHandoffWarning(path.join(repoRoot, ".spc", "runs"), ir.spec.metadata.id, repoRoot);
    if (handoff && format === "text") console.log(handoff);
    if (!forceAll) {
      const freshness = freshnessCheck(repoRoot, ir, path.join(repoRoot, ".spc", "runs"));
      if (freshness.cached) {
        cachedSpecs += 1;
        if (format === "json") {
          jsonReports.push({ spec: ir.spec.metadata.id, cached: true, priorRunId: freshness.priorRunId });
        } else {
          console.log(`  CACHED      ${ir.spec.metadata.id} (prior ${freshness.priorRunId}; zero tracked changes since its verified base - not newly collected evidence)`);
        }
        continue;
      }
    }
    const report = await createVerifyRun({ repoRoot, specIr: ir, config, provider, commandRuns: invocationCommandRuns, commandCache, suites });
    invocationRunIds.push(report.runId);
    const ok = report.states.every((s) => s.status === "satisfied" || s.status === "waived");
    if (!ok) worst = 1;
    for (const s of report.states) {
      if (s.status !== "satisfied" && s.status !== "waived") {
        failures.push({ spec: ir.spec.metadata.id, requirement: s.propertyId, reason: s.reason ?? "" });
      }
    }

    if (format === "json") {
      jsonReports.push({
        spec: ir.spec.metadata.id,
        runId: report.runId,
        properties: report.states.map((s) => ({
          id: s.propertyId,
          status: s.status,
          ...(s.reason ? { reason: s.reason } : {}),
        })),
        followups: report.followups
          .filter((f) => f.status === "open")
          .map((f) => ({ id: f.id, type: f.type, blocking: f.blocking, title: f.title })),
      });
    } else if (format === "github") {
      // CI mode: annotations on stdout, Markdown block into the step summary.
      if (multi) console.log(`::group::spec ${ir.spec.metadata.id}`);
      for (const line of renderGithubAnnotations(ir, report.states)) {
        console.log(line);
      }
      const summary = renderGithubSummary({ specIr: ir, states: report.states, runId: report.runId });
      const stepSummary = process.env.GITHUB_STEP_SUMMARY;
      if (stepSummary) {
        appendFileSync(stepSummary, `${summary}\n`, "utf8");
      } else {
        console.log("");
        console.log(summary.trimEnd());
      }
      if (multi) console.log("::endgroup::");
    } else {
      if (multi) console.log(`Spec: ${ir.spec.metadata.id}`);
      console.log(`Verification run: ${report.runId}`);
      console.log("");
      for (const s of report.states) {
        console.log(`  ${s.status.padEnd(12)} ${s.propertyId}${s.reason ? ` - ${s.reason}` : ""}`);
      }
      const open = report.followups.filter((f) => f.status === "open");
      if (open.length > 0) {
        console.log("");
        console.log("Follow-ups created:");
        for (const f of open) console.log(`  ${f.blocking ? "[blocking] " : ""}${f.id} ${f.title}`);
      }
      if (multi) console.log("");
    }
  }
  // Execution accounting (specs/tooling-sweep): one line, invocation-level.
  // (text only; the terminal json print carries the failures array.)
  let executed = 0;
  let reused = 0;
  for (const runId of invocationRunIds) {
    try {
      const ev = readFileSync(path.join(repoRoot, ".spc", "runs", runId, "events.jsonl"), "utf8");
      for (const line of ev.split("\n")) {
        if (line.includes('"COMMAND_EXECUTED"')) executed += 1;
        if (line.includes('"COMMAND_RESULT_REUSED"')) reused += 1;
      }
    } catch {
      // unreadable events: contributes nothing
    }
  }
  if (executed + reused > 0) {
    const share = Math.round((reused / (executed + reused)) * 100);
    const wallS = Math.round((Date.now() - invocationStartedAt) / 1000);
    if (format !== "json") {
      console.log(`Executions: ${executed} executed, ${reused} reused (${share}% reuse), ${cachedSpecs} spec(s) freshness-cached, wall ${wallS}s`);
    }
  }
  // specs/verify-failure-visibility VF-001: the failing fact is the
  // TERMINAL output - printed after the Executions line, so a tail
  // reader sees what failed last. Green runs print nothing here.
  if (worst !== 0 && failures.length > 0 && format === "text") {
    console.log("");
    console.log(`Unsatisfied (${failures.length}):`);
    for (const f of failures) {
      console.log(`  ${f.spec}  ${f.requirement} - ${f.reason}`);
    }
  }
  // VF-002: the failures array as data, emitted with the final json
  // print (after accounting, so executions and failures ride together).
  if (format === "json") {
    if (multi) jsonReports.push({ failures });
    const output = multi ? jsonReports : { ...((jsonReports[0] as Record<string, unknown>) ?? {}), failures };
    console.log(JSON.stringify(output, null, 2));
  }
  if (worst === 0 && format !== "json") {
    console.log("");
    console.log(`Next: adversarial pass (stage 7 of 7), then push (follow: spc use-skill adversarial-loop)`);
  }
  try {
    commandCache.persist();
  } catch {
    // best-effort persistence; the next invocation re-runs what it must
  }
  return worst;
}

/**
 * specs/diff-scoped-verify: partial verification by DERIVED
 * disjointness - a report, never evidence. Changed paths come from
 * git diff --name-only -z --no-renames (the skew-carveout
 * discipline); a file criterion skips on an untouched path; a
 * command/suite criterion skips only when its DECLARED filter scope's
 * tracked files are disjoint from the diff (unscoped commands declare
 * the whole workspace and never skip). No run records are written -
 * nothing anchors freshness, nothing can be mistaken for proof. The
 * claim shrinks honestly: the partial banner, never green-as-full.
 */
/** The root files that define a pnpm workspace closure: a change to
 *  any of them redefines every workspace-union scope (packages: null)
 *  - such a scope can never be PROVEN disjoint against them. */
const WORKSPACE_DEFINING = ["pnpm-workspace.yaml", "package.json", "pnpm-lock.yaml", ".npmrc", ".pnpmfile.cjs"];

interface ScopedSkip {
  id: string;
  reason: string;
}

async function runScopedDiffVerify(
  specs: { ir: ReturnType<typeof resolveAllSpecs>[number]["ir"] }[],
  repoRoot: string,
  baseRev: string,
  format: "text" | "github" | "json",
  config: ReturnType<typeof loadRepoConfig>,
  provider: unknown,
  suites: Map<string, SuiteDefinition> | null,
): Promise<number> {
  // Adversarial F1: a diff that cannot be computed must REFUSE, never
  // produce an empty changed set - empty means everything looks
  // disjoint and the report lies with a vacuous green.
  const diffRun = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", baseRev, "HEAD"]);
  if (!diffRun.ok) {
    console.error(`--scoped-to-diff: cannot compute ${baseRev.slice(0, 12)}..HEAD: ${diffRun.stderr.trim() || diffRun.stdout.trim() || "git diff failed"} - refusing rather than report a vacuous partial verification`);
    return 2;
  }
  const changed = diffRun.stdout
    .split("\0")
    .filter(Boolean)
    .map((p) => p.split(path.sep).join("/"));
  const changedSet = new Set(changed);

  const allCriteria: { specId: string; propertyId: string; criterionId: string; criterion: { id: string; type: string; path?: string; command?: string } }[] = [];
  for (const { ir } of specs) {
    for (const property of ir.properties) {
      for (const criterion of property.acceptance as { id: string; type: string; path?: string; command?: string }[]) {
        allCriteria.push({ specId: ir.spec.metadata.id, propertyId: property.id, criterionId: criterion.id, criterion });
      }
    }
  }

  const skips: ScopedSkip[] = [];
  const skipIds = new Set<string>();
  for (const entry of allCriteria) {
    const c = entry.criterion;
    if (c.type === "file" && c.path !== undefined) {
      const p = c.path.replace(/^\.\//, "").split(path.sep).join("/");
      if (!changedSet.has(p)) {
        skipIds.add(c.id);
        skips.push({ id: c.id, reason: `untouched path: ${p} not in ${baseRev.slice(0, 8)}..HEAD` });
      }
      continue;
    }
    if (c.type === "command" || c.type === "suite") {
      // Adversarial F2: suite criteria carry ref (the schema's field),
      // not command - the original branch read the wrong field and no
      // suite ever skipped.
      const command = c.type === "suite"
        ? ((suites?.get((c as { ref?: string }).ref ?? "")) as unknown as { command?: string } | undefined)?.command ?? ""
        : c.command ?? "";
      if (command === "") continue; // nothing to derive from: evaluate
      const scope = parseFilterScope(command);
      if (scope === null) continue; // unscoped declares the workspace: never skip
      // Completeness of the declared scope (the banner's letter is
      // PROVEN disjoint): any declared package - or, for ... closures,
      // any walked workspace: dependency - that does not resolve makes
      // the scope incomplete; a silently shrunken scope can fabricate
      // disjointness. Evaluate, never skip.
      const byName = workspacePackageDirs(repoRoot);
      if (scope.packages !== null) {
        if (scope.packages.some((n) => !byName.has(n))) continue;
        if (scope.withDeps) {
          // Fail closed (the confirmation pass's F1): an incomplete
          // closure - an unresolvable workspace dependency or an
          // unreadable member - forces the criterion to EVALUATE,
          // mirroring impact.ts exactly; the walk never silently
          // prunes.
          let incomplete = false;
          const seen = new Set<string>(scope.packages);
          const queue = [...scope.packages];
          while (queue.length > 0 && !incomplete) {
            const name = queue.shift()!;
            const dir = byName.get(name)!;
            let pj: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
            try {
              pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as typeof pj;
            } catch {
              incomplete = true;
              break;
            }
            for (const deps of [pj.dependencies, pj.devDependencies]) {
              for (const [dep, spec] of Object.entries(deps ?? {})) {
                if (!String(spec).startsWith("workspace:")) continue;
                if (!byName.has(dep)) {
                  incomplete = true;
                  break;
                }
                if (!seen.has(dep)) {
                  seen.add(dep);
                  queue.push(dep);
                }
              }
              if (incomplete) break;
            }
          }
          if (incomplete) continue; // scope incomplete: evaluate, never skip
        }
      }
      // A workspace-union scope's closure is DEFINED by the workspace
      // root config: a change there can never be disjoint from it.
      if (scope.packages === null && [...changedSet].some((c) => WORKSPACE_DEFINING.includes(c))) continue;
      const dirs = resolveScopeDirs(repoRoot, scope);
      const scopeFiles = trackedFiles(repoRoot, dirs).map((f) => f.split(path.sep).join("/"));
      // The filtered-file-set shadow: a changed path INSIDE a scope
      // directory but outside the declared file set (the
      // node_modules/dist filters) means the set is incomplete -
      // disjointness is not provable.
      const dirPrefixes = dirs.map((d) => (path.relative(repoRoot, d) + path.sep).split(path.sep).join("/"));
      const shadowed = [...changedSet].some((c) => dirPrefixes.some((p) => c.startsWith(p)));
      const disjoint = scopeFiles.every((f) => !changedSet.has(f));
      if (scopeFiles.length > 0 && disjoint && !shadowed) {
        skipIds.add(c.id);
        const pkgNames = dirs.map((d) => path.relative(repoRoot, d) || ".").join(", ");
        skips.push({ id: c.id, reason: `scope disjoint: ${pkgNames} untouched by ${baseRev.slice(0, 8)}..HEAD` });
      }
    }
    // human criteria and everything else: evaluate
  }

  // Evaluate the non-skipped criteria WITHOUT run records: strip the
  // skipped criteria from each property, then verifyProperties with a
  // synthetic runId that never touches .spc/runs.
  let worst = 0;
  const jsonReports: unknown[] = [];
  const failures: { spec: string; requirement: string; reason: string }[] = [];
  const memo = new Map<string, SharedCommandRun>();
  // Real stores at throwaway paths: the sweep needs them; nothing lands
  // under .spc (specs/diff-scoped-verify DSV-003 - no evidence
  // footprint).
  const scratch = mkdtempSync(path.join(tmpdir(), "spc-scoped-diff-"));
  const now = () => new Date().toISOString();
  const events = new EventStore(path.join(scratch, "events.jsonl"), "scoped-diff-report", now);
  const evidence = new EvidenceStore(path.join(scratch, "evidence.jsonl"));
  const followups = new FollowupStore(path.join(scratch, "followups.json"));
  for (const { ir } of specs) {
    const properties = ir.properties.map((property) => ({
      ...property,
      acceptance: (property.acceptance as unknown[]).filter((c) => !skipIds.has((c as { id: string }).id)),
    }));
    const result = await verifyProperties({
      properties: properties as never,
      runId: "scoped-diff-report",
      cwd: repoRoot,
      revision: "HEAD",
      config,
      provider: provider as never,
      commandRuns: memo,
      events,
      evidence,
      followups,
      ...(suites !== null ? { suites: suites as unknown as import("@spc/verifier").SuiteRegistry } : {}),
    });
    for (const state of result.states) {
      if (state.status !== "satisfied" && state.status !== "waived") {
        worst = 1;
        failures.push({ spec: ir.spec.metadata.id, requirement: state.propertyId, reason: state.reason ?? state.status });
      }
    }
    if (format === "json") {
      jsonReports.push({
        spec: ir.spec.metadata.id,
        properties: result.states.map((s) => ({ id: s.propertyId, status: s.status, ...(s.reason ? { reason: s.reason } : {}) })),
      });
    } else if (format === "text") {
      console.log(`Spec: ${ir.spec.metadata.id} (partial)`);
      for (const s of result.states) console.log(`  ${s.status.padEnd(12)} ${s.propertyId}${s.reason ? ` - ${s.reason}` : ""}`);
      console.log("");
    }
  }

  const total = allCriteria.length;
  const evaluated = total - skips.length;
  // Adversarial F3: the scratch stores (with full command output in
  // evidence payloads) are removed - "throwaway paths" meant it.
  rmSync(scratch, { recursive: true, force: true });
  const banner = `partial verification: ${evaluated} of ${total} criteria evaluated, ${skips.length} skipped (proven disjoint)`;
  if (format === "json") {
    // House shape: single spec prints one object, multi prints the
    // array with the summary as its tail entry (the executions
    // convention).
    const summary = { partial: true, evaluated, skipped: skips.length, skippedCriteria: skips, failures };
    const output = specs.length > 1 ? [...jsonReports, summary] : { ...(jsonReports[0] as Record<string, unknown>), ...summary };
    console.log(JSON.stringify(output, null, 2));
  } else {
    for (const s of skips) console.log(`SKIP(proven) ${s.id} - ${s.reason}`);
    console.log("");
    console.log(banner);
    // Adversarial F4: evaluated failures keep the terminal-fact
    // convention (specs/verify-failure-visibility VF-001 shape).
    if (failures.length > 0) {
      console.log("");
      console.log(`Unsatisfied (${failures.length}):`);
      for (const f of failures) console.log(`  ${f.spec}  ${f.requirement} - ${f.reason}`);
    }
  }
  return worst;
}
