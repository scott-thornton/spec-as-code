import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { git } from "./git.js";

/**
 * Oracle scope (specs/oracle-identity, moved here from runtime so the
 * runtime decision layer and the verifier's evidence recording share
 * ONE classifier without import cycles). A criterion command's ORACLE
 * is the file set its command executes; five-way classification,
 * fail-closed: unreferenced is POSITIVE, never a default. Snapshots
 * digest the referenced files AT a revision through the hardened git
 * adapter - never the working tree.
 */

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
    // pnpm-workspace.yaml permits quoted entries (- "packages/*" -
    // this repository's own shape); strip matched surrounding quotes
    // or the glob never resolves and every member starves (found by
    // the oracle-identity audit, pinned in workspace-globs.test.ts).
    if (m) globs.push(m[1]!.replace(/^("[^"]*"|'[^']*')$/, (q) => q.slice(1, -1)));
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

export type OracleClassification =
  | { kind: "unreferenced" }
  | { kind: "referenced"; files: string[] }
  | { kind: "unsupported"; reason: string };

/** Segment rank for worst-segment-wins: unsupported dominates. */
const RANK: Record<OracleClassification["kind"], number> = { unsupported: 3, referenced: 2, unreferenced: 1 };

function classifySegment(segment: string, packageDirs: Map<string, string>): OracleClassification {
  const tokens = segment.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === undefined || tokens[0] === "") {
    return { kind: "unreferenced" }; // empty segment: nothing to execute
  }
  // pnpm segments: --filter resolution
  if (tokens[0] === "pnpm") {
    const filterIdx = tokens.findIndex((t) => t === "--filter" || t.startsWith("--filter="));
    if (filterIdx === -1) {
      return { kind: "unsupported", reason: "pnpm without --filter: instrument discovery-defined" };
    }
    const spec = tokens[filterIdx] === "--filter" ? tokens[filterIdx + 1] : tokens[filterIdx]!.slice("--filter=".length);
    const pkg = (spec ?? "").replace(/\.{2,}$/, "");
    const dir = pkg !== "" ? packageDirs.get(pkg) : undefined;
    const rest = tokens.slice(filterIdx + (tokens[filterIdx] === "--filter" ? 2 : 1)).join(" ");
    // vitest run <file...>
    const vitest = /\bvitest\s+run\b/.exec(rest);
    if (vitest) {
      const after = rest.slice(vitest.index! + vitest[0].length);
      const files = [...after.matchAll(/(?:^|\s)([\w./-]+\.test\.[cm]?[jt]sx?)/g)].map((m) => m[1]!);
      if (files.length === 0) {
        return { kind: "unsupported", reason: "vitest run without explicit test files: discovery-defined" };
      }
      if (dir === undefined) {
        return { kind: "unsupported", reason: `--filter ${pkg} does not resolve to a workspace directory` };
      }
      return { kind: "referenced", files: files.map((f) => path.posix.join(dir, f)) };
    }
    if (/\bexec\s+(node|tsx|ts-node|bash|sh)\b/.test(rest)) {
      if (dir === undefined) {
        return { kind: "unsupported", reason: `--filter ${pkg} does not resolve to a workspace directory` };
      }
      const m = /(?:^|\s)([\w./-]+\.[cm]?[jt]sx?)\b/.exec(rest);
      if (m && !m[1]!.startsWith("/")) {
        return { kind: "referenced", files: [path.posix.join(dir, m[1]!)] };
      }
      if (m && m[1]!.startsWith("/")) {
        return { kind: "referenced", files: [m[1]!.slice(1)] };
      }
      return { kind: "unsupported", reason: "exec with no recognizable script path" };
    }
    if (/\b(typecheck|lint|eslint|prettier)\b/.test(rest)) {
      return { kind: "unsupported", reason: "script-defined tool execution: instrument is config-defined" };
    }
    // A build tail (pnpm --filter X build [> /dev/null]) is positively
    // command-defined - same class as pnpm -r build in the ruling's
    // table: the command string is the whole instrument (no test-file
    // argument claims an oracle). Build prefixes are universal in this
    // repo's compounds; the vitest segment carries the oracle claim.
    if (/^\s*build\b/.test(rest)) {
      return { kind: "unreferenced" };
    }
    if (/\btest\b/.test(rest) || /\brun\s+\S+/.test(rest)) {
      // package test scripts / run scripts: the instrument is the
      // script definition (package.json) + discovery - unsupported.
      return { kind: "unsupported", reason: "package script execution: instrument is script-defined, not command-only" };
    }
    // POSITIVE command-only: a bare --filter with NOTHING after it -
    // no subcommand, no script - executes nothing. Every other
    // unrecognized tail is unsupported (never defaulted open).
    if (rest.trim() === "") return { kind: "unreferenced" };
    return { kind: "unsupported", reason: `pnpm tail not classified: ${rest.trim().split(/\s+/)[0]}` };
  }
  // node-executed repo scripts: referenced
  if (tokens[0] === "node") {
    // node --test runs the native test runner (file-backed) - unsupported
    // unless the file grammar resolves; node -e/--eval/no-args executes no
    // repo file - POSITIVELY command-only; anything else fails closed.
    if (tokens[1] === "-e" || tokens[1] === "--eval" || tokens[1] === undefined) {
      return { kind: "unreferenced" };
    }
    // node --test with EXPLICIT files or shell globs (a deterministic
    // set once resolved against the tree at a revision; the snapshot
    // machinery expands globs via git ls-tree): the files are the
    // instrument. Discovery mode (no arguments) is unsupported - the
    // instrument is discovery-defined.
    if (tokens.includes("--test")) {
      const files = tokens
        .slice(2)
        .map((t) => t.replace(/"/g, ""))
        .filter((t) => /^[\w.*/-]+\.[cm]?[jt]sx?$/.test(t));
      if (files.length > 0) return { kind: "referenced", files };
      return { kind: "unsupported", reason: "node --test discovery mode: instrument is discovery-defined" };
    }
    const m = /^"?([\w./-]+\.[cm]?[jt]sx?)"?/.exec(tokens[1] ?? "");
    if (m) {
      return { kind: "referenced", files: [m[1]!] };
    }
    return { kind: "unsupported", reason: `node invocation not classified (flags: ${tokens.slice(1, 4).join(" ")})` };
  }
  // Positively command-only shell: a BARE test/[ with simple flags
  // observes the tree, it does not execute repo files. Command
  // substitution ($(...)), pipes, or redirections make the grammar
  // unclassifiable - unsupported, fail closed.
  if ((tokens[0] === "test" || tokens[0] === "[") && !/[|$`]/.test(segment)) {
    return { kind: "unreferenced" };
  }
  // Everything else: unsupported (fail closed)
  return { kind: "unsupported", reason: `grammar not classified: ${tokens[0]}` };
}

export function classifyCommandOracle(command: string, packageDirs: Map<string, string>): OracleClassification {
  const segments = command.trim().split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  const classified = segments.map((s) => classifySegment(s, packageDirs));
  if (classified.length === 0) return { kind: "unreferenced" };
  let worst = classified[0]!;
  for (const c of classified) {
    if (RANK[c.kind] > RANK[worst.kind]) worst = c;
  }
  // Referenced compounds merge their file lists.
  if (worst.kind === "referenced") {
    const files = classified.flatMap((c) => (c.kind === "referenced" ? c.files : []));
    return { kind: "referenced", files: [...new Set(files)] };
  }
  return worst;
}

export interface OracleFileSnapshot {
  path: string;
  digest: string;
}

export interface OracleSnapshot {
  criterionDigest?: string;
  revision: string;
  files: OracleFileSnapshot[];
}

/** Snapshot the referenced oracle files AT a revision (hardened git
 *  adapter; never the working tree). null = command-only (positively
 *  unreferenced); undefined = classification fail-closed. */
/** Resolve a file list at a revision: literals pass through; glob
 *  entries (containing *) expand against the tree at the revision via
 *  git ls-tree. Returns undefined when a glob matches nothing (fail
 *  closed - an empty instrument set is a classification failure). */
export function expandOracleFiles(repoRoot: string, revision: string, files: readonly string[]): string[] | undefined {
  const resolved: string[] = [];
  for (const file of files) {
    if (!file.includes("*")) {
      resolved.push(file);
      continue;
    }
    const slashBeforeStar = file.lastIndexOf("/", file.indexOf("*"));
    const dirPrefix = slashBeforeStar >= 0 ? file.slice(0, slashBeforeStar + 1) : "";
    const listing = git(repoRoot, ["ls-tree", "-r", "--name-only", revision, ...(dirPrefix ? [dirPrefix] : [])]);
    if (!listing.ok) return undefined;
    const pattern = new RegExp("^" + file.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
    const matched = listing.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => pattern.test(l));
    if (matched.length === 0) return undefined;
    resolved.push(...matched);
  }
  return [...new Set(resolved)];
}

export function oracleSnapshotAt(
  repoRoot: string,
  revision: string,
  command: string,
  packageDirs: Map<string, string>,
): OracleSnapshot | null | undefined {
  const classification = classifyCommandOracle(command, packageDirs);
  if (classification.kind === "unreferenced") return null;
  if (classification.kind === "unsupported") return undefined;
  const resolved = expandOracleFiles(repoRoot, revision, classification.files);
  if (resolved === undefined) return undefined;
  const files: OracleFileSnapshot[] = [];
  for (const file of resolved) {
    const show = git(repoRoot, ["show", `${revision}:${file}`]);
    if (!show.ok) return undefined; // unresolved at this revision: fail closed
    files.push({ path: file, digest: "sha256:" + createHash("sha256").update(show.stdout, "utf8").digest("hex") });
  }
  return { revision, files };
}
