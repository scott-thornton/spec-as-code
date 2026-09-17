import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { digestOf, globMatchAny } from "@spc/core";
import type { RepositorySnapshot, SpecIR } from "@spc/schema";
import { currentRevision, statusPorcelain } from "./git.js";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".spc",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  "target",
  ".idea",
  ".vscode",
]);

const MAX_ENTRIES = 4000;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 64 * 1024;

interface WalkState {
  entries: number;
}

function walk(
  root: string,
  relDir: string,
  depth: number,
  state: WalkState,
  visit: (relPath: string, isDir: boolean) => void,
): void {
  if (depth > MAX_DEPTH || state.entries > MAX_ENTRIES) return;
  let names: string[];
  try {
    names = readdirSync(path.join(root, relDir));
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    if (state.entries > MAX_ENTRIES) return;
    state.entries++;
    const rel = relDir === "" ? name : `${relDir}/${name}`;
    let isDir = false;
    try {
      isDir = statSync(path.join(root, rel)).isDirectory();
    } catch {
      continue;
    }
    visit(rel, isDir);
    if (isDir) walk(root, rel, depth + 1, state, visit);
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".sh": "shell",
  ".sql": "sql",
  ".css": "css",
  ".html": "html",
};

const MANIFEST_FILES: Record<string, string> = {
  "package.json": "npm",
  "go.mod": "go",
  "Cargo.toml": "cargo",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "pom.xml": "maven",
  "Gemfile": "ruby",
  "composer.json": "composer",
};

function looksLikeTestPath(rel: string): boolean {
  const base = path.posix.basename(rel);
  return (
    rel.startsWith("tests/") ||
    rel.startsWith("test/") ||
    rel.includes("/__tests__/") ||
    /\.test\.[cm]?[jt]s$/.test(base) ||
    /\.spec\.[cm]?[jt]s$/.test(base) ||
    /_test\.(go|py)$/.test(base) ||
    /_test\.[cm]?[jt]s$/.test(base)
  );
}

/**
 * Build a bounded repository snapshot. Deterministic heuristics only:
 * no embeddings, no semantic search, never the full repository contents.
 */
export function observeRepository(
  repoRoot: string,
  ir: SpecIR | null,
  now = (): string => new Date().toISOString(),
): RepositorySnapshot {
  const state: WalkState = { entries: 0 };
  const files: string[] = [];
  const dirs: { path: string; entryCount: number }[] = [];
  const rootCounts = new Map<string, number>();

  walk(repoRoot, "", 0, state, (rel, isDir) => {
    if (isDir) {
      dirs.push({ path: rel, entryCount: 0 });
      const top = rel.split("/")[0] ?? rel;
      rootCounts.set(top, (rootCounts.get(top) ?? 0) + 1);
    } else {
      files.push(rel);
      const top = rel.split("/")[0] ?? rel;
      rootCounts.set(top, (rootCounts.get(top) ?? 0) + 1);
    }
  });

  const languages = new Map<string, number>();
  for (const f of files) {
    const ext = path.posix.extname(f).toLowerCase();
    const lang = LANGUAGE_BY_EXTENSION[ext];
    if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1);
  }

  const manifests: RepositorySnapshot["manifests"] = [];
  for (const [name, kind] of Object.entries(MANIFEST_FILES)) {
    const full = path.join(repoRoot, name);
    if (!existsSync(full)) continue;
    const entry: RepositorySnapshot["manifests"][number] = { path: name, kind };
    try {
      if (kind === "npm") {
        const pkg = JSON.parse(readFileSync(full, "utf8")) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        if (pkg.name) entry.name = pkg.name;
        if (pkg.scripts) entry.scripts = pkg.scripts;
      }
    } catch {
      // unreadable manifest: keep the detection, drop the details
    }
    manifests.push(entry);
  }

  const npmManifest = manifests.find((m) => m.kind === "npm");
  const commands: RepositorySnapshot["commands"] = {};
  if (npmManifest?.scripts) {
    const s = npmManifest.scripts;
    if (s.test) commands.test = `npm test`;
    if (s.build) commands.build = `npm run build`;
    if (s.lint) commands.lint = `npm run lint`;
    if (s.typecheck || s.tsc) commands.typecheck = `npm run ${s.typecheck ? "typecheck" : "tsc"}`;
  }

  const tests = files.filter(looksLikeTestPath).map((p) => ({ path: p }));

  // Relevant artifacts: cheap keyword match against property ids/statements.
  const relevantArtifacts: RepositorySnapshot["relevantArtifacts"] = [];
  if (ir) {
    const tokens = new Set<string>();
    for (const p of ir.properties) {
      for (const part of p.id.split("-")) {
        if (part.length >= 4 && !/^\d+$/.test(part)) tokens.add(part.toLowerCase());
      }
      for (const word of p.statement.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word.length >= 5 && !["users", "should", "system", "which", "their"].includes(word)) {
          tokens.add(word);
        }
      }
    }
    for (const f of files) {
      const lower = f.toLowerCase();
      const hit = [...tokens].find((t) => lower.includes(t));
      if (hit && relevantArtifacts.length < 50) {
        relevantArtifacts.push({ path: f, reason: `matches "${hit}"` });
      }
    }
  }

  const revision = currentRevision(repoRoot);
  const status = statusPorcelain(repoRoot);
  const createdAt = now();

  const snapshot: RepositorySnapshot = {
    revision,
    dirty: status.dirty,
    languages: [...languages.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l),
    manifests,
    directories: dirs.slice(0, 200),
    tests,
    commands,
    relevantArtifacts,
    createdAt,
    digest: "sha256:pending",
  };
  return { ...snapshot, digest: digestOf({ ...snapshot, digest: undefined }) };
}

/** Read a bounded file excerpt for planner/executor context. */
export function readExcerpt(repoRoot: string, relPath: string, maxBytes = MAX_FILE_BYTES): string | null {
  const full = path.join(repoRoot, relPath);
  try {
    if (!statSync(full).isFile()) return null;
    const buf = readFileSync(full);
    const text = buf.subarray(0, maxBytes).toString("utf8");
    return text;
  } catch {
    return null;
  }
}

/** Files in the worktree matching any of the given glob patterns. */
export function listMatchingFiles(repoRoot: string, patterns: readonly string[], limit = 20): string[] {
  const state: WalkState = { entries: 0 };
  const out: string[] = [];
  walk(repoRoot, "", 0, state, (rel, isDir) => {
    if (!isDir && out.length < limit && globMatchAny(patterns, rel)) out.push(rel);
  });
  return out;
}
