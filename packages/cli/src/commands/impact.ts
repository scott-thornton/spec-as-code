import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { compileSpecFile, git, loadSuiteRegistry } from "@spc/repo";
import { parseFilterScope, resolveScopeDirs, trackedFiles, workspacePackageDirs } from "@spc/verifier";
import { resolveRepoRoot } from "../context.js";

/**
 * `spc impact <baseRev>..<headRev>` (specs/evidence-impact-report):
 * a READ-ONLY projection of which recorded observations a revision
 * range may touch. The derivation is the same one the system already
 * trusts - git diff --name-only -z --no-renames for the changed
 * tracked paths (fail-closed: an uncomputable range exits non-zero
 * with the git error surfaced, never an empty report - the
 * diff-scoped-verify F1 lesson), parseFilterScope's declared scopes
 * and trackedFiles for command criteria, exact path membership for
 * file criteria. Disjoint is asserted ONLY from complete, declared
 * structural scopes: a changed path inside a scope directory but
 * outside the declared file set (the node_modules/dist filters) is
 * undetermined; the workspace-DEFINING root files are inside every
 * workspace-union scope (pnpm -r closures are defined by them); a
 * declared package or workspace dependency that does not resolve
 * makes the scope incomplete - undetermined, never speculative
 * disjointness. Impact executes no criteria (no subprocess beyond
 * git, no admission lock), writes nothing, and creates no run
 * record: it is a view, not an authority for satisfaction.
 */

type Projection = "scope-intersected" | "scope-disjoint" | "undetermined";

/** The root files that define a pnpm workspace closure: a change to
 *  any of them affects every workspace-union scope (packages: null). */
const WORKSPACE_DEFINING = ["pnpm-workspace.yaml", "package.json", "pnpm-lock.yaml", ".npmrc", ".pnpmfile.cjs"];

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

