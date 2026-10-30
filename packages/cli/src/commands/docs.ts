import { readFileSync } from "node:fs";
import { listSkills } from "./skills.js";

interface CommandLike {
  name(): string;
  description(): string;
}

/**
 * `spc docs` - the pipeline and derived catalogs (specs/pipeline-
 * signposting). The pipeline section renders the pipeline skill's body
 * (single source - the same text spc use-skill prints, never a second
 * authored copy); the commands catalog comes from the CLI's own
 * registrations; the skills catalog from the shipped copies. Derivation
 * is the anti-drift mechanism: docs cannot disagree with what it
 * describes.
 */
export function runDocs(commands: readonly CommandLike[]): number {
  const skills = listSkills();
  const pipeline = skills.find((s) => s.name === "pipeline");
  console.log("# spc docs - the pipeline and what does what\n");
  console.log("## The pipeline\n");
  if (pipeline) {
    console.log(readFileSync(pipeline.file, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim());
  } else {
    console.log("(pipeline skill not found in this install)");
  }
  console.log("\n## Commands\n");
  for (const c of commands) {
    console.log(`  ${c.name().padEnd(18)} ${c.description()}`);
  }
  console.log("\n## Skills\n");
  for (const s of skills) {
    console.log(`  ${s.name.padEnd(18)} ${s.description}`);
    console.log(`  ${" ".repeat(18)} spc use-skill ${s.name}`);
  }
  return 0;
}
