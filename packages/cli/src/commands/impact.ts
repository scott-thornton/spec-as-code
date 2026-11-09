import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { compileSpecFile, git, loadSuiteRegistry } from "@spc/repo";
import { parseFilterScope, resolveScopeDirs, trackedFiles } from "@spc/verifier";
import { resolveRepoRoot } from "../context.js";

/**
 * `spc impact <baseRev>..<headRev>` (specs/evidence-impact-report):
 * a READ-ONLY projection of which recorded observations a revision
 * range may touch. The derivation is the same one the system already
 * trusts - git diff --name-only -z --no-renames for the changed
 * tracked paths (fail-closed: an uncomputable range exits non-zero
 * with the git error surfaced, never an empty report - the
 * diff-scoped-verify F1 lesson), parseFilterScope's declared scopes
 * and trackedFiles for command criteria (verify's skip report uses
 * exactly these), exact path membership for file criteria. Disjoint
 * is asserted ONLY from complete, declared structural scopes; an
 * import graph may inform a human, never justify a projection.
 * Everything else - unscoped commands (they declare the whole
 * workspace), empty scopes, unknown types, unresolvable suite
 * references - is undetermined, never speculative disjointness.
 * Impact executes no criteria (no subprocess, no admission lock),
 * writes nothing, and creates no run record: it is a view, not an
 * authority for satisfaction.
 */

type Projection = "scope-intersected" | "scope-disjoint" | "undetermined";

interface CriterionLike {
  id: string;
  type?: string;
  path?: string;
  command?: string;
  ref?: string;
}

interface ProjectionResult {
  projection: Projection;
  source: string;
}

function projectCriterion(
  criterion: CriterionLike,
  changedSet: ReadonlySet<string>,
  repoRoot: string,
  suites: Map<string, { command: string }> | null,
): ProjectionResult {
  if (criterion.type === "file" && typeof criterion.path === "string") {
    if (changedSet.has(criterion.path)) {
      return { projection: "scope-intersected", source: `touched path ${criterion.path}` };
    }
    return { projection: "scope-disjoint", source: `untouched path ${criterion.path}` };
  }
  if (criterion.type === "command" || criterion.type === "suite") {
    let command: string | undefined;
    if (criterion.type === "command") {
      command = typeof criterion.command === "string" ? criterion.command : undefined;
    } else {
      const suite = criterion.ref !== undefined ? suites?.get(criterion.ref) : undefined;
      command = suite?.command;
      if (command === undefined) {
        return { projection: "undetermined", source: `suite reference "${String(criterion.ref)}" does not resolve` };
      }
    }
    if (command === undefined) {
      return { projection: "undetermined", source: "criterion declares no command" };
    }
    const scope = parseFilterScope(command);
    if (scope === null) {
      return { projection: "undetermined", source: "unscoped command declares the whole workspace" };
    }
    const dirs = resolveScopeDirs(repoRoot, scope);
    const files = trackedFiles(repoRoot, dirs);
    if (files.length === 0) {
      return { projection: "undetermined", source: "declared scope resolves to no tracked files" };
    }
    const pkgNames = (scope.packages ?? ["workspace"]).join(", ");
    const intersected = files.find((f) => changedSet.has(f));
    if (intersected !== undefined) {
      return { projection: "scope-intersected", source: `declared scope (${pkgNames}) - ${intersected} changed` };
    }
    return { projection: "scope-disjoint", source: `declared scope (${pkgNames}) untouched by the range` };
  }
  return { projection: "undetermined", source: `unknown criterion type ${String(criterion.type)}` };
}

interface RunMetaLite {
  runId: string;
  specId?: string;
  kind?: string;
  createdAt?: string;
}

/** Newest apply run per spec (any run when none is an apply), and its
 *  criterionId -> evidence ids map from evidence.jsonl. Read-only. */
