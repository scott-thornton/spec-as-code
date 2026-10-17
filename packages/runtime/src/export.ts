import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { compileSpecFile, diffPatch } from "@spc/repo";
import { findSpecFile, loadRunMeta, RUNTIME_ERROR } from "./run.js";
import { loadRunView } from "./queries.js";
import { spcPaths } from "./paths.js";

/**
 * `spc run export`: a self-contained evidence bundle for one run. The
 * run directory alone is almost portable (events, evidence, state,
 * amendments are all in .spc/runs/<id>); the bundle adds the closure the
 * run only references by digest - the spec file and its import graph,
 * the plan, the full base..result diff, and the config as of export -
 * plus a manifest hashing every component so the bundle can be audited
 * standalone instead of trusted.
 */

export interface RunExportResult {
  dir: string;
  manifestPath: string;
  warnings: string[];
}

function fileSha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

export function exportRun(repoRoot: string, runId: string, outDir?: string): RunExportResult {
  const paths = spcPaths(repoRoot);
  const meta = loadRunMeta(paths.runsDir, runId);
  if (!meta) {
    throw new SpcError(RUNTIME_ERROR, `no run ${runId} under ${paths.runsDir}`);
  }
  const view = loadRunView(paths.runsDir, runId);
  if (!view) {
    throw new SpcError(RUNTIME_ERROR, `run ${runId} has no readable state under ${paths.runsDir}`);
  }
  const warnings: string[] = [];
  const dir = outDir ? path.resolve(outDir) : path.join(paths.spcDir, "exports", runId);
  mkdirSync(dir, { recursive: true });

  // 1. The run directory, verbatim: the append-only record is the truth.
  cpSync(path.join(paths.runsDir, runId), path.join(dir, "run"), { recursive: true });

  // 2. The spec file and its import closure. The run pins a digest; the
  // file on disk is the CURRENT version - if they disagree, the run's
  // spec is history we cannot reconstruct, so we export what exists and
  // say so loudly in the warnings.
  const specFile = findSpecFile(paths.specsDir, meta.specId);
  if (specFile) {
    const specDirDest = path.join(dir, "spec");
    mkdirSync(specDirDest, { recursive: true });
    const compiled = compileSpecFile(specFile);
    cpSync(specFile, path.join(specDirDest, path.basename(specFile)));
    if (compiled.ok && compiled.ir) {
      if (compiled.ir.digest !== meta.specDigest) {
        warnings.push(
          `spec has changed since the run: the run executed digest ${meta.specDigest}, the current file compiles to ${compiled.ir.digest}; the exported spec is the CURRENT version, not the one the run executed`,
        );
      }
      for (const imp of compiled.ir.importedFiles ?? []) {
        const abs = path.isAbsolute(imp) ? imp : path.resolve(repoRoot, imp);
        if (!existsSync(abs)) continue;
        const rel = path.relative(path.dirname(specFile), abs);
        const dest = path.join(specDirDest, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(abs, dest);
      }
    }
  } else {
    warnings.push(`spec ${meta.specId} not found under ${paths.specsDir}; bundle exported without its spec`);
  }

  // 3. The plan the run executed (digest-pinned in metadata).
  if (meta.planId) {
    const planFile = paths.planFile(meta.planId);
    if (existsSync(planFile)) {
      mkdirSync(path.join(dir, "plan"), { recursive: true });
      cpSync(planFile, path.join(dir, "plan", path.basename(planFile)));
    } else {
      warnings.push(`plan file for ${meta.planId} is missing; bundle exported without the plan`);
    }
  }

  // 4. The full transition diff (revisions are meaningless without the
  // patch; the stat alone lives in summary.md).
  const base = view.state.baseRevision ?? meta.baseRevision;
  const result = view.state.resultRevision;
  if (base && result) {
    writeFileSync(path.join(dir, "diff.patch"), diffPatch(repoRoot, base, result, 16 * 1024 * 1024), "utf8");
  } else {
    warnings.push("run has no base..result revision range (verify run or incomplete execution); no diff exported");
  }

  // 5. Config as of EXPORT (policy decisions at run time are not
  // recorded; approval resolutions live in the run's followups).
  if (existsSync(paths.configPath)) {
    cpSync(paths.configPath, path.join(dir, "config.yaml"));
  }

  // 6. Manifest: hash every component so the bundle is auditable
  // standalone. The manifest itself is written last and not hashed.
  const components = walkFiles(dir)
    .sort()
    .map((file) => ({ path: path.relative(dir, file), sha256: fileSha256(file) }));
  const manifest = {
    schema: "spc-run-export/1",
    exportedAt: new Date().toISOString(),
    runId,
    kind: meta.kind,
    specId: meta.specId,
    specDigest: meta.specDigest,
    ...(meta.planId ? { planId: meta.planId } : {}),
    ...(meta.planDigest ? { planDigest: meta.planDigest } : {}),
    ...(base ? { baseRevision: base } : {}),
    ...(result ? { resultRevision: result } : {}),
    runStatus: view.state.status,
    configNote: "config.yaml is the repository config as of export, not as of run",
    ...(warnings.length > 0 ? { warnings } : {}),
    components,
  };
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { dir, manifestPath, warnings };
}
