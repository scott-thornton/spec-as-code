import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "@spc/repo";

/**
 * Scope-addressed cross-invocation command cache (specs/verify-cache).
 * A whole-tree key would never hit - every push follows a commit. The
 * filter in a pnpm criteria command NAMES the packages; the entry keys
 * on (command, digest of the filter's packages + workspace deps
 * tracked sources, digest of those packages' dist artifacts). Reuse
 * holds exactly when re-execution would be a deterministic no-op:
 * source change in scope = miss; unrelated package = hit; dist deleted
 * or tampered = miss; dist rebuilt identically = hit. Unscoped
 * commands are never cached. The cache file is plain data, gitignored,
 * never evidence - audit precision flows through execution identity
 * (COMMAND_RESULT_REUSED, origin: cache).
 */

export interface CacheScope {
  packages: string[] | null; // null = whole workspace (-r)
  withDeps: boolean;
}

export interface CachedRunResult {
  executionId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CacheEntry {
  scopeKey: string;
  sourceDigest: string;
  distDigest: string;
  result: CachedRunResult;
  recordedAt: string;
}

/**
 * Parse the effective filter scope of a command; null = unscoped, never
 * cached. Compound commands AGGREGATE across all segments
 * (specs/suite-references, SR-006): any recursive pnpm invocation (-r
 * or --recursive) anywhere in the compound reads the whole workspace
 * and dominates; --filter specs union across segments (sorted, so the
 * scopeKey is deterministic); a ... deps form anywhere widens withDeps
 * for the aggregate; segments that are not pnpm invocations (grep -r,
 * node scripts) contribute nothing. The previous last-filter-wins scan
 * under-scoped compounds whose pnpm -r prefix reads the whole
 * workspace to the final --filter package - a possible false cache
 * hit; when in doubt this parser falls BROADER, never narrower.
 */
export function parseFilterScope(command: string): CacheScope | null {
  const segments = command.trim().split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  let packages: string[] | null = null;
  let withDeps = false;
  let sawScope = false;
  let sawRecursive = false;
  const filters: string[] = [];
  for (const segment of segments) {
    const tokens = segment.split(/\s+/);
    if (tokens[0] !== "pnpm") continue; // non-pnpm segments contribute nothing
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === "-r" || t === "--recursive") {
        sawRecursive = true;
        sawScope = true;
        continue;
      }
      let spec: string | undefined;
      if (t.startsWith("--filter=")) {
        spec = t.slice("--filter=".length);
      } else if (t === "--filter" && i + 1 < tokens.length) {
        spec = tokens[i + 1]!;
        i += 1;
      }
      if (spec !== undefined) {
        if (spec.endsWith("...")) {
          filters.push(spec.slice(0, -3));
          withDeps = true;
        } else {
          filters.push(spec);
        }
        sawScope = true;
      }
    }
  }
  if (!sawScope) return null;
  if (sawRecursive) return { packages: null, withDeps: true };
  packages = [...new Set(filters)].sort();
  return { packages, withDeps };
}

/** Read the workspace package directories from pnpm-workspace.yaml globs. */
export function workspacePackageDirs(root: string): Map<string, string> {
  const byName = new Map<string, string>();
  const wsFile = path.join(root, "pnpm-workspace.yaml");
  if (!existsSync(wsFile)) {
    // Single-package repo: the root package itself.
    const pj = path.join(root, "package.json");
    if (existsSync(pj)) {
      const name = (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name;
      if (name) byName.set(name, root);
    }
    return byName;
  }
  const globs: string[] = [];
  for (const line of readFileSync(wsFile, "utf8").split("\n")) {
    const m = /^\s*-\s*(\S+)/.exec(line);
    if (m) globs.push(m[1]!);
  }
  for (const glob of globs) {
    // Minimal glob handling: prefix/* and literal dirs.
    const star = glob.indexOf("*");
    const candidates: string[] = [];
    if (star === -1) {
      candidates.push(path.join(root, glob));
    } else {
      const prefix = glob.slice(0, star);
      const dir = path.join(root, prefix);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory() && existsSync(path.join(full, "package.json"))) candidates.push(full);
      }
    }
    for (const dir of candidates) {
      const pj = path.join(dir, "package.json");
      if (!existsSync(pj)) continue;
      const name = (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name;
      if (name) byName.set(name, dir);
    }
  }
  return byName;
}