function normalizeRel(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

function projectCriterion(
  criterion: CriterionLike,
  changedSet: ReadonlySet<string>,
  repoRoot: string,
  suites: Map<string, { command: string }> | null,
  suitesLoadFailed: boolean,
): ProjectionResult {
  if (criterion.type === "file" && typeof criterion.path === "string") {
    const criterionPath = normalizeRel(criterion.path);
    for (const changed of changedSet) {
      if (normalizeRel(changed) === criterionPath) {
        return { projection: "scope-intersected", source: `touched path ${criterion.path}` };
      }
    }
    return { projection: "scope-disjoint", source: `untouched path ${criterion.path}` };
  }
  if (criterion.type === "command" || criterion.type === "suite") {
    let command: string | undefined;
    if (criterion.type === "command") {
      command = typeof criterion.command === "string" ? criterion.command : undefined;
    } else if (suitesLoadFailed) {
      return { projection: "undetermined", source: "suite registry failed to load - suite references cannot be resolved" };
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
    // Completeness of the declared scope: every declared package (and,
    // for ... closures, every workspace: dependency) must resolve -
    // a silent drop shrinks the scope and could fabricate disjoint.
    const byName = workspacePackageDirs(repoRoot);
    if (scope.packages !== null) {
      const unresolved = scope.packages.filter((n) => !byName.has(n));
      if (unresolved.length > 0) {
        return {
          projection: "undetermined",
          source: `declared package(s) do not resolve in the workspace: ${unresolved.join(", ")}`,
        };
      }
      if (scope.withDeps) {
        const seen = new Set<string>(scope.packages);
        const queue = [...scope.packages];
        while (queue.length > 0) {
          const name = queue.shift()!;
          const dir = byName.get(name)!;
          let pj: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          try {
            pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as typeof pj;
          } catch {
            return { projection: "undetermined", source: `workspace member ${name} has an unreadable package.json` };
          }
          for (const deps of [pj.dependencies, pj.devDependencies]) {
            for (const [dep, spec] of Object.entries(deps ?? {})) {
              if (!String(spec).startsWith("workspace:")) continue;
              if (!byName.has(dep)) {
                return {
                  projection: "undetermined",
                  source: `workspace dependency ${dep} (of ${name}) does not resolve in the workspace`,
                };
              }
              if (!seen.has(dep)) {
                seen.add(dep);
                queue.push(dep);
              }
            }
          }
        }
      }
    }
    // A workspace-union scope's closure is DEFINED by the workspace
    // root config: a change there is inside the scope.
    if (scope.packages === null) {
      const defining = [...changedSet].filter((c) => WORKSPACE_DEFINING.includes(c));
      if (defining.length > 0) {
        return {
          projection: "scope-intersected",
          source: `workspace-defining file ${defining[0]} changed - the workspace closure is defined by it`,
        };
      }
    }
    const dirs = resolveScopeDirs(repoRoot, scope);
    const files = trackedFiles(repoRoot, dirs);
    if (files.length === 0) {
      return { projection: "undetermined", source: "declared scope resolves to no tracked files" };
    }
    const intersected = files.find((f) => changedSet.has(f));
    if (intersected !== undefined) {
      const pkgNames = (scope.packages ?? ["workspace"]).join(", ");
      return { projection: "scope-intersected", source: `declared scope (${pkgNames}) - ${intersected} changed` };
    }
    // A changed path INSIDE a scope directory but outside the declared
    // file set (the node_modules/dist filters): the set is incomplete,
    // disjointness is not provable.
    const dirPrefixes = dirs.map((d) => (path.relative(repoRoot, d) + path.sep).split(path.sep).join("/"));
    const shadowed = [...changedSet].find((c) => dirPrefixes.some((p) => c.startsWith(p)));
    if (shadowed !== undefined) {
      return {
        projection: "undetermined",
        source: `changed path ${shadowed} lies inside the scope directory but outside its declared file set - disjointness not provable`,
      };
    }
    const pkgNames = (scope.packages ?? ["workspace"]).join(", ");
    return { projection: "scope-disjoint", source: `declared scope (${pkgNames}) untouched by the range` };
  }
  if (criterion.type === "agent" || criterion.type === "human") {
    return { projection: "undetermined", source: "declares no structural scope" };
  }
  return { projection: "undetermined", source: `unknown criterion type ${String(criterion.type)}` };
}

interface RunMetaLite {
  runId: string;
  specId?: string;
  kind?: string;
  createdAt?: string;
  supersedesRunId?: string;
}

/** Newest apply run per spec (any run when none is an apply; apply
 *  kind dominates regardless of dates, ties broken by runId), and its
 *  criterionId -> evidence ids map from evidence.jsonl. Superseded
 *  runs provide nothing (chain-memory's contract). Read-only. */
function recordedEvidenceIdentities(runsDir: string): Map<string, Map<string, string[]>> {
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
  const superseded = new Set<string>();
  for (const meta of metas) {
    if (typeof meta.supersedesRunId === "string" && meta.supersedesRunId !== "") superseded.add(meta.supersedesRunId);
  }
  const score = (m: RunMetaLite): number =>
    (m.kind === "apply" ? 1e15 : 0) + (Number.isFinite(Date.parse(m.createdAt ?? "")) ? Date.parse(m.createdAt ?? "") : 0);
  const newest = new Map<string, RunMetaLite>();
  for (const meta of metas) {
    if (!meta.specId || superseded.has(meta.runId)) continue;
    const prev = newest.get(meta.specId);
    if (prev === undefined || score(meta) > score(prev) || (score(meta) === score(prev) && meta.runId > prev.runId)) {
      newest.set(meta.specId, meta);
    }
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
  // A three-dot range is git's symmetric difference and would silently
  // re-parse here as base ".head" - rejected by name, never guessed.
  if (rangeArg.includes("...")) {
    console.error("error SPC_IMPACT_RANGE: three-dot ranges are not supported; use exactly two dots (<baseRev>..<headRev>)");
    return 1;
  }
  const sep = rangeArg.indexOf("..");
  const base = sep > 0 ? rangeArg.slice(0, sep) : "";
  const head = sep >= 0 && sep + 2 <= rangeArg.length ? rangeArg.slice(sep + 2) : "";
  if (!base || !head) {
    console.error("error SPC_IMPACT_RANGE: expected <baseRev>..<headRev>");
    return 1;
  }
  // Fail-closed: an uncomputable range surfaces the git error and
  // exits non-zero - an empty changed-set must never be manufactured.
  const diffRun = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", base, head]);
  if (!diffRun.ok) {
    console.error(`error SPC_IMPACT_RANGE: git diff ${base}..${head} failed: ${(diffRun.stderr.trim() || diffRun.stdout.trim())}`);
    return 1;
  }
  const changed = diffRun.stdout.split("\0").filter(Boolean);
  const changedSet = new Set(changed);

  const specsDir = path.join(repoRoot, "specs");
  const compiled: { id: string; properties: { id: string; acceptance: CriterionLike[] }[] }[] = [];
  const skippedSpecs: string[] = [];
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
        } else {
          skippedSpecs.push(f);
        }
      } catch {
        skippedSpecs.push(f);
      }
    }
  }
  // An uncompilable spec is never silently absent from an exit-0
  // report: the gap is named on stderr.
  if (skippedSpecs.length > 0) {
    console.error(`warning: ${skippedSpecs.length} spec file(s) did not compile and are not covered by this report: ${skippedSpecs.join(", ")}`);
  }

  let suites: Map<string, { command: string }> | null = null;
  let suitesLoadFailed = false;
  try {
    suites = loadSuiteRegistry(repoRoot);
  } catch {
    suitesLoadFailed = true; // distinct from an unresolvable ref: the registry itself failed
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
        const { projection, source } = projectCriterion(criterion, changedSet, repoRoot, suites, suitesLoadFailed);
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
