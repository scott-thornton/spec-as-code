import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".spc", "dist", "grading", "PLAN.md"]);

/**
 * Bounded repository dump for real-model prompts. Neither arm gets tool
 * access, so both receive the same bounded view of the repository the task
 * ships with — fairness matters more than completeness here.
 */
export function boundedRepoDump(repoDir: string, maxFiles = 14, maxTotalBytes = 24_000): { path: string; content: string }[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || files.length >= maxFiles) return;
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name) || files.length >= maxFiles) continue;
      const full = path.join(dir, name);
      let entry: import("node:fs").Dirent;
      try {
        entry = { isDirectory: () => statSync(full).isDirectory() } as import("node:fs").Dirent;
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else {
        files.push(path.relative(repoDir, full));
      }
    }
  };
  walk(repoDir, 0);

  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const rel of files) {
    const full = path.join(repoDir, rel);
    if (!existsSync(full) || statSync(full).size > 64_000) continue;
    const content = readFileSync(full, "utf8");
    if (total + content.length > maxTotalBytes) break;
    total += content.length;
    out.push({ path: rel, content });
  }
  return out;
}

export function renderRepoDump(dump: { path: string; content: string }[]): string {
  return dump.map((f) => `----- ${f.path} -----\n${f.content}`).join("\n\n");
}
