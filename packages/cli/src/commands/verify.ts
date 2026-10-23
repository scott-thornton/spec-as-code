import path from "node:path";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { gitOk, statusPorcelain } from "@spc/repo";
import { renderGithubAnnotations, renderGithubSummary } from "@spc/renderer";
import { createVerifyRun, inPlaceHandoffWarning, prepareDisposableWorktree, verifyBundle } from "@spc/runtime";
import { createProvider, loadRepoConfig, resolveAllSpecs, resolveRepoRoot } from "../context.js";

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
      const report = await createVerifyRun({
        repoRoot,
        specIr: spec.ir,
        config,
        provider,
        executionRoot: worktree,
        prepareOutcome: prepared,
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
  if (format === "text" && statusPorcelain(repoRoot).dirty) {
    console.log("note: working tree is dirty; verification runs against the current state as-is");
  }

  let worst = 0;
  const jsonReports: unknown[] = [];
  for (const { ir } of specs) {
    const handoff = inPlaceHandoffWarning(path.join(repoRoot, ".spc", "runs"), ir.spec.metadata.id, repoRoot);
    if (handoff && format === "text") console.log(handoff);
    const report = await createVerifyRun({ repoRoot, specIr: ir, config, provider });
    const ok = report.states.every((s) => s.status === "satisfied" || s.status === "waived");
    if (!ok) worst = 1;

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
  if (format === "json") {
    console.log(JSON.stringify(multi ? jsonReports : jsonReports[0], null, 2));
  }

  return worst;
}
