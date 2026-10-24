#!/usr/bin/env node
/**
 * M0 diagnostic (board-flake programme): run the verification board N
 * times, capture every contradicted criterion's full evidence payload
 * with honest output-completeness labels, and snapshot machine context
 * around each pass. The captured stderr envelopes become the
 * fixture-backed classification signatures for M2; the machine-context
 * correlation decides M1.
 *
 * Usage: node scripts/board-flake-capture.mjs [passes=3]
 * Output: /tmp/board-flake-report-<ts>/{pass-N.json,summary.md}
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const repoRoot = new URL("..", import.meta.url).pathname;
const CLI = path.join(repoRoot, "packages", "cli", "dist", "main.js");
const runsDir = path.join(repoRoot, ".spc", "runs");
const passes = Number(process.argv[2] ?? 3);
const outDir = `/tmp/board-flake-report-${Date.now()}`;
mkdirSync(outDir, { recursive: true });

const MAX_OUTPUT_BYTES = 65536; // .spc/config.yaml execution.maxOutputBytes

function machineContext() {
  const vm = spawnSync("vm_stat", [], { encoding: "utf8" }).stdout ?? "";
  const procs = spawnSync("sh", ["-c", "ps ax -o comm= | grep -Ec 'vitest|esbuild|node' || true"], {
    encoding: "utf8",
  }).stdout?.trim();
  return {
    at: new Date().toISOString(),
    loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
    pagesFree: Number(/Pages free:\s+(\d+)/.exec(vm)?.[1] ?? 0),
    pagesPurgeable: Number(/Purgeable pages:\s+(\d+)/.exec(vm)?.[1] ?? 0),
    liveNodeProcesses: Number(procs ?? 0),
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
  };
}

function completenessLabel(stream) {
  // Persisted output is truncated to maxOutputBytes (commands.ts); the
  // in-memory collection cap (8x) is NOT reconstructible from stored
  // evidence - a stream at the persistence cap may have been capped
  // earlier in memory. The label says exactly what we know.
  if (stream.length >= MAX_OUTPUT_BYTES) return "persistence-truncated";
  return "captured-complete-or-collection-capped";
}

function runsCreatedSince(ts) {
  return readdirSync(runsDir)
    .filter((d) => d.startsWith("v-"))
    .filter((d) => {
      try {
        return statSync(path.join(runsDir, d)).mtimeMs >= ts;
      } catch {
        return false;
      }
    });
}

function captureFailures(sinceTs) {
  const failures = [];
  for (const vrun of runsCreatedSince(sinceTs)) {
    const file = path.join(runsDir, vrun, "evidence.jsonl");
    if (!fileExists(file)) continue;
    for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.phase === "red" || e.outcome !== "contradicts") continue;
      const p = e.payload ?? {};
      failures.push({
        run: vrun,
        criterionId: e.criterionId,
        propertyRefs: e.propertyRefs,
        kind: e.kind,
        command: p.command,
        exitCode: p.exitCode,
        expectedExitCode: p.expectedExitCode,
        timedOut: p.timedOut,
        failureShape: p.failureShape ?? null,
        durationMs: p.durationMs,
        deniedReason: p.deniedReason ?? null,
        stdoutBytes: (p.stdout ?? "").length,
        stderrBytes: (p.stderr ?? "").length,
        stdoutCompleteness: completenessLabel(p.stdout ?? ""),
        stderrCompleteness: completenessLabel(p.stderr ?? ""),
        stdout: p.stdout ?? "",
        stderr: p.stderr ?? "",
        stderrDigest: p.stderrDigest ?? null,
      });
    }
  }
  return failures;
}

function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const allPasses = [];
for (let pass = 1; pass <= passes; pass++) {
  const startTs = Date.now();
  const before = machineContext();
  const board = spawnSync(process.execPath, [CLI, "verify", "--all"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
  });
  const after = machineContext();
  const failures = captureFailures(startTs);
  const satisfied = (board.stdout ?? "").match(/\bsatisfied\b/g)?.length ?? 0;
  const unsatisfied = (board.stdout ?? "").match(/\bunsatisfied\b/g)?.length ?? 0;
  const record = {
    pass,
    boardExit: board.status,
    boardDurationMs: Date.now() - startTs,
    satisfiedLines: satisfied,
    unsatisfiedLines: unsatisfied,
    machineBefore: before,
    machineAfter: after,
    failureCount: failures.length,
    failures,
  };
  allPasses.push(record);
  writeFileSync(path.join(outDir, `pass-${pass}.json`), JSON.stringify(record, null, 2));
  console.log(
    `[pass ${pass}] exit=${board.status} dur=${Math.round(record.boardDurationMs / 1000)}s satisfied=${satisfied} unsatisfied=${unsatisfied} failuresCaptured=${failures.length}`,
  );
}

const totalFailures = allPasses.reduce((n, p) => n + p.failureCount, 0);
const summary = [
  `# Board flake capture (${passes} passes)`,
  "",
  `Total failures captured: ${totalFailures} (acceptance: every observed failure captured with full context - this was met: ${totalFailures === allPasses.reduce((n, p) => n + p.unsatisfiedLines, 0) ? "yes, failure count equals unsatisfied lines" : "CHECK - counts diverge (indeterminate lines may exist)"})`,
  "",
  ...allPasses.map(
    (p) =>
      `- pass ${p.pass}: exit=${p.boardExit}, ${Math.round(p.boardDurationMs / 60000)}min, unsatisfied=${p.unsatisfiedLines}, load before=${p.machineBefore.loadavg.join("/")}, nodeProcs after=${p.machineAfter.liveNodeProcesses}, pagesFree after=${p.machineAfter.pagesFree}`,
  ),
  "",
  "Failure signatures (first line of each distinct stderr, deduplicated):",
  ...[
    ...new Set(
      allPasses
        .flatMap((p) => p.failures)
        .map((f) => `${f.criterionId} [timedOut=${f.timedOut} shape=${f.failureShape}] ${String(f.stderr).split("\n").filter(Boolean).slice(0, 2).join(" | ").slice(0, 200)}`),
    ),
  ].map((s) => `  - ${s}`),
].join("\n");
writeFileSync(path.join(outDir, "summary.md"), summary);
console.log(`\nReport: ${outDir}/summary.md`);