/** Resolve the scope's package directories, closing over workspace deps. */
export function resolveScopeDirs(root: string, scope: CacheScope): string[] {
  const byName = workspacePackageDirs(root);
  if (scope.packages === null) return [...new Set(byName.values())];
  const dirs: string[] = [];
  const queue = [...scope.packages];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = byName.get(name);
    if (!dir) continue; // not a workspace member (or an external dep): no files
    dirs.push(dir);
    if (!scope.withDeps) continue;
    const pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const deps of [pj.dependencies, pj.devDependencies]) {
      for (const [dep, spec] of Object.entries(deps ?? {})) {
        if (String(spec).startsWith("workspace:") && !seen.has(dep)) queue.push(dep);
      }
    }
  }
  return [...new Set(dirs)];
}

function digestOfContent(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

/** Tracked files under the scope dirs (git ls-files), sorted, excluding node_modules and dist. */
export function trackedFiles(root: string, dirs: string[]): string[] {
  if (dirs.length === 0) return [];
  const r = git(root, ["ls-files"]);
  if (!r.ok) return [];
  const prefixes = dirs.map((d) => path.relative(root, d) + path.sep);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("node_modules") && !f.split(path.sep).includes("dist"))
    .filter((f) => prefixes.some((p) => f.startsWith(p) || f + path.sep === p.slice(0, -1)))
    .sort();
}

/** Digest of the tracked source files in scope (contents in sorted path order). */
function sourceDigest(root: string, dirs: string[]): string {
  const files = trackedFiles(root, dirs);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\u0000");
    h.update(readFileSync(path.join(root, f)));
    h.update("\u0000");
  }
  return "sha256:" + h.digest("hex");
}

/** Digest of the dist trees in scope (or "absent" when none exist). */
function distDigest(root: string, dirs: string[]): string {
  const h = createHash("sha256");
  let any = false;
  const walk = (dir: string, rel: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const relPath = rel ? rel + "/" + entry : entry;
      if (statSync(full).isDirectory()) {
        walk(full, relPath);
      } else {
        any = true;
        h.update(relPath);
        h.update("\u0000");
        h.update(readFileSync(full));
        h.update("\u0000");
      }
    }
  };
  for (const d of dirs) walk(path.join(d, "dist"), "dist");
  return any ? "sha256:" + h.digest("hex") : "absent";
}

/**
 * The persisted cache. Load tolerates a corrupt or absent file as
 * empty; persist writes the whole map (small). Plain data - never
 * evidence; gitignored by convention (.spc/cache/).
 */
export class CommandCache {
  private entries = new Map<string, CacheEntry>();
  private readonly root: string;
  private readonly file: string;

  constructor(root: string, file: string) {
    this.root = root;
    this.file = file;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) this.entries.set(k, v);
    } catch {
      // absent or corrupt: treated as empty
    }
  }

  /** Record an executed result under the command's current scope digests. */
  record(command: string, result: CachedRunResult): void {
    const scope = parseFilterScope(command);
    if (!scope) return; // unscoped commands are never cached
    const dirs = resolveScopeDirs(this.root, scope);
    const scopeKey = JSON.stringify({ packages: scope.packages, withDeps: scope.withDeps });
    this.entries.set(command, {
      scopeKey,
      sourceDigest: sourceDigest(this.root, dirs),
      distDigest: distDigest(this.root, dirs),
      result,
      recordedAt: new Date().toISOString(),
    });
  }

  /** A valid entry iff the command's CURRENT digests equal the recorded ones. */
  reusable(command: string): CachedRunResult | null {
    const entry = this.entries.get(command);
    if (!entry) return null;
    const scope = parseFilterScope(command);
    if (!scope) return null;
    if (JSON.stringify({ packages: scope.packages, withDeps: scope.withDeps }) !== entry.scopeKey) return null;
    const dirs = resolveScopeDirs(this.root, scope);
    if (sourceDigest(this.root, dirs) !== entry.sourceDigest) return null;
    if (distDigest(this.root, dirs) !== entry.distDigest) return null;
    return entry.result;
  }

  persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of this.entries) obj[k] = v;
    writeFileSync(this.file, JSON.stringify(obj, null, 1), "utf8");
  }
}
