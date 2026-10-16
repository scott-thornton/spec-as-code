import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { resolveRepoRoot } from "../context.js";

/**
 * Skill registry: markdown files shipped with the CLI (copied from
 * .agents/skills at build time), overridable per repo by placing a
 * .agents/skills/<name>/SKILL.md in the repository. Source of truth is
 * the repo's .agents/skills directory; the bundle is a distribution
 * copy pinned to the CLI version.
 */

export interface SkillEntry {
  name: string;
  description: string;
  file: string;
  origin: "repo" | "bundled";
}

function parseFrontmatter(file: string): { name: string; description: string; body: string } {
  const text = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { name: path.basename(path.dirname(file)), description: "", body: text };
  const front = match[1] ?? "";
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? path.basename(path.dirname(file));
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
  return { name, description, body: (match[2] ?? "").trimStart() };
}

function skillsIn(dir: string, origin: SkillEntry["origin"]): SkillEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => {
      const file = path.join(dir, e.name, "SKILL.md");
      const parsed = parseFrontmatter(file);
      return { name: parsed.name || e.name, description: parsed.description, file, origin };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bundledSkillsDir(): string {
  // dist/commands/skills.js -> package root -> skills/
  return path.resolve(import.meta.dirname, "..", "..", "skills");
}

export function listSkills(cwd?: string): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const s of skillsIn(bundledSkillsDir(), "bundled")) byName.set(s.name, s);
  try {
    const repoRoot = resolveRepoRoot(cwd);
    // Repo-local skills override bundled copies by name.
    for (const s of skillsIn(path.join(repoRoot, ".agents", "skills"), "repo")) byName.set(s.name, s);
  } catch {
    // Outside a repo: bundled skills only.
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(name: string, cwd?: string): SkillEntry {
  const found = listSkills(cwd).find((s) => s.name === name);
  if (!found) {
    throw new SpcError("SKILL_NOT_FOUND", `no skill named "${name}"; run: spc skills`);
  }
  return found;
}

export function runSkills(cwd?: string): number {
  const skills = listSkills(cwd);
  if (skills.length === 0) {
    console.log("No skills found.");
    return 0;
  }
  for (const s of skills) {
    const origin = s.origin === "repo" ? " (repo-local)" : "";
    console.log(`- ${s.name}${origin}`);
    if (s.description) console.log(`  ${s.description}`);
  }
  console.log("\nPrint one with: spc use-skill <name>");
  return 0;
}

export function runUseSkill(name: string, cwd?: string): number {
  const skill = loadSkill(name, cwd);
  console.log(parseFrontmatter(skill.file).body);
  return 0;
}