function recordedEvidenceIdentities(
  runsDir: string,
): Map<string, Map<string, string[]>> {
  const bySpec = new Map<string, Map<string, string[]>>();
  if (!existsSync(runsDir)) return bySpec;
  const metas: RunMetaLite[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaFile = path.join(runsDir, entry.name, "metadata.json");
    if (!existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8")) as RunMetaLite;
      meta.runId = entry.name;
      metas.push(meta);
    } catch {
      // unreadable metadata: not a source
    }
  }
  const newest = new Map<string, RunMetaLite>();
  for (const meta of metas) {
    if (!meta.specId) continue;
    const prev = newest.get(meta.specId);
    const score = (m: RunMetaLite): number => (m.kind === "apply" ? 1 : 0) * 2_000_000_000_000 + Date.parse(m.createdAt ?? "") || 0;
    if (prev === undefined || score(meta) > score(prev)) newest.set(meta.specId, meta);
  }
  for (const [specId, meta] of newest) {
    const evMap = new Map<string, string[]>();
    const evidenceFile = path.join(runsDir, meta.runId, "evidence.jsonl");
    if (existsSync(evidenceFile)) {
      try {
        for (const line of readFileSync(evidenceFile, "utf8").split("\n").filter(Boolean)) {
          const e = JSON.parse(line) as { id?: string; criterionId?: string };
          if (typeof e.criterionId !== "string" || typeof e.id !== "string") continue;
          const list = evMap.get(e.criterionId) ?? [];
          list.push(e.id);
          evMap.set(e.criterionId, list);
        }
      } catch {
        // unreadable evidence: no identities
      }
    }
    bySpec.set(specId, evMap);
  }
  return bySpec;
}

export async function runImpactCommand(rangeArg: string, opts?: { json?: boolean; cwd?: string }): Promise<number> {
  const repoRoot = resolveRepoRoot(opts?.cwd);
  const sep = rangeArg.indexOf("..");
  const base = sep > 0 ? rangeArg.slice(0, sep) : "";
  const head = sep >= 0 && sep + 2 <= rangeArg.length ? rangeArg.slice(sep + 2) : "";
  if (!base || !head) {
    console.error("error IMPACT_RANGE: expected <baseRev>..<headRev>");
    return 1;
  }
  // Fail-closed: an uncomputable range surfaces the git error and
  // exits non-zero - an empty changed-set must never be manufactured.
  const diffRun = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", base, head]);
  if (!diffRun.ok) {
    console.error(`error IMPACT_RANGE: git diff ${base}..${head} failed: ${(diffRun.stderr.trim() || diffRun.stdout.trim())}`);
    return 1;
  }
  const changed = diffRun.stdout.split("\0").filter(Boolean);
  const changedSet = new Set(changed);

  const specsDir = path.join(repoRoot, "specs");
  const compiled: { id: string; properties: { id: string; acceptance: CriterionLike[] }[] }[] = [];
  if (existsSync(specsDir)) {
    for (const f of readdirSync(specsDir).sort()) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      try {
        const c = compileSpecFile(path.join(specsDir, f));
        if (c.ok && c.ir) {
          compiled.push({
            id: c.ir.spec.metadata.id,
            properties: c.ir.properties.map((p) => ({
              id: p.id,
              acceptance: p.acceptance as unknown as CriterionLike[],
            })),
          });
        }
      } catch {
        // unreadable candidate: skip
      }
    }
  }

  let suites: Map<string, { command: string }> | null = null;
  try {
    suites = loadSuiteRegistry(repoRoot);
  } catch {
    suites = null; // unregistered refs project undetermined
  }

  const evidenceBySpec = recordedEvidenceIdentities(path.join(repoRoot, ".spc", "runs"));

  interface Row {
    id: string;
    projection: Projection;
    source: string;
    evidenceIds: string[];
  }
  const specRows: { id: string; criteria: Row[] }[] = [];
  const counts = { intersected: 0, disjoint: 0, undetermined: 0 };
  for (const spec of compiled) {
    const rows: Row[] = [];
    for (const property of spec.properties) {
      for (const criterion of property.acceptance) {
        const { projection, source } = projectCriterion(criterion, changedSet, repoRoot, suites);
        if (projection === "scope-intersected") counts.intersected++;
        else if (projection === "scope-disjoint") counts.disjoint++;
        else counts.undetermined++;
        rows.push({
          id: criterion.id,
          projection,
          source,
          evidenceIds: evidenceBySpec.get(spec.id)?.get(criterion.id) ?? [],
        });
      }
    }
    specRows.push({ id: spec.id, criteria: rows });
  }

  if (opts?.json) {
    console.log(
      JSON.stringify(
        {
          range: `${base}..${head}`,
          changedCount: changed.length,
          changed,
          specs: specRows,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`impact ${base}..${head}`);
  console.log(`changed: ${changed.length} path(s)`);
  for (const p of changed) console.log(`  ${p}`);
  for (const spec of specRows) {
    console.log(`spec ${spec.id}:`);
    for (const row of spec.criteria) {
      const evidence = row.evidenceIds.length > 0 ? `  evidence: ${row.evidenceIds.join(", ")}` : "";
      console.log(`  ${row.id}  ${row.projection}  (${row.source})${evidence}`);
    }
  }
  console.log(
    `summary: ${counts.intersected} scope-intersected, ${counts.disjoint} scope-disjoint, ${counts.undetermined} undetermined`,
  );
  return 0;
}
