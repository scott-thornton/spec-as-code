import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSpecFile, git } from "@spc/repo";
import { isEligibleRed } from "@spc/verifier";

/**
 * Fork-crossing flip memory (specs/chain-memory). Lineage stays
 * same-digest by design - a chain is one contract's history - but
 * MEMORY must not stop at the fork: a criterion that passes at this
 * run's base keeps an established red -> green flip recorded by any
 * prior apply run of the same spec under ANY digest, provided the
 * criterion's compiled DEFINITION is byte-identical to the one whose
 * flip was recorded. The gate's authoritative source is the spec
 * compiled at each ancestor's recorded base revision (CHMEM-001's
 * letter - the committed tree the run started from, not necessarily
 * the bytes the run finished with). Chronology is not causality:
 * sources are git-ancestors ordered by creation time, red strictly
 * precedes green, oracle-invalid reds establish nothing (isEligibleRed
 * - the same semantics as same-run adoption), and a green that
 * precedes its red establishes nothing (the regression shape).
 * Superseded runs provide no memory (spc run supersede: no ancestry,
 * no evidence inheritance). Absence of memory never fabricates any.
 *
 * Known limitation (adversarial pass on run-mw8eh0db, recorded in the
 * review log): specs using imports: compile relative to the importing
 * file, so a spec relocated to the scratch dir fails SPC1007 and its
 * runs are conservatively skipped as sources.
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
  /** criterionId -> digest of its compiled definition in the spec at
   *  this run's base revision. Absent (unresolvable revision,
   *  uncompilable spec) means the source is skipped conservatively. */
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

export interface SourceMetaInput {
  runId: string;
  specId?: string;
  kind?: string;
  baseRevision?: string;
  createdAt?: string;
  /** Set on the SUPERSEDING run: it administratively replaces this id. */
  supersedesRunId?: string;
}

/** Which prior runs may serve as flip-memory sources, as a pure
 *  selection so the contract is oracle-pinnable: same spec; apply kind
 *  (directory-prefix fallback only for legacy metas without kind);
 *  baseRevision and createdAt both present (chronology that cannot be
 *  established cannot be trusted - a string fallback could invert red
 *  and green); baseRevision a git ancestor of the current base;
 *  NEVER a superseded run (spc run supersede promises no ancestry and
 *  no evidence inheritance); never the current run. Selected sources
 *  are ordered by createdAt with runId as the tiebreak. */
export function selectFlipSourceMetas(
  metas: readonly SourceMetaInput[],
  options: { specId: string; currentRunId: string; baseRevision: string; isAncestor: (rev: string) => boolean },
): SourceMetaInput[] {
  const superseded = new Set<string>();
  for (const m of metas) {
    if (typeof m.supersedesRunId === "string" && m.supersedesRunId !== "") superseded.add(m.supersedesRunId);
  }
  const selected: SourceMetaInput[] = [];
  for (const m of metas) {
    if (m.runId === options.currentRunId) continue;
    if (m.kind !== undefined ? m.kind !== "apply" : !m.runId.startsWith("run-")) continue;
    if (m.specId !== options.specId) continue;
    if (typeof m.baseRevision !== "string" || m.baseRevision === "") continue;
    if (typeof m.createdAt !== "string" || m.createdAt === "") continue;
    if (!options.isAncestor(m.baseRevision)) continue; // chronology is not causality
    if (superseded.has(m.runId)) continue; // administratively disqualified
    selected.push(m);
  }
  selected.sort((a, b) => {
    const at = a.createdAt as string;
    const bt = b.createdAt as string;
    if (at !== bt) return at < bt ? -1 : 1;
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
  return selected;
}

interface RunMetaLite extends SourceMetaInput {
  runId: string;
}

/** The criterion-definition digests for the spec at `revision`:
 *  enumerate the specs/ yaml tree at that revision, read and compile
 *  each candidate until one matches `specId`, digest every acceptance
 *  criterion. Unresolvable or uncompilable => undefined (the caller
 *  skips the source conservatively). All git through the repo's
 *  hardened adapter (git-deadline SIGKILL budget, 32MB buffer). */
function criterionDigestsAt(
  repoRoot: string,
  revision: string,
  specId: string,
  scratch: string,
): Map<string, string> | undefined {
  const tree = git(repoRoot, ["ls-tree", "-r", "--name-only", revision, "specs/"]);
  if (!tree.ok) return undefined;
  const candidates = tree.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  for (const file of candidates) {
    const show = git(repoRoot, ["show", `${revision}:${file}`]);
    if (!show.ok) continue;
    const tmp = path.join(scratch, `spec-${createHash("sha256").update(file).digest("hex").slice(0, 12)}.yaml`);
    try {
      writeFileSync(tmp, show.stdout, "utf8");
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

/** Prior apply runs of the same specId under ANY digest, selected and
 *  ordered by selectFlipSourceMetas (supersession, chronology, kind,
 *  ancestry), each carrying its evidence records and the criterion
 *  digests of the spec at its own base revision. Failed runs are valid
 *  sources: the gate is evidence eligibility, not run status. */
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
      if (!entry.isDirectory()) continue;
      const metaFile = path.join(runsDir, entry.name, "metadata.json");
      if (!existsSync(metaFile)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf8")) as RunMetaLite;
        meta.runId = entry.name;
        metaById.set(entry.name, meta);
      } catch {
        // unreadable metadata: not a source
      }
    }
    const selected = selectFlipSourceMetas([...metaById.values()], {
      specId,
      currentRunId,
      baseRevision,
      isAncestor: (rev) => git(repoRoot, ["merge-base", "--is-ancestor", rev, baseRevision]).ok,
    });
    const sources: AncestorFlipSource[] = [];
    for (const meta of selected) {
      const evidenceFile = path.join(runsDir, meta.runId, "evidence.jsonl");
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
        runId: meta.runId,
        criterionDigests: criterionDigestsAt(repoRoot, meta.baseRevision as string, specId, scratch),
        records,
      });
    }
    return sources;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
