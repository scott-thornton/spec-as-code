import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSpecFile } from "@spc/repo";
import { isEligibleRed } from "@spc/verifier";

/**
 * Fork-crossing flip memory (specs/chain-memory). Lineage stays
 * same-digest by design - a chain is one contract's history - but
 * MEMORY must not stop at the fork: a criterion that passes at this
 * run's base keeps an established red -> green flip recorded by any
 * prior apply run of the same spec under ANY digest, provided the
 * criterion's compiled DEFINITION is byte-identical to the one whose
 * flip was recorded. The gate's authoritative source is the spec
 * compiled at each ancestor's recorded base revision, read from git -
 * never the current file, which the amendment changed. Chronology is
 * not causality: sources are git-ancestors ordered by creation time,
 * red strictly precedes green, oracle-invalid reds establish nothing
 * (isEligibleRed - the same semantics as same-run adoption), and a
 * green that precedes its red establishes nothing (the regression
 * shape). Absence of memory never fabricates any.
 */

/** Canonical digest of a compiled acceptance criterion. The memory is
 *  the criterion's, not the id's: type, command or path, expectations,
 *  and the discriminating flag are all part of what the flip claims. */
export function criterionDigestOf(criterion: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(criterion), "utf8").digest("hex");
}

export interface FlipEvidenceRecord {
  criterionId?: string;
  outcome?: string;
  phase?: string;
  payload?: Record<string, unknown>;
}

export interface AncestorFlipSource {
  runId: string;
  /** criterionId -> digest of its compiled definition in the spec AS THIS
   *  RUN RAN IT. Absent (unresolvable revision, uncompilable spec) means
   *  the source is skipped conservatively. */
  criterionDigests?: Map<string, string>;
  records: readonly FlipEvidenceRecord[];
}

/** Compute the flip memory from chronological sources. Per criterion
 *  whose source digest matches the current one: the FIRST eligible red
 *  establishes the red half; the first subsequent green establishes the
 *  flip - the same run yields that run's id (the LIST-001 case), a later
 *  run yields "redRun->greenRun" provenance naming both. */
export function computeChainFlipMemory(
  sources: readonly AncestorFlipSource[],
  currentDigests: ReadonlyMap<string, string>,
): Map<string, string> {
  const firstRed = new Map<string, string>();
  const flips = new Map<string, string>();
  for (const source of sources) {
    const digests = source.criterionDigests;
    for (const record of source.records) {
      const c = record.criterionId;
      if (typeof c !== "string" || c === "") continue;
      if (digests === undefined || digests.get(c) !== currentDigests.get(c)) continue;
      if (record.phase === "red" && record.outcome === "contradicts" && isEligibleRed(record)) {
        if (!firstRed.has(c)) firstRed.set(c, source.runId);
      } else if (record.phase !== "red" && record.outcome === "supports") {
        const red = firstRed.get(c);
        if (red !== undefined && !flips.has(c)) {
          flips.set(c, red === source.runId ? red : `${red}->${source.runId}`);
        }
      }
    }
  }
  return flips;
}

interface RunMetaLite {
  runId?: string;
  specId?: string;
  baseRevision?: string;
  createdAt?: string;
}

/** The criterion-definition digests for the spec AS IT RAN at `revision`:
 *  enumerate the specs/ yaml tree at that revision, git-show and compile
 *  each candidate until one matches `specId`, digest every acceptance
 *  criterion. Unresolvable or uncompilable => undefined (the caller
 *  skips the source conservatively). */
function criterionDigestsAt(
  repoRoot: string,
  revision: string,
  specId: string,
  scratch: string,
): Map<string, string> | undefined {
  const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", revision, "specs/"], { cwd: repoRoot, encoding: "utf8" });
  if (tree.status !== 0) return undefined;
  const candidates = (tree.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  for (const file of candidates) {
    const show = spawnSync("git", ["show", `${revision}:${file}`], { cwd: repoRoot, encoding: "utf8" });
    if (show.status !== 0) continue;
    const tmp = path.join(scratch, `spec-${createHash("sha256").update(file).digest("hex").slice(0, 12)}.yaml`);
    try {
      writeFileSync(tmp, show.stdout ?? "", "utf8");
      const compiled = compileSpecFile(tmp);
      if (!compiled.ok || !compiled.ir || compiled.ir.spec.metadata.id !== specId) continue;
      const digests = new Map<string, string>();
      for (const property of compiled.ir.properties) {
        for (const criterion of property.acceptance) digests.set(criterion.id, criterionDigestOf(criterion));
      }
      return digests;
    } catch {
      // unreadable candidate: next
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return undefined;
}

/** Prior apply runs (runId prefix "run-") of the same specId under ANY
 *  digest whose recorded baseRevision is a git ancestor of the current
 *  base, ordered by createdAt ascending (run id as the tiebreak).
 *  Failed runs are valid sources: the gate is evidence eligibility,
 *  not run status. Verify runs (v- prefix) are excluded
 *  (specs/chain-memory outOfScope). */
export function ancestorFlipSources(
  repoRoot: string,
  runsDir: string,
  specId: string,
  currentRunId: string,
  baseRevision: string,
): AncestorFlipSource[] {
  if (!existsSync(runsDir)) return [];
  const scratch = mkdtempSync(path.join(os.tmpdir(), "spc-chainmem-"));
  try {
    const metaById = new Map<string, RunMetaLite>();
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === currentRunId || !entry.name.startsWith("run-")) continue;
      const metaFile = path.join(runsDir, entry.name, "metadata.json");
      if (!existsSync(metaFile)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf8")) as RunMetaLite;
        metaById.set(entry.name, meta);
      } catch {
        // unreadable metadata: not a source
      }
    }
    const sources: AncestorFlipSource[] = [];
    for (const [runId, meta] of metaById) {
      if (meta.specId !== specId || !meta.baseRevision) continue;
      const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", meta.baseRevision, baseRevision], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (ancestry.status !== 0) continue; // chronology is not causality
      const evidenceFile = path.join(runsDir, runId, "evidence.jsonl");
      let records: FlipEvidenceRecord[] = [];
      if (existsSync(evidenceFile)) {
        try {
          records = readFileSync(evidenceFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as FlipEvidenceRecord);
        } catch {
          records = []; // unreadable evidence: no halves from this run
        }
      }
      sources.push({
        runId,
        criterionDigests: criterionDigestsAt(repoRoot, meta.baseRevision, specId, scratch),
        records,
      });
    }
    sources.sort((a, b) => {
      const at = metaById.get(a.runId)?.createdAt ?? a.runId;
      const bt = metaById.get(b.runId)?.createdAt ?? b.runId;
      return at < bt ? -1 : at > bt ? 1 : 0;
    });
    return sources;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
